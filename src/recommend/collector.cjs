"use strict";
const page = require("./page.cjs");
const { ResponseMonitor, DETAIL_PATH } = require("./network.cjs");
const { readSnapshot, assertCandidateContext } = require("./snapshot.cjs");
const { checkDetailResponse, isSafetyStop } = require("../browser/safety.cjs");
const { getCandidateSecurityId, hasResumeDetailPayload, resumeDetailIdentityMatches, applyResumeDetailToCandidate,
  getCandidateInfoFromResumePayload, detailRootFromResumePayload } = require("../candidate-profile.cjs");

async function fetchDetailInPage(url, timeoutMs) {
  const frame = [...document.querySelectorAll("iframe")].find(item => new URL(item.src, location.href).pathname.includes("/frame/recommend"));
  if (!frame?.contentWindow) return { ok: false, status: 0 };
  const win = frame.contentWindow;
  const controller = new win.AbortController();
  const timer = win.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await win.fetch(url, { credentials: "include", signal: controller.signal });
    return { ok: response.ok, status: response.status, url: response.url, text: await response.text() };
  } catch {
    return { ok: false, status: 0, reason: controller.signal.aborted ? "DETAIL_REQUEST_TIMEOUT" : "DETAIL_REQUEST_FAILED" };
  } finally { win.clearTimeout(timer); }
}

function validateTiming(timeoutMs, intervalMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new RangeError("timeoutMs must be 1..2147483647");
  if (!Number.isFinite(intervalMs) || intervalMs < 1 || intervalMs > 2147483647) throw new RangeError("intervalMs must be 1..2147483647");
}

async function fetchDetail(session, candidate, { timeoutMs = 10000 } = {}) {
  validateTiming(timeoutMs, 1);
  const securityId = getCandidateSecurityId(candidate);
  if (!securityId) return { ok: false, reason: "SECURITY_ID_MISSING" };
  await session.check();
  const params = new URLSearchParams({ securityId, segs: "", encryptGeekDetailGray: "1" });
  if (candidate.lid) params.set("lid", candidate.lid);
  const response = await session.evaluate(`(${fetchDetailInPage.toString()})(${JSON.stringify(`${DETAIL_PATH}?${params}`)}, ${timeoutMs})`);
  checkDetailResponse(response);
  await session.check();
  if (!response?.ok) return { ok: false, reason: response?.reason || `DETAIL_HTTP_${response?.status || 0}` };
  let parsed;
  try { parsed = JSON.parse(response.text); } catch { return { ok: false, reason: "DETAIL_JSON_INVALID" }; }
  checkDetailResponse(response, parsed);
  if (parsed?.code != null && String(parsed.code) !== "0") return { ok: false, reason: "DETAIL_BUSINESS_ERROR", platformCode: parsed.code };
  const payload = parsed?.zpData || parsed?.data || parsed;
  if (!hasResumeDetailPayload(payload)) return { ok: false, reason: "DETAIL_PAYLOAD_INVALID" };
  if (!resumeDetailIdentityMatches(candidate, payload, securityId)) return { ok: false, reason: "CANDIDATE_IDENTITY_MISMATCH" };
  return { ok: true, payload, source: "api_detail_fetch" };
}

function terminal(error) {
  return isSafetyStop(error) || ["ABORTED", "BROWSER_DISCONNECTED", "BROWSER_LEASE_LOST", "SESSION_CLOSED"].includes(error?.code);
}

// Internal action precondition. Success leaves the verified detail open.
async function ensureOpenDetail(session, candidate, { timeoutMs = 10000, intervalMs = 250 } = {}) {
  validateTiming(timeoutMs, intervalMs);
  await assertCandidateContext(session, candidate);
  const monitor = await new ResponseMonitor(session, { kinds: ["detail"] }).start();
  let attemptedOpen = false;
  const deadline = Date.now() + timeoutMs;
  try {
    const after = monitor.mark();
    attemptedOpen = true;
    const opened = await page.openCandidate(session, candidate.ref, { timeoutMs, intervalMs });
    for (let attempt = 0; attempt <= Math.ceil(timeoutMs / intervalMs); attempt++) {
      await session.check();
      await monitor.flush({ timeoutMs: Math.max(0, deadline - Date.now()) });
      const entry = monitor.findDetail(candidate, after);
      if (entry) return { identityVerified: true, candidate, context: opened.detail, payload: entry.payload,
        source: "network_detail", requestId: entry.requestId, requestSecurityId: entry.securityId };
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await session.sleep(Math.min(intervalMs, remaining));
    }
    throw page.fail("DETAIL_NOT_CAPTURED");
  } catch (error) {
    // A failed open may have displayed a popup before timing out.
    if (attemptedOpen && error?.code !== "DETAIL_ALREADY_OPEN" && !terminal(error)) {
      try { await page.closeDetail(session); }
      catch (cleanupError) {
        cleanupError.cause ||= error;
        throw cleanupError;
      }
    }
    throw error;
  } finally { await monitor.close(); }
}

function detailSections(payload) {
  const root = detailRootFromResumePayload(payload);
  const sections = {};
  for (const [name, keys] of Object.entries({
    work: ["geekWorkExpList", "geekWorkList", "workExpList", "workList"],
    education: ["geekEduExpList", "geekEducationList", "educationList", "eduExpList"],
    projects: ["geekProjExpList", "geekProjectList", "projectExpList", "projectList", "projects"]
  })) {
    const arrays = keys.filter(key => Array.isArray(root[key]));
    sections[name] = arrays.length ? (arrays.some(key => root[key].length) ? "present" : "empty") : "missing";
  }
  return sections;
}

function mergeDetail(candidate, acquired) {
  const result = structuredClone(candidate);
  applyResumeDetailToCandidate(result, { ...acquired, candidateInfo: getCandidateInfoFromResumePayload(acquired.payload) });
  result.detail = { status: "collected", source: acquired.source, sections: detailSections(acquired.payload) };
  return result;
}

async function getCandidateDetail(session, candidate, { method = "api", timeoutMs = 10000, intervalMs = 250 } = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new TypeError("candidate must be an object");
  if (!["api", "page"].includes(method)) throw new TypeError("method must be api or page");
  validateTiming(timeoutMs, intervalMs);
  return session.run(async () => {
    if (method === "api") {
      const detail = await fetchDetail(session, candidate, { timeoutMs });
      if (detail.ok) return mergeDetail(candidate, detail);
      return { ...structuredClone(candidate), detail: { status: "failed", method, reason: detail.reason } };
    }
    let opened = false;
    try {
      const detail = await ensureOpenDetail(session, candidate, { timeoutMs, intervalMs });
      opened = true;
      return mergeDetail(candidate, detail);
    } catch (error) {
      if (error?.code !== "DETAIL_NOT_CAPTURED") throw error;
      return { ...structuredClone(candidate), detail: { status: "failed", method, reason: error.code } };
    } finally {
      if (opened) await page.closeDetail(session);
    }
  });
}

async function readCandidates(session) {
  return session.run(() => readSnapshot(session));
}

async function scrollCandidates(session, options) {
  return session.run(() => page.scrollList(session, options));
}

module.exports = { readCandidates, scrollCandidates, getCandidateDetail, ensureOpenDetail, fetchDetail, detailSections, mergeDetail };
