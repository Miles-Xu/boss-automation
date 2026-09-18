"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const dom = require("../src/browser/dom.cjs");
const page = require("../src/recommend/page.cjs");

function actionFixture(options = {}) {
  const state = { favorite: false, greeted: false, releases: 0, presses: 0, opens: 0, closed: 0, detail: false, ackWait: 0, ...options };
  const candidate = {
    name: "合成人选", securityId: "synthetic-security-a",
    ref: { pageScope: "recommend", name: "合成人选", identity: { kind: "dom:data-geekid", value: "synthetic-geek-a" } },
    context: { jobs: ["synthetic-job"], jobLabel: ["测试岗位"], tabs: ["0"], filters: [] },
    list: { status: "collected" },
    raw: { geekCard: { geekName: "合成人选", encryptGeekId: "synthetic-geek-a", securityId: "synthetic-security-a" } }
  };
  const client = new EventEmitter();
  client.DOM = {
    getDocument: async () => ({ root: { nodeId: 1 } }),
    describeNode: async ({ nodeId }) => nodeId === 2 ? { node: { contentDocument: { nodeId: 3 } } } : { node: { backendNodeId: state.backendChanged ? 501 : 500 } },
    querySelector: async ({ nodeId, selector }) => {
      if (nodeId === 1 && selector === 'iframe[name="recommendFrame"]') return { nodeId: 2 };
      if (nodeId === 60 && selector === ".like-icon.like-icon-active" && state.favorite) return { nodeId: 62 };
      return { nodeId: 0 };
    },
    querySelectorAll: async ({ nodeId, selector }) => {
      if (nodeId === 3 && selector === "li.tab-item[data-status]") return { nodeIds: [10] };
      if (nodeId === 50 && !state.canvasOnly) {
        if (selector === ".like-icon-and-text" || selector === "button.btn-v2.btn-sure-v2.btn-greet") return { nodeIds: state.ambiguous ? [60, 61] : [60] };
      }
      if (nodeId === 1 && selector === ".ui-dialog" && state.quota) return { nodeIds: [70] };
      return { nodeIds: [] };
    },
    getAttributes: async ({ nodeId }) => {
      if (nodeId === 10) return { attributes: ["data-status", state.scopeChanged ? "3" : "0", "class", "tab-item curr"] };
      if (nodeId === 60 && state.disabled) return { attributes: ["disabled", ""] };
      return { attributes: [] };
    },
    getOuterHTML: async ({ nodeId }) => ({ outerHTML: `<span>${nodeId === 70 ? "今日沟通次数已用完" : state.action === "greet" ? state.greeted ? "继续沟通" : "打招呼" : state.favorite ? "已收藏" : "收藏"}</span>` }),
    getBoxModel: async ({ nodeId }) => {
      if (state.disappeared && nodeId === 50) throw new Error("Could not compute box model");
      return { model: { border: [nodeId * 10, 0, nodeId * 10 + 10, 0, nodeId * 10 + 10, 10, nodeId * 10, 10] } };
    },
    scrollIntoViewIfNeeded: async () => {}
  };
  client.Input = {
    dispatchMouseEvent: async event => {
      if (event.type === "mousePressed") {
        state.presses++;
        if (state.pressError) throw new Error("Connection interrupted");
      }
      if (event.type === "mouseReleased") {
        state.releases++;
        if (state.abortOnRelease) state.aborted = true;
        else if (state.disappearOnRelease) state.disappeared = true;
        else if (!state.noAck) { if (state.action === "greet") state.greeted = true; else state.favorite = true; }
      }
    }
  };
  let busy = false;
  const session = {
    client,
    assertActive() { if (state.aborted) throw Object.assign(new Error("ABORTED"), { code: "ABORTED" }); },
    async check() { this.assertActive(); },
    async sleep(ms) {
      this.assertActive();
      if (state.releases) {
        state.ackWait += ms;
        if (state.ackAfterMs && state.ackWait >= state.ackAfterMs) {
          if (state.action === "greet") state.greeted = true; else state.favorite = true;
        }
      }
      if (ms === 60 && state.presses === 0) {
        if (state.changeOnMove) client.emit("Network.requestWillBeSent", { request: { url: "https://www.zhipin.com/wapi/zpitem/web/boss/search/geek/info?securityId=synthetic-other" } });
        if (state.favoriteOnMove) state.favorite = true;
      }
    },
    async run(fn) {
      if (busy) throw Object.assign(new Error("SESSION_BUSY"), { code: "SESSION_BUSY" });
      busy = true;
      try { return await fn(); } finally { busy = false; }
    }
  };
  dom.bindSessionClient(client, session);
  const localPage = {
    ...page,
    async closeDetail() {
      state.closed++;
      if (state.closeError) throw page.fail("DETAIL_CLOSE_UNCONFIRMED");
      state.detail = false;
      return { closed: true };
    }
  };
  const collector = {
    async ensureOpenDetail(receivedSession, receivedCandidate, timing) {
      state.detailTiming = timing;
      assert.equal(receivedSession, session);
      assert.equal(receivedCandidate, candidate);
      if (state.identityError) throw page.fail("DETAIL_IDENTITY_MISMATCH");
      state.opens++;
      state.detail = true;
      client.emit("Network.requestWillBeSent", { requestId: "synthetic-request-a", request: { url: "https://www.zhipin.com/wapi/zpitem/web/boss/search/geek/info?securityId=synthetic-security-a" } });
      client.emit("Network.loadingFinished", { requestId: "synthetic-request-a" });
      if (state.lateOtherRequest) client.emit("Network.requestWillBeSent", { requestId: "synthetic-request-b", request: { url: "https://www.zhipin.com/wapi/zpitem/web/boss/search/geek/info?securityId=synthetic-security-b" } });
      if (state.navigationAfterFinish) client.emit("Page.frameNavigated", { frame: { id: "synthetic-frame" } });
      return {
        identityVerified: true, candidate, context: { scope: "top", docNodeId: 1, signalNodeId: 50 }, source: "network_detail",
        requestId: "synthetic-request-a", requestSecurityId: "synthetic-security-a",
        payload: { geekBaseInfo: { name: "合成人选", encryptGeekId: state.payloadWrong ? "synthetic-geek-b" : "synthetic-geek-a" } }
      };
    }
  };
  const filename = path.resolve(__dirname, "../src/recommend/actions.cjs");
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module,
    URL,
    require(request) {
      if (request === "./collector.cjs") return collector;
      if (request === "./page.cjs") return localPage;
      return realRequire(request);
    }
  }, { filename });
  return { state, candidate, session, actions: module.exports };
}

test("favorite is clicked once and confirmed by an explicit saved state", async () => {
  const { state, candidate, session, actions } = actionFixture();
  const result = await actions.favoriteCandidate(session, candidate);
  assert.equal(result.status, "performed");
  assert.equal(result.evidence, "已收藏");
  assert.equal(state.releases, 1);
  assert.equal(state.closed, 1);
  assert.equal(session.client.listenerCount("Network.requestWillBeSent"), 0);
  assert.equal(session.client.listenerCount("Page.frameNavigated"), 0);
});

test("action acknowledgement and detail waits can be configured without repeating the click", async () => {
  const { state, candidate, session, actions } = actionFixture({ noAck: true, ackAfterMs: 4500 });
  const result = await actions.favoriteCandidate(session, candidate, { timeoutMs: 5000, intervalMs: 500, detailTimeoutMs: 15000 });
  assert.equal(result.status, "performed");
  assert.equal(state.presses, 1);
  assert.equal(state.releases, 1);
  assert.equal(state.detailTiming.timeoutMs, 15000);
  assert.equal(state.ackWait, 4500);
});

test("invalid action timing is rejected before opening a person", async () => {
  const { state, candidate, session, actions } = actionFixture();
  for (const timing of [{ timeoutMs: 0 }, { intervalMs: NaN }, { detailTimeoutMs: Infinity }]) {
    await assert.rejects(actions.favoriteCandidate(session, candidate, timing), { name: "RangeError" });
  }
  assert.equal(state.opens, 0);
  assert.equal(state.presses, 0);
});

test("already favorite never toggles the saved candidate off", async () => {
  const { state, candidate, session, actions } = actionFixture({ favorite: true });
  assert.equal((await actions.favoriteCandidate(session, candidate)).status, "already_done");
  assert.equal(state.presses, 0);
  assert.equal(state.favorite, true);
  assert.equal(state.closed, 1);
  assert.equal(state.detail, false);
});

test("favorite becoming active immediately before press is re-read", async () => {
  const { state, candidate, session, actions } = actionFixture({ favoriteOnMove: true });
  assert.equal((await actions.favoriteCandidate(session, candidate)).status, "already_done");
  assert.equal(state.presses, 0);
});

test("canvas-only action controls are unsupported and never guessed", async () => {
  const { state, candidate, session, actions } = actionFixture({ canvasOnly: true });
  assert.equal((await actions.favoriteCandidate(session, candidate)).status, "unsupported");
  assert.equal(state.presses, 0);
  assert.equal(state.closed, 1);
});

test("two matching controls are ambiguous and never clicked", async () => {
  const { state, candidate, session, actions } = actionFixture({ ambiguous: true });
  const result = await actions.favoriteCandidate(session, candidate);
  assert.equal(result.reason, "ACTION_CONTROL_AMBIGUOUS");
  assert.equal(state.presses, 0);
});

test("a fresh detail response for someone else invalidates the click binding", async () => {
  const { state, candidate, session, actions } = actionFixture({ changeOnMove: true });
  await assert.rejects(actions.favoriteCandidate(session, candidate), { code: "CANDIDATE_DETAIL_CHANGED" });
  assert.equal(state.presses, 0);
});

test("identity rejection never issues a button click", async () => {
  const { state, candidate, session, actions } = actionFixture({ identityError: true });
  await assert.rejects(actions.favoriteCandidate(session, candidate), { code: "DETAIL_IDENTITY_MISMATCH" });
  assert.equal(state.presses, 0);
  assert.equal(state.closed, 0);
  assert.equal(session.client.listenerCount("Network.requestWillBeSent"), 0);
});

test("a detail request arriving before the collector returns also invalidates binding", async () => {
  const { state, candidate, session, actions } = actionFixture({ lateOtherRequest: true });
  await assert.rejects(actions.favoriteCandidate(session, candidate), { code: "CANDIDATE_DETAIL_CHANGED" });
  assert.equal(state.presses, 0);
});

test("a frame navigation after the matched response invalidates binding", async () => {
  const { state, candidate, session, actions } = actionFixture({ navigationAfterFinish: true });
  await assert.rejects(actions.favoriteCandidate(session, candidate), { code: "CANDIDATE_DETAIL_CHANGED" });
  assert.equal(state.presses, 0);
});

test("actions independently reject a payload conflicting with the raw list identity", async () => {
  const { state, candidate, session, actions } = actionFixture({ payloadWrong: true });
  await assert.rejects(actions.favoriteCandidate(session, candidate), { code: "DETAIL_IDENTITY_UNVERIFIED" });
  assert.equal(state.presses, 0);
});

test("missing collection context fails before opening a candidate or adding listeners", async () => {
  const { state, candidate, session, actions } = actionFixture();
  delete candidate.context;
  await assert.rejects(actions.favoriteCandidate(session, candidate), { code: "ACTION_CANDIDATE_INVALID" });
  assert.equal(state.opens, 0);
  assert.equal(state.presses, 0);
  assert.equal(session.client.listenerCount("Network.requestWillBeSent"), 0);
});

test("edited securityId is rejected before opening a candidate", async () => {
  const { state, candidate, session, actions } = actionFixture();
  candidate.securityId = "synthetic-security-b";
  await assert.rejects(actions.greetCandidate(session, candidate), { code: "ACTION_CANDIDATE_IDENTITY_MISMATCH" });
  assert.equal(state.opens, 0);
  assert.equal(state.presses, 0);
});

test("missing success acknowledgement returns unconfirmed without retrying", async () => {
  const { state, candidate, session, actions } = actionFixture({ noAck: true });
  assert.equal((await actions.favoriteCandidate(session, candidate)).status, "unconfirmed");
  assert.equal(state.releases, 1);
});

test("a press transport failure is unconfirmed and is never retried", async () => {
  const { state, candidate, session, actions } = actionFixture({ pressError: true });
  assert.equal((await actions.favoriteCandidate(session, candidate)).status, "unconfirmed");
  assert.equal(state.presses, 1);
  assert.equal(state.releases, 0);
});

test("greet requires the button to become continue communication", async () => {
  const { state, candidate, session, actions } = actionFixture({ action: "greet" });
  const result = await actions.greetCandidate(session, candidate);
  assert.equal(result.status, "performed");
  assert.equal(result.evidence, "继续沟通");
  assert.equal(state.releases, 1);
});

test("automatic return to list alone never confirms a greeting", async () => {
  const { state, candidate, session, actions } = actionFixture({ action: "greet", disappearOnRelease: true });
  assert.equal((await actions.greetCandidate(session, candidate)).status, "unconfirmed");
  assert.equal(state.releases, 1);
});

test("already contacted candidate is skipped", async () => {
  const { state, candidate, session, actions } = actionFixture({ action: "greet", greeted: true });
  assert.equal((await actions.greetCandidate(session, candidate)).status, "already_done");
  assert.equal(state.presses, 0);
  assert.equal(state.closed, 1);
  assert.equal(state.detail, false);
});

test("quota notice prevents greeting before the click", async () => {
  const { state, candidate, session, actions } = actionFixture({ action: "greet", quota: true });
  await assert.rejects(actions.greetCandidate(session, candidate), { code: "GREET_QUOTA_EXHAUSTED" });
  assert.equal(state.presses, 0);
});

test("close failure stops the caller while retaining the action outcome", async () => {
  const { candidate, session, actions } = actionFixture({ closeError: true });
  await assert.rejects(actions.favoriteCandidate(session, candidate), error => error.code === "DETAIL_CLOSE_UNCONFIRMED" && error.actionResult?.status === "performed");
});

test("cancellation stops further polling or page cleanup input", async () => {
  const { state, candidate, session, actions } = actionFixture({ abortOnRelease: true });
  await assert.rejects(actions.favoriteCandidate(session, candidate), error => error.code === "ABORTED" && error.actionResult?.status === "unconfirmed");
  assert.equal(state.releases, 1);
  assert.equal(state.closed, 0);
});
