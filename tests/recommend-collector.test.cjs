"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const profile = require("../src/candidate-profile.cjs");
const safety = require("../src/browser/safety.cjs");
const realCollector = require("../src/recommend/collector.cjs");
const { recommendCandidate, recommendResumeDetail, emptyResumeDetail } = require("../fixtures/candidates.cjs");

function candidate(suffix) {
  const raw = {
    geekId: `synthetic-geek-${suffix}`,
    geekCard: {
      encGeekId: `synthetic-encrypted-geek-${suffix}`,
      securityId: `synthetic-security-${suffix}`,
      geekName: `Fixture ${suffix}`,
      geekWorks: [],
      geekEdus: []
    }
  };
  return {
    ...profile.parseGeek(raw), raw,
    ref: { pageScope: "recommend", order: 0, name: `Fixture ${suffix}`, identity: { kind: "dom:data-geekid", value: raw.geekId } },
    context: { jobs: ["synthetic-job"], tabs: ["0"], filters: [] },
    list: { status: "collected", source: "vue_geekList" },
    detail: { status: "not_requested" }
  };
}

function payloadFor(person) {
  return { geekDetail: {
    geekBaseInfo: { geekId: person.listIdentity.geekId[0], name: person.name },
    geekWorkExpList: [], geekEduExpList: [], geekProjExpList: []
  } };
}

function response(payload, overrides = {}) {
  return { ok: true, status: 200, text: JSON.stringify({ code: 0, zpData: payload }), ...overrides };
}

function fixture(options = {}) {
  const a = candidate("a");
  const b = candidate("b");
  const state = {
    evaluations: [], opened: [], closed: 0, monitorStarts: 0, monitorCloses: 0,
    snapshotReads: 0, scrolls: 0, sleeps: [], stopped: null,
    responses: [], snapshots: [[a, b]], captured: payloadFor(a), ...options
  };
  let busy = false;
  const session = {
    assertActive() { if (state.stopped) throw state.stopped; },
    async check() { this.assertActive(); },
    async sleep(ms) {
      this.assertActive();
      state.sleeps.push(ms);
      if (state.onSleep) await state.onSleep(ms, state);
      this.assertActive();
    },
    async evaluate(expression) {
      this.assertActive();
      state.evaluations.push(expression);
      if (state.onEvaluate) await state.onEvaluate(expression, state);
      this.assertActive();
      return state.responses.shift() || response(payloadFor(a));
    },
    async run(callback) {
      this.assertActive();
      if (busy) throw Object.assign(new Error("busy"), { code: "SESSION_BUSY" });
      busy = true;
      try { return await callback(); }
      catch (error) { if (safety.isSafetyStop(error)) state.stopped = error; throw error; }
      finally { busy = false; }
    }
  };
  const page = {
    fail: code => Object.assign(new Error(code), { code }),
    async openCandidate(receivedSession, ref) {
      assert.equal(receivedSession, session);
      session.assertActive();
      state.opened.push(ref.identity.value);
      if (state.openError) throw state.openError;
      return { detail: { signalNodeId: 12, docNodeId: 3 } };
    },
    async closeDetail() {
      session.assertActive();
      state.closed++;
      if (state.closeError) throw Object.assign(new Error("close failed"), { code: "DETAIL_CLOSE_UNCONFIRMED" });
      return { closed: true };
    },
    async scrollList() { session.assertActive(); state.scrolls++; return { changed: true }; }
  };
  class ResponseMonitor {
    async start() { session.assertActive(); state.monitorStarts++; return this; }
    mark() { return state.scrolls; }
    async flush() { session.assertActive(); if (state.monitorError) throw state.monitorError; }
    findDetail() { return state.captured ? { payload: state.captured } : null; }
    async close() { state.monitorCloses++; }
  }
  const snapshot = {
    cardKey: ref => `${ref.pageScope}:${ref.identity.kind}:${ref.identity.value}`,
    async assertCandidateContext(receivedSession, person) {
      assert.equal(receivedSession, session);
      session.assertActive();
      if (!person?.ref?.identity?.value) throw page.fail("CANDIDATE_ID_REQUIRED");
      if (state.contextError) throw page.fail("CANDIDATE_CONTEXT_CHANGED");
    },
    async readSnapshot() {
      session.assertActive();
      const people = state.snapshots[Math.min(state.snapshotReads++, state.snapshots.length - 1)];
      return { pageScope: "recommend", context: a.context, candidates: structuredClone(people) };
    }
  };
  const filename = path.resolve(__dirname, "../src/recommend/collector.cjs");
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, URL, URLSearchParams, structuredClone,
    require(request) {
      if (request === "./page.cjs") return page;
      if (request === "./snapshot.cjs") return snapshot;
      if (request === "./network.cjs") return { ResponseMonitor, DETAIL_PATH: "/wapi/zpitem/web/boss/search/geek/info" };
      return realRequire(request);
    }
  }, { filename });
  return { a, b, state, session, collector: module.exports };
}

test("detail sections distinguish absent, explicitly empty and populated arrays", () => {
  assert.deepEqual(realCollector.detailSections(emptyResumeDetail), { work: "empty", education: "empty", projects: "empty" });
  assert.deepEqual(realCollector.detailSections({ geekDetail: { geekWorkExpList: null, geekEduExpList: [], projectList: [{ name: "Synthetic" }] } }), { work: "missing", education: "empty", projects: "present" });
  assert.deepEqual(realCollector.detailSections({ geekDetail: { geekWorkExpList: [], workList: [{ company: "Synthetic" }] } }), { work: "present", education: "missing", projects: "missing" });
});

test("merging detail preserves list data and does not mutate its input", () => {
  const list = { ...profile.parseGeek(recommendCandidate), raw: structuredClone(recommendCandidate), detail: { status: "not_requested" } };
  const original = structuredClone(list);
  const merged = realCollector.mergeDetail(list, { payload: recommendResumeDetail, source: "api_detail_fetch" });
  assert.deepEqual(list, original);
  assert.deepEqual(merged.raw, recommendCandidate);
  assert.equal(merged.detail.status, "collected");
  assert.equal(merged.detail.sections.work, "present");
  assert.ok(merged.profile.workHistory.some(work => work.company === "Fixture Internship"));
  assert.ok(merged.profile.workHistory.some(work => work.company === "Fixture Previous Company"));
});

test("direct detail fetch validates the request identity and distinguishes failed data", async () => {
  const f = fixture();
  f.state.responses = [response(payloadFor(f.b))];
  assert.equal((await f.collector.fetchDetail(f.session, f.a)).reason, "CANDIDATE_IDENTITY_MISMATCH");
  f.state.responses = [response({}, { ok: false, status: 503 })];
  assert.equal((await f.collector.fetchDetail(f.session, f.a)).reason, "DETAIL_HTTP_503");
  f.state.responses = [response({}, { text: "not-json" })];
  assert.equal((await f.collector.fetchDetail(f.session, f.a)).reason, "DETAIL_JSON_INVALID");
  f.state.responses = [response({ unrelated: true })];
  assert.equal((await f.collector.fetchDetail(f.session, f.a)).reason, "DETAIL_PAYLOAD_INVALID");
  assert.ok(f.state.evaluations.every(expression => expression.includes("securityId=synthetic-security-a")));
});

test("a missing securityId does not send a detail request using another long identifier", async () => {
  const f = fixture();
  const person = profile.parseGeek({ geekCard: { encGeekId: "synthetic-geek-" + "x".repeat(90) } });
  const result = await f.collector.fetchDetail(f.session, person);
  assert.equal(result.reason, "SECURITY_ID_MISSING");
  assert.equal(f.state.evaluations.length, 0);
});

test("an empty valid detail is collected while HTTP failure remains failed", async () => {
  const f = fixture();
  f.state.responses = [response(emptyResumeDetail), response({}, { ok: false, status: 503 })];
  const empty = await f.collector.getCandidateDetail(f.session, f.a, { method: "api" });
  assert.equal(empty.detail.status, "collected");
  assert.equal(empty.detail.sections.work, "empty");
  const failed = await f.collector.getCandidateDetail(f.session, f.a, { method: "api" });
  assert.equal(failed.detail.status, "failed");
  assert.equal(failed.detail.reason, "DETAIL_HTTP_503");
  assert.equal(f.state.opened.length, 0);
});

test("verification, login and rate-limit responses stop the API action", async () => {
  const cases = [
    [response({}, { status: 429, ok: false }), "BOSS_RATE_LIMITED"],
    [response({}, { status: 401, ok: false }), "BOSS_LOGIN_REQUIRED"],
    [response({}, { text: "<!DOCTYPE html><html><body>请完成安全验证</body></html>" }), "BOSS_ANTIBOT_TRIGGERED"],
    [response({}, { text: JSON.stringify({ code: 1, message: "请完成人机验证" }) }), "BOSS_ANTIBOT_TRIGGERED"]
  ];
  for (const [value, code] of cases) {
    const f = fixture({ responses: [value] });
    await assert.rejects(f.collector.getCandidateDetail(f.session, f.a), { code });
    assert.equal(f.state.opened.length, 0);
    assert.equal(f.state.closed, 0);
  }
});

test("explicit page detail reads the captured response and closes once without API fetch", async () => {
  const f = fixture();
  const result = await f.collector.getCandidateDetail(f.session, f.a, { method: "page" });
  assert.equal(result.detail.status, "collected");
  assert.equal(result.detail.source, "network_detail");
  assert.equal(f.state.evaluations.length, 0);
  assert.deepEqual(f.state.opened, [f.a.ref.identity.value]);
  assert.equal(f.state.closed, 1);
  assert.equal(f.state.monitorCloses, 1);
});

test("missing popup response reports failed after closing the popup", async () => {
  const f = fixture({ captured: null, responses: [response({}, { ok: false, status: 503 })] });
  const result = await f.collector.getCandidateDetail(f.session, f.a, { method: "page", timeoutMs: 500 });
  assert.equal(result.detail.status, "failed");
  assert.equal(result.detail.reason, "DETAIL_NOT_CAPTURED");
  assert.equal(f.state.evaluations.length, 0);
  assert.equal(f.state.closed, 1);
  assert.equal(f.state.monitorCloses, 1);
});

test("page detail reports an unconfirmed close instead of returning success", async () => {
  const f = fixture({ closeError: true });
  await assert.rejects(f.collector.getCandidateDetail(f.session, f.a, { method: "page" }), { code: "DETAIL_CLOSE_UNCONFIRMED" });
  assert.equal(f.state.evaluations.length, 0);
  assert.deepEqual(f.state.opened, [f.a.ref.identity.value]);
  assert.equal(f.state.monitorCloses, 1);
});

test("failed detail cleanup keeps both the close failure and original error", async () => {
  const f = fixture({
    closeError: true,
    openError: Object.assign(new Error("synthetic open timeout"), { code: "DETAIL_OPEN_TIMEOUT" })
  });
  await assert.rejects(
    f.collector.getCandidateDetail(f.session, f.a, { method: "page" }),
    error => error.code === "DETAIL_CLOSE_UNCONFIRMED" && error.cause?.code === "DETAIL_OPEN_TIMEOUT"
  );
  assert.equal(f.state.closed, 1);
  assert.equal(f.state.monitorCloses, 1);
});

test("caller cancellation prevents a later explicit request", async () => {
  const f = fixture();
  await f.collector.getCandidateDetail(f.session, f.a);
  f.state.stopped = Object.assign(new Error("aborted"), { code: "ABORTED" });
  await assert.rejects(f.collector.getCandidateDetail(f.session, f.b), { code: "ABORTED" });
  assert.equal(f.state.evaluations.length, 1);
  assert.equal(f.state.opened.length, 0);
  assert.equal(f.state.monitorStarts, 0);
});

test("a safety stop during page monitoring issues no close input", async () => {
  const f = fixture({
    responses: [response({}, { ok: false, status: 503 })],
    monitorError: new safety.BossSafetyError("BOSS_ANTIBOT_TRIGGERED", "synthetic verification")
  });
  await assert.rejects(f.collector.getCandidateDetail(f.session, f.a, { method: "page" }), { code: "BOSS_ANTIBOT_TRIGGERED" });
  assert.equal(f.state.evaluations.length, 0);
  assert.equal(f.state.closed, 0);
  assert.equal(f.state.monitorCloses, 1);
});

test("reading and scrolling are independent actions without an implicit batch", async () => {
  const f = fixture();
  f.state.snapshots = [[f.a], [f.a, f.b]];
  const first = await f.collector.readCandidates(f.session);
  assert.equal(first.candidates.length, 1);
  assert.equal(f.state.scrolls, 0);
  await f.collector.scrollCandidates(f.session);
  const result = await f.collector.readCandidates(f.session);
  assert.deepEqual(Array.from(result.candidates, item => item.ref.identity.value), [f.a.ref.identity.value, f.b.ref.identity.value]);
  assert.equal(f.state.scrolls, 1);
  assert.equal(f.state.evaluations.length, 0);
  assert.equal(f.state.monitorStarts, 0);
});

test("page detail checks current context while API detail can use a detached record", async () => {
  const f = fixture({ contextError: true });
  for (const invalid of [null, undefined, [], "candidate"]) {
    await assert.rejects(f.collector.getCandidateDetail(f.session, invalid), { name: "TypeError", message: "candidate must be an object" });
  }
  for (const options of [{ method: "auto" }, { timeoutMs: 0 }, { intervalMs: 0 }]) {
    await assert.rejects(f.collector.getCandidateDetail(f.session, f.a, options));
  }
  await assert.rejects(f.collector.getCandidateDetail(f.session, f.a, { method: "page" }), { code: "CANDIDATE_CONTEXT_CHANGED" });
  assert.equal(f.state.monitorStarts, 0);
  assert.equal(f.state.evaluations.length, 0);
  assert.equal(f.state.opened.length, 0);
  delete f.a.ref;
  const result = await f.collector.getCandidateDetail(f.session, f.a, { method: "api", timeoutMs: 2000 });
  assert.equal(result.detail.status, "collected");
  assert.match(f.state.evaluations[0], /, 2000\)$/);
});
