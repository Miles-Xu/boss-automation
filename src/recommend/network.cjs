"use strict";
const { checkDetailResponse } = require("../browser/safety.cjs");
const { hasResumeDetailPayload, resumeDetailIdentityMatches } = require("../candidate-profile.cjs");

const LIST_PATHS = new Set(["/wapi/zpjob/rec/geek/list", "/wapi/zpitem/web/refinedGeek/list"]);
const DETAIL_PATH = "/wapi/zpitem/web/boss/search/geek/info";

function requestKind(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
      || !["www.zhipin.com", "zhipin.com"].includes(url.hostname)) return null;
    if (LIST_PATHS.has(url.pathname)) return { kind: "list", url };
    if (url.pathname === DETAIL_PATH) return { kind: "detail", url };
  } catch {}
  return null;
}

class ResponseMonitor {
  constructor(session, { maxEntries = 200, kinds = ["list", "detail"] } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive integer");
    this.session = session;
    this.maxEntries = maxEntries;
    this.kinds = new Set(kinds);
    this.waiters = new Set();
    this.requests = new Map();
    this.lists = [];
    this.details = [];
    this.pending = new Set();
    this.listeners = [];
    this.failure = null;
    this.active = false;
    this.sequence = 0;
    this.latestDetailSequence = 0;
  }

  async start() {
    this.session.assertActive();
    if (this.active) return this;
    this.active = true;
    this.unregister = this.session.addCleanup?.(() => this.close());
    const listen = (name, fn) => {
      this.session.client.on(name, fn);
      this.listeners.push([name, fn]);
    };
    listen("Network.requestWillBeSent", (event) => this.request(event));
    listen("Network.responseReceived", (event) => {
      const record = this.requests.get(event.requestId);
      if (record) {
        record.status = event.response?.status;
        record.url = event.response?.url || record.url;
        try { checkDetailResponse({ status: record.status, url: record.url }); }
        catch (error) { this.recordFailure(error); }
      }
    });
    listen("Network.loadingFailed", (event) => this.requests.delete(event.requestId));
    listen("Network.loadingFinished", (event) => {
      if (!this.active || !this.requests.has(event.requestId)) return;
      const promise = this.finish(event.requestId).catch((error) => { if (this.active) this.recordFailure(error); });
      this.pending.add(promise);
      promise.finally(() => this.pending.delete(promise));
    });
    try {
      await this.session.client.Network.enable();
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  request(event) {
    if (!this.active) return;
    if (this.requests.has(event.requestId) && event.redirectResponse) {
      try { checkDetailResponse({ status: event.redirectResponse.status, url: event.request?.url }); }
      catch (error) { this.recordFailure(error); }
    }
    // Redirected requests must not inherit the preceding response's identity.
    this.requests.delete(event.requestId);
    const match = requestKind(event.request?.url);
    if (!match || !this.kinds.has(match.kind) || event.request?.method !== "GET") return;
    const securityId = match.url.searchParams.get("securityId") || "";
    if (match.kind === "detail" && !securityId) return;
    this.requests.set(event.requestId, {
      kind: match.kind,
      requestId: event.requestId,
      securityId,
      path: match.url.pathname,
      url: match.url.href,
      params: Object.fromEntries(match.url.searchParams),
      sequence: ++this.sequence,
      status: null
    });
    if (match.kind === "detail") this.latestDetailSequence = this.sequence;
    while (this.requests.size > this.maxEntries) this.requests.delete(this.requests.keys().next().value);
  }

  async finish(requestId) {
    const record = this.requests.get(requestId);
    this.requests.delete(requestId);
    if (!record) return;
    this.session.assertActive();
    checkDetailResponse({ status: record.status, url: record.url });
    let result;
    try { result = await this.session.client.Network.getResponseBody({ requestId }); }
    catch (error) {
      this.session.assertActive();
      if (/No resource with given identifier found|No data found for resource with given identifier/.test(error?.message || "")) return;
      throw error;
    }
    if (!this.active) return;
    this.session.assertActive();
    const text = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
    checkDetailResponse({ status: record.status, text, url: record.url });
    if (record.status !== 200) return;
    let parsed;
    try { parsed = JSON.parse(text); } catch { return; }
    checkDetailResponse({ status: record.status, text, url: record.url }, parsed);
    if (parsed?.code != null && String(parsed.code) !== "0") return;
    const payload = parsed?.zpData || parsed?.data || parsed;
    const entry = { ...record, payload };
    if (record.kind === "detail") {
      if (!hasResumeDetailPayload(payload)) return;
      this.details.push(entry);
      this.details.sort((a, b) => a.sequence - b.sequence);
      this.details = this.details.slice(-this.maxEntries);
    } else {
      if (!Array.isArray(payload?.geekList) && !Array.isArray(payload?.geeks)) return;
      this.lists.push(entry);
      this.lists.sort((a, b) => a.sequence - b.sequence);
      this.lists = this.lists.slice(-this.maxEntries);
    }
  }

  recordFailure(error) {
    this.failure ||= error;
    this.session.stopOnSafetyError?.(error);
    for (const cancel of [...this.waiters]) cancel();
  }

  throwIfFailed() {
    this.session.assertActive();
    if (this.failure) throw this.failure;
  }

  mark() { return this.sequence; }

  findDetail(candidate, after = 0) {
    this.throwIfFailed();
    return this.details.findLast((entry) => entry.sequence > after
      && entry.sequence === this.latestDetailSequence
      && resumeDetailIdentityMatches(candidate, entry.payload, entry.securityId)) || null;
  }

  async flush({ timeoutMs = 5000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) throw new RangeError("Invalid response body timeout");
    this.throwIfFailed();
    if (this.pending.size) {
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.waiters.delete(cancel);
          this.session.signal?.removeEventListener("abort", cancel);
          if (error) reject(error); else resolve();
        };
        const cancel = () => {
          try { this.session.assertActive(); }
          catch (error) { finish(error); return; }
          finish(this.failure || Object.assign(new Error("Response monitor closed"), { code: "CAPTURE_CLOSED" }));
        };
        const timer = setTimeout(() => finish(Object.assign(new Error("Response body timed out"), { code: "NETWORK_BODY_TIMEOUT" })), timeoutMs);
        this.waiters.add(cancel);
        this.session.signal?.addEventListener("abort", cancel, { once: true });
        Promise.all([...this.pending]).then(() => finish(), finish);
      });
    }
    this.throwIfFailed();
  }

  async close() {
    this.active = false;
    for (const cancel of [...this.waiters]) cancel();
    this.unregister?.();
    this.unregister = null;
    for (const [name, listener] of this.listeners) this.session.client.removeListener(name, listener);
    this.listeners = [];
    // Late bodies are ignored. Draining here would block session.close() from
    // closing the transport that an outstanding CDP call is waiting on.
    this.pending.clear();
    this.requests.clear();
    this.lists = [];
    this.details = [];
  }
}

module.exports = { ResponseMonitor, requestKind, LIST_PATHS, DETAIL_PATH };
