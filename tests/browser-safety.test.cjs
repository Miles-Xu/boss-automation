const test = require("node:test");
const assert = require("node:assert/strict");
const { inspectBossPage, checkDetailResponse } = require("../src/browser/safety.cjs");
const { bindSessionClient } = require("../src/browser/dom.cjs");

function page({ url = "https://www.zhipin.com/web/chat/recommend", child, warning = false, visible = true, broken = false } = {}) {
  const discarded = [];
  const client = {
    Page: { getFrameTree: async () => ({ frameTree: { frame: { url }, childFrames: child ? [{ frame: { url: child } }] : [] } }) },
    DOM: {
      getDocument: async () => { if (broken) throw new Error("sensitive transport message"); },
      performSearch: async () => ({ searchId: "test", resultCount: warning ? 1 : 0 }),
      getSearchResults: async () => ({ nodeIds: [1] }),
      getBoxModel: async () => ({ model: { width: visible ? 10 : 0, height: 10 } }),
      discardSearchResults: async (value) => { discarded.push(value); }
    }
  };
  return { client, discarded };
}

test("page checks distinguish hidden text from visible security verification", async () => {
  const hidden = page({ warning: true, visible: false });
  assert.equal((await inspectBossPage(hidden.client)).detected, false);
  assert.deepEqual(hidden.discarded, [{ searchId: "test" }]);
  const shown = page({ warning: true });
  assert.deepEqual(await inspectBossPage(shown.client), { detected: true, signal: "visible_verification_message" });
  assert.equal(shown.discarded.length, 1);
});

test("page checks detect visible warnings after the first search batch", async () => {
  const f = page();
  const ranges = [];
  f.client.DOM.performSearch = async () => ({ searchId: "test", resultCount: 21 });
  f.client.DOM.getSearchResults = async ({ fromIndex, toIndex }) => {
    ranges.push([fromIndex, toIndex]);
    return { nodeIds: Array.from({ length: toIndex - fromIndex }, (_, index) => fromIndex + index + 1) };
  };
  f.client.DOM.getBoxModel = async ({ nodeId }) => ({ model: { width: nodeId === 21 ? 10 : 0, height: 10 } });
  assert.deepEqual(await inspectBossPage(f.client), { detected: true, signal: "visible_verification_message" });
  assert.deepEqual(ranges, [[0, 20], [20, 21]]);
  assert.deepEqual(f.discarded, [{ searchId: "test" }]);
});

test("page checks inspect every hidden match before returning clear", async () => {
  const f = page({ visible: false });
  const inspected = [];
  f.client.DOM.performSearch = async () => ({ searchId: "test", resultCount: 45 });
  f.client.DOM.getSearchResults = async ({ fromIndex, toIndex }) => ({
    nodeIds: Array.from({ length: toIndex - fromIndex }, (_, index) => fromIndex + index + 1)
  });
  f.client.DOM.getBoxModel = async ({ nodeId }) => {
    inspected.push(nodeId);
    return { model: { width: 0, height: 0 } };
  };
  assert.deepEqual(await inspectBossPage(f.client), { detected: false });
  assert.deepEqual(inspected, Array.from({ length: 45 }, (_, index) => index + 1));
  assert.deepEqual(f.discarded, [{ searchId: "test" }]);
});

test("incomplete or invalid warning search results fail closed and release search handles", async () => {
  for (const nodeIds of [undefined, [], [0], [-1], ["1"], [1, 2]]) {
    const f = page({ warning: true });
    f.client.DOM.getSearchResults = async () => ({ nodeIds });
    await assert.rejects(inspectBossPage(f.client), { code: "BOSS_PAGE_CHECK_FAILED" });
    assert.deepEqual(f.discarded, [{ searchId: "test" }]);
  }
  for (const resultCount of [undefined, -1, 1.5, NaN]) {
    const f = page();
    f.client.DOM.performSearch = async () => ({ searchId: "test", resultCount });
    await assert.rejects(inspectBossPage(f.client), { code: "BOSS_PAGE_CHECK_FAILED" });
    assert.deepEqual(f.discarded, [{ searchId: "test" }]);
  }
});

test("cancelling in a later search batch prevents further visibility calls", async () => {
  const f = page();
  let stopped = false;
  let boxCalls = 0;
  f.client.DOM.performSearch = async () => ({ searchId: "test", resultCount: 21 });
  f.client.DOM.getSearchResults = async ({ fromIndex, toIndex }) => {
    if (fromIndex === 20) stopped = true;
    return { nodeIds: Array.from({ length: toIndex - fromIndex }, (_, index) => fromIndex + index + 1) };
  };
  f.client.DOM.getBoxModel = async () => {
    boxCalls += 1;
    return { model: { width: 0, height: 0 } };
  };
  const assertActive = () => { if (stopped) throw Object.assign(new Error("aborted"), { code: "ABORTED" }); };
  await assert.rejects(inspectBossPage(f.client, { assertActive }), { code: "ABORTED" });
  assert.equal(boxCalls, 20);
  assert.deepEqual(f.discarded, [{ searchId: "test" }]);
});

test("challenge and login frames stop page checks without returning full URLs", async () => {
  const challenge = page({ child: "https://www.zhipin.com/web/common/security-check.html?token=synthetic" });
  assert.deepEqual(await inspectBossPage(challenge.client), { detected: true, signal: "challenge_url" });
  await assert.rejects(inspectBossPage(page({ url: "https://www.zhipin.com/web/user/?token=synthetic" }).client), { code: "BOSS_LOGIN_REQUIRED" });
  await assert.rejects(inspectBossPage(page({ broken: true }).client), (error) => error.code === "BOSS_PAGE_CHECK_FAILED" && !error.message.includes("sensitive"));
});

test("detail response verification and rate limits cannot look like empty data", () => {
  assert.throws(() => checkDetailResponse({ status: 200 }, { message: "请完成安全验证", zpData: null }), { code: "BOSS_ANTIBOT_TRIGGERED", retryable: false });
  assert.throws(() => checkDetailResponse({ status: 429 }, {}), { code: "BOSS_RATE_LIMITED" });
  assert.throws(() => checkDetailResponse({ status: 401 }, {}), { code: "BOSS_LOGIN_REQUIRED" });
  assert.doesNotThrow(() => checkDetailResponse({ status: 200 }, { code: 0, zpData: {} }));
});

test("warning visibility failures stop the check unless Chrome confirms no layout box", async () => {
  for (const error of [new Error("WebSocket closed with synthetic-sensitive-url"), Object.assign(new Error("Could not find node with given id"), { code: -32000 })]) {
    const broken = page({ warning: true });
    broken.client.DOM.getBoxModel = async () => { throw error; };
    await assert.rejects(inspectBossPage(broken.client), (result) => result.code === "BOSS_PAGE_CHECK_FAILED" && !result.message.includes("synthetic-sensitive-url"));
    assert.equal(broken.discarded.length, 1);
  }
  const hidden = page({ warning: true });
  hidden.client.DOM.getBoxModel = async () => { throw Object.assign(new Error("Could not compute box model."), { code: -32000 }); };
  assert.equal((await inspectBossPage(hidden.client)).detected, false);
});

test("verification HTML and final challenge URLs stop before JSON parsing", () => {
  for (const text of ["<!DOCTYPE html><html><body>请完成安全验证</body></html>", "  <html><body>您的账号可能存在异常访问行为</body></html>"]) {
    assert.throws(() => checkDetailResponse({ status: 200, text }), { code: "BOSS_ANTIBOT_TRIGGERED" });
  }
  assert.throws(() => checkDetailResponse({ status: 200, url: "https://www.zhipin.com/web/common/security-check.html?token=synthetic", text: "" }), { code: "BOSS_ANTIBOT_TRIGGERED" });
  assert.throws(() => checkDetailResponse({ status: 200 }, { zpData: { redirectUrl: "/web/common/security-check.html" } }), { code: "BOSS_ANTIBOT_TRIGGERED" });
});

test("login redirects are recognized without inventing platform error codes", () => {
  assert.throws(() => checkDetailResponse({ status: 200, url: "https://www.zhipin.com/web/user/?token=synthetic", text: "<html></html>" }), { code: "BOSS_LOGIN_REQUIRED" });
  assert.throws(() => checkDetailResponse({ status: 200 }, { zpData: { redirectUrl: "/web/user/" } }), { code: "BOSS_LOGIN_REQUIRED" });
  assert.doesNotThrow(() => checkDetailResponse({ status: 200 }, { code: 999999, zpData: {} }));
});

test("candidate JSON and plain text mentioning verification do not trigger HTML detection", () => {
  const parsed = { code: 0, zpData: { geekInfo: { advantage: "开发过请完成安全验证提示组件，文档示例 <html>请完成人机验证</html>" } } };
  assert.doesNotThrow(() => checkDetailResponse({ status: 200, text: JSON.stringify(parsed) }));
  assert.doesNotThrow(() => checkDetailResponse({ status: 200, text: JSON.stringify(parsed) }, parsed));
  assert.doesNotThrow(() => checkDetailResponse({ status: 200, text: "完成验证后即可正常使用" }));
  assert.doesNotThrow(() => checkDetailResponse({ status: 200, url: "https://other.invalid/web/user/", text: "<html><body>unrelated</body></html>" }));
});

test("a bound session cancels between visibility calls and still discards search results", async () => {
  const f = page({ warning: true });
  let stopped = false;
  let boxCalls = 0;
  bindSessionClient(f.client, { assertActive() { if (stopped) throw Object.assign(new Error("aborted"), { code: "ABORTED" }); } });
  f.client.DOM.performSearch = async () => ({ searchId: "test", resultCount: 2 });
  f.client.DOM.getSearchResults = async () => ({ nodeIds: [1, 2] });
  f.client.DOM.getBoxModel = async () => {
    boxCalls += 1;
    stopped = true;
    return { model: { width: 0, height: 0 } };
  };
  await assert.rejects(inspectBossPage(f.client), { code: "ABORTED" });
  assert.equal(boxCalls, 1);
  assert.equal(f.discarded.length, 1);
});

test("abort after search creation still frees the returned search handle", async () => {
  const f = page();
  let stopped = false;
  f.client.DOM.performSearch = async () => { stopped = true; return { searchId: "created", resultCount: 0 }; };
  await assert.rejects(inspectBossPage(f.client, { assertActive() { if (stopped) throw Object.assign(new Error("aborted"), { code: "ABORTED" }); } }), { code: "ABORTED" });
  assert.deepEqual(f.discarded, [{ searchId: "created" }]);
});
