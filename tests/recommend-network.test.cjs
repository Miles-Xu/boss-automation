"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { ResponseMonitor, requestKind, DETAIL_PATH } = require("../src/recommend/network.cjs");
const { parseGeek } = require("../src/candidate-profile.cjs");
const fixtures = require("../fixtures/candidates.cjs");

const LIST_URL = "https://www.zhipin.com/wapi/zpjob/rec/geek/list";
const FEATURED_URL = "https://www.zhipin.com/wapi/zpitem/web/refinedGeek/list";
const EVENT_NAMES = ["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFailed", "Network.loadingFinished"];

function detailUrl(securityId) {
  const url = new URL(DETAIL_PATH, "https://www.zhipin.com");
  url.searchParams.set("securityId", securityId);
  return url.href;
}

function mockMonitor(options = {}) {
  const client = new EventEmitter();
  const bodies = new Map();
  const calls = { enable: 0, body: [] };
  let sessionActive = true;
  client.Network = {
    async enable() { calls.enable += 1; },
    async getResponseBody({ requestId }) {
      calls.body.push(requestId);
      const item = bodies.get(requestId);
      if (item instanceof Error) throw item;
      if (item === undefined) throw new Error("No resource with given identifier found");
      return item;
    }
  };
  const session = {
    client,
    assertActive() {
      if (!sessionActive) throw Object.assign(new Error("Synthetic session closed"), { code: "SESSION_CLOSED" });
    }
  };
  const monitor = new ResponseMonitor(session, options);
  return {
    client, monitor, bodies, calls,
    stopSession() { sessionActive = false; },
    request(id, url, method = "GET") {
      client.emit("Network.requestWillBeSent", { requestId: id, request: { url, method } });
    },
    response(id, payload, { status = 200, code = 0, base64 = false, text, bodyError } = {}) {
      const plain = text === undefined ? JSON.stringify({ code, zpData: payload }) : text;
      bodies.set(id, bodyError || { body: base64 ? Buffer.from(plain).toString("base64") : plain, base64Encoded: base64 });
      client.emit("Network.responseReceived", { requestId: id, response: { status } });
      client.emit("Network.loadingFinished", { requestId: id });
    }
  };
}

test("monitor only recognizes the exact BOSS HTTPS endpoints", () => {
  assert.equal(requestKind(LIST_URL).kind, "list");
  assert.equal(requestKind(FEATURED_URL).kind, "list");
  assert.equal(requestKind(detailUrl("synthetic-security")).kind, "detail");
  assert.equal(requestKind(LIST_URL.replace("www.zhipin.com", "zhipin.com")).kind, "list");
  assert.equal(requestKind(LIST_URL.replace("www.zhipin.com", "www.zhipin.com:443")).kind, "list");
  for (const url of [
    LIST_URL.replace("https:", "http:"),
    LIST_URL.replace("www.zhipin.com", "www.zhipin.com.example.invalid"),
    LIST_URL.replace("www.zhipin.com", "example.invalid"),
    LIST_URL.replace("www.zhipin.com", "www.zhipin.com:8443"),
    LIST_URL.replace("www.zhipin.com", "synthetic-user@www.zhipin.com"),
    LIST_URL.replace("www.zhipin.com", "synthetic-user:synthetic-password@www.zhipin.com"),
    LIST_URL + "/extra",
    "not a URL"
  ]) assert.equal(requestKind(url), null, url);
});

test("list responses preserve their source and request marker", async () => {
  const mock = mockMonitor();
  await mock.monitor.start();
  mock.request("recommend-before", LIST_URL);
  const before = mock.monitor.mark();
  mock.response("recommend-before", { geekList: [fixtures.recommendCandidate] });
  mock.request("featured-after", FEATURED_URL);
  mock.response("featured-after", { geeks: [fixtures.featuredCandidate] });
  await mock.monitor.flush();
  assert.deepEqual(mock.monitor.lists.map(entry => entry.path), [new URL(LIST_URL).pathname, new URL(FEATURED_URL).pathname]);
  assert.deepEqual(mock.monitor.lists.filter(entry => entry.sequence > before).map(entry => entry.requestId), ["featured-after"]);
  await mock.monitor.close();
});

test("featured details bind to the request token even when response identifiers change", async () => {
  const mock = mockMonitor();
  await mock.monitor.start();
  const candidate = parseGeek(fixtures.featuredCandidate);
  mock.request("featured-detail", detailUrl(candidate.securityId));
  mock.response("featured-detail", fixtures.featuredResumeDetail, { base64: true });
  await mock.monitor.flush();
  const match = mock.monitor.findDetail(candidate);
  assert.equal(match.requestId, "featured-detail");
  assert.equal(match.securityId, candidate.securityId);
  assert.equal(match.payload.geekDetail.securityId, "synthetic-security-featured-rotated-002");
  assert.equal(mock.monitor.findDetail(candidate, match.sequence), null);
  assert.equal(mock.monitor.findDetail(parseGeek(fixtures.recommendCandidate)), null);
  await mock.monitor.close();
});

test("same-type conflicts and unrelated request tokens cannot attach a detail", async () => {
  const mock = mockMonitor();
  await mock.monitor.start();
  const candidate = parseGeek(fixtures.recommendCandidate);
  const conflict = structuredClone(fixtures.recommendResumeDetail);
  conflict.geekDetail.geekBaseInfo.geekId = "synthetic-conflicting-geek";
  mock.request("conflict", detailUrl(candidate.securityId));
  mock.response("conflict", conflict);
  mock.request("wrong-request", detailUrl("synthetic-unrelated-security"));
  mock.response("wrong-request", fixtures.recommendResumeDetail);
  await mock.monitor.flush();
  assert.equal(mock.monitor.findDetail(candidate), null);
  await mock.monitor.close();
});

test("late responses do not supersede newer requests for the same list or detail", async () => {
  const mock = mockMonitor();
  await mock.monitor.start();
  const candidate = parseGeek(fixtures.recommendCandidate);
  mock.request("old-list", LIST_URL + "?syntheticVersion=old");
  mock.request("new-list", LIST_URL + "?syntheticVersion=new");
  mock.request("old-detail", detailUrl(candidate.securityId));
  mock.request("new-detail", detailUrl(candidate.securityId));
  mock.response("new-list", { geekList: [fixtures.recommendCandidate] });
  mock.response("new-detail", fixtures.recommendResumeDetail);
  await mock.monitor.flush();
  mock.response("old-list", { geekList: [fixtures.recommendCandidate] });
  mock.response("old-detail", fixtures.recommendResumeDetail);
  await mock.monitor.flush();
  assert.equal(mock.monitor.lists.at(-1).requestId, "new-list");
  assert.equal(mock.monitor.findDetail(candidate).requestId, "new-detail");
  await mock.monitor.close();
});

test("evicted response bodies and failed requests do not poison later captures", async () => {
  const mock = mockMonitor();
  await mock.monitor.start();
  mock.request("evicted", LIST_URL);
  mock.response("evicted", {}, { bodyError: new Error("No resource with given identifier found") });
  mock.request("failed", LIST_URL);
  mock.client.emit("Network.loadingFailed", { requestId: "failed", errorText: "net::ERR_ABORTED" });
  await mock.monitor.flush();
  assert.equal(mock.monitor.requests.has("failed"), false);
  assert.equal(mock.monitor.lists.length, 0);
  mock.request("recovered", LIST_URL);
  mock.response("recovered", { geekList: [fixtures.recommendCandidate] });
  await mock.monitor.flush();
  assert.equal(mock.monitor.lists.at(-1).requestId, "recovered");
  await mock.monitor.close();
});

test("HTTP safety stops survive an unavailable response body", async () => {
  for (const [status, code] of [[429, "BOSS_RATE_LIMITED"], [401, "BOSS_LOGIN_REQUIRED"]]) {
    const mock = mockMonitor();
    await mock.monitor.start();
    mock.request("stop", LIST_URL);
    mock.response("stop", {}, { status, bodyError: new Error("No resource with given identifier found") });
    await assert.rejects(mock.monitor.flush(), { code });
    assert.throws(() => mock.monitor.throwIfFailed(), { code });
    await mock.monitor.close();
  }
});

test("tracked detail redirects retain login and verification stops without reading a body", async () => {
  for (const [pathname, code] of [["/web/user/", "BOSS_LOGIN_REQUIRED"], ["/web/common/security-check.html", "BOSS_ANTIBOT_TRIGGERED"]]) {
    const mock = mockMonitor();
    await mock.monitor.start();
    mock.request("redirected-detail", detailUrl(fixtures.recommendCandidate.geekCard.securityId));
    assert.doesNotThrow(() => mock.client.emit("Network.requestWillBeSent", {
      requestId: "redirected-detail",
      redirectResponse: { status: 302 },
      request: { method: "GET", url: `https://www.zhipin.com${pathname}?syntheticToken=not-public-evidence` }
    }));
    mock.client.emit("Network.loadingFailed", { requestId: "redirected-detail" });
    await assert.rejects(mock.monitor.flush(), error => error.code === code && !JSON.stringify(error).includes("not-public-evidence"));
    assert.equal(mock.calls.body.length, 0);
    assert.equal(mock.monitor.details.length, 0);
    await mock.monitor.close();
  }
});

test("rate-limit response headers remain terminal when loading later fails", async () => {
  const mock = mockMonitor();
  await mock.monitor.start();
  mock.request("rate-limited", LIST_URL);
  assert.doesNotThrow(() => mock.client.emit("Network.responseReceived", {
    requestId: "rate-limited", response: { status: 429, url: LIST_URL }
  }));
  mock.client.emit("Network.loadingFailed", { requestId: "rate-limited", errorText: "net::ERR_ABORTED" });
  await assert.rejects(mock.monitor.flush(), { code: "BOSS_RATE_LIMITED" });
  assert.equal(mock.calls.body.length, 0);
  assert.equal(mock.monitor.requests.size, 0);
  await mock.monitor.close();
});

test("verification responses stop capture while malformed and rejected payloads are discarded", async () => {
  const normal = mockMonitor();
  await normal.monitor.start();
  normal.request("malformed", LIST_URL);
  normal.response("malformed", null, { text: "<html>Temporary unavailable</html>" });
  normal.request("rejected", LIST_URL);
  normal.response("rejected", { geekList: [fixtures.recommendCandidate] }, { code: 7 });
  normal.request("wrong-shape", detailUrl(fixtures.recommendCandidate.geekCard.securityId));
  normal.response("wrong-shape", { geekDetail: { geekBaseInfo: [] } });
  await normal.monitor.flush();
  assert.equal(normal.monitor.lists.length, 0);
  assert.equal(normal.monitor.details.length, 0);
  await normal.monitor.close();

  const stopped = mockMonitor();
  await stopped.monitor.start();
  stopped.request("verify", LIST_URL);
  stopped.response("verify", null, { text: JSON.stringify({ code: 5, message: "请完成安全验证" }) });
  await assert.rejects(stopped.monitor.flush(), { code: "BOSS_ANTIBOT_TRIGGERED" });
  await stopped.monitor.close();
});

test("unexpected CDP failures and closed sessions still fail capture", async () => {
  const mock = mockMonitor();
  await mock.monitor.start();
  mock.request("disconnect", LIST_URL);
  mock.response("disconnect", {}, { bodyError: new Error("WebSocket connection closed") });
  await assert.rejects(mock.monitor.flush(), /WebSocket connection closed/);
  await mock.monitor.close();
  const closed = mockMonitor();
  await closed.monitor.start();
  closed.stopSession();
  assert.throws(() => closed.monitor.findDetail(parseGeek(fixtures.recommendCandidate)), { code: "SESSION_CLOSED" });
  await closed.monitor.close();
});

test("redirects, POST requests, and details without request tokens are ignored", async () => {
  const mock = mockMonitor();
  await mock.monitor.start();
  mock.request("redirected", detailUrl(fixtures.recommendCandidate.geekCard.securityId));
  mock.request("redirected", "https://example.invalid/redirected");
  mock.response("redirected", fixtures.recommendResumeDetail);
  mock.request("post", LIST_URL, "POST");
  mock.response("post", { geekList: [fixtures.recommendCandidate] });
  mock.request("missing-token", "https://www.zhipin.com" + DETAIL_PATH);
  mock.response("missing-token", fixtures.recommendResumeDetail);
  await mock.monitor.flush();
  assert.equal(mock.calls.body.length, 0);
  assert.equal(mock.monitor.details.length, 0);
  assert.equal(mock.monitor.lists.length, 0);
  await mock.monitor.close();
});

test("request, list, and detail caches are bounded", async () => {
  const mock = mockMonitor({ maxEntries: 2 });
  await mock.monitor.start();
  for (let index = 0; index < 5; index += 1) mock.request("pending-" + index, LIST_URL);
  assert.ok(mock.monitor.requests.size <= 2);
  for (let index = 0; index < 5; index += 1) {
    mock.request("list-" + index, LIST_URL);
    mock.response("list-" + index, { geekList: [fixtures.recommendCandidate] });
    mock.request("detail-" + index, detailUrl(fixtures.recommendCandidate.geekCard.securityId));
    mock.response("detail-" + index, fixtures.recommendResumeDetail);
    await mock.monitor.flush();
  }
  assert.ok(mock.monitor.requests.size <= 2);
  assert.ok(mock.monitor.lists.length <= 2);
  assert.ok(mock.monitor.details.length <= 2);
  assert.equal(mock.monitor.findDetail(parseGeek(fixtures.recommendCandidate)).requestId, "detail-4");
  await mock.monitor.close();
});

test("start is idempotent and close removes only its own listeners", async () => {
  const mock = mockMonitor();
  const outsideListener = () => {};
  mock.client.on("Network.loadingFinished", outsideListener);
  await mock.monitor.start();
  await mock.monitor.start();
  assert.equal(mock.calls.enable, 1);
  assert.equal(mock.client.listenerCount("Network.requestWillBeSent"), 1);
  assert.equal(mock.client.listenerCount("Network.loadingFinished"), 2);
  await mock.monitor.close();
  for (const event of EVENT_NAMES) assert.equal(mock.client.listenerCount(event), event === "Network.loadingFinished" ? 1 : 0);
  assert.equal(mock.client.listeners("Network.loadingFinished")[0], outsideListener);
  assert.equal(mock.monitor.requests.size, 0);
  assert.equal(mock.monitor.pending.size, 0);
  assert.equal(mock.monitor.details.length, 0);
  assert.equal(mock.monitor.lists.length, 0);
});

test("close detaches immediately and discards late response bodies", async () => {
  const mock = mockMonitor();
  await mock.monitor.start();
  let releaseBody;
  mock.bodies.set("in-flight", new Promise((resolve) => { releaseBody = resolve; }));
  mock.request("in-flight", LIST_URL);
  mock.client.emit("Network.responseReceived", { requestId: "in-flight", response: { status: 200 } });
  mock.client.emit("Network.loadingFinished", { requestId: "in-flight" });
  assert.equal(mock.monitor.pending.size, 1);
  await mock.monitor.close();
  assert.equal(mock.monitor.pending.size, 0);
  for (const event of EVENT_NAMES) assert.equal(mock.client.listenerCount(event), 0);
  releaseBody({ body: JSON.stringify({ code: 0, zpData: { geekList: [fixtures.recommendCandidate] } }), base64Encoded: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mock.monitor.pending.size, 0);
  assert.equal(mock.monitor.lists.length, 0);
  for (const event of EVENT_NAMES) assert.equal(mock.client.listenerCount(event), 0);
});

test("a later detail request invalidates an earlier candidate response before it completes", async () => {
  const mock = mockMonitor();
  await mock.monitor.start();
  const first = parseGeek(fixtures.recommendCandidate);
  mock.request("first-detail", detailUrl(first.securityId));
  mock.response("first-detail", fixtures.recommendResumeDetail);
  await mock.monitor.flush();
  assert.equal(mock.monitor.findDetail(first).requestId, "first-detail");
  mock.request("second-detail", detailUrl(fixtures.featuredCandidate.geekCard.securityId));
  assert.equal(mock.monitor.findDetail(first), null);
  mock.client.emit("Network.loadingFailed", { requestId: "second-detail" });
  assert.equal(mock.monitor.findDetail(first), null);
  await mock.monitor.close();
});

test("Network.enable failure releases every registered listener", async () => {
  const mock = mockMonitor();
  mock.client.Network.enable = async () => { throw new Error("Synthetic Network.enable failure"); };
  await assert.rejects(mock.monitor.start(), /Synthetic Network.enable failure/);
  assert.equal(mock.monitor.active, false);
  for (const event of EVENT_NAMES) assert.equal(mock.client.listenerCount(event), 0);
});

test("waiting for a hung response body has a deadline and can be closed", async () => {
  const mock = mockMonitor();
  await mock.monitor.start();
  mock.client.Network.getResponseBody = () => new Promise(() => {});
  mock.request("hung", LIST_URL);
  mock.response("hung", { geekList: [] });
  await assert.rejects(mock.monitor.flush({ timeoutMs: 5 }), { code: "NETWORK_BODY_TIMEOUT" });
  const waiting = assert.rejects(mock.monitor.flush({ timeoutMs: 60000 }), { code: "CAPTURE_CLOSED" });
  await mock.monitor.close();
  await waiting;
  assert.equal(mock.monitor.waiters.size, 0);
});
