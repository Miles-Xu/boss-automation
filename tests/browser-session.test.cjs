const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { connect, selectTarget } = require("../src/browser/session.cjs");
const { acquireBrowserLease } = require("../src/browser/lease.cjs");
const dom = require("../src/browser/dom.cjs");
const { ResponseMonitor } = require("../src/recommend/network.cjs");

const URL = "https://www.zhipin.com/web/chat/recommend";
const target = (id, url = URL) => ({ id, type: "page", url });

function fixture(t, options = {}) {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "boss-automation-session-"));
  t.after(() => fs.rmSync(lockRoot, { recursive: true, force: true }));
  const calls = [];
  const state = { url: URL, warning: false, evaluate: 17, ...options.state };
  const client = new EventEmitter();
  client.Page = { getFrameTree: async () => {
    calls.push("Page.getFrameTree");
    return { frameTree: { frame: { url: state.url } } };
  } };
  client.DOM = {
    getDocument: async () => { calls.push("DOM.getDocument"); return { root: { nodeId: 1 } }; },
    performSearch: async () => ({ searchId: "search", resultCount: state.warning ? 1 : 0 }),
    getSearchResults: async () => ({ nodeIds: [4] }),
    getBoxModel: async () => ({ model: { width: 10, height: 10, border: [0, 0, 10, 0, 10, 10, 0, 10] } }),
    discardSearchResults: async () => { calls.push("DOM.discardSearchResults"); },
    querySelector: async () => ({ nodeId: 3 })
  };
  client.Input = { dispatchMouseEvent: async (event) => { calls.push(event.type); } };
  client.Runtime = {
    enable: () => { throw new Error("Runtime.enable must never run"); },
    evaluate: async (request) => { calls.push(request); return { result: { value: state.evaluate } }; }
  };
  client.close = async () => { calls.push("close"); };
  const cdp = async () => { calls.push("connect"); return client; };
  cdp.List = async () => options.targets || [target("main")];
  const open = (extra = {}) => connect({ cdp, lockRoot, env: {}, ...extra });
  return { open, client, state, calls, lockRoot };
}

test("target selection requires the exact BOSS host and recommendation path", () => {
  const rejected = [
    "https://www.zhipin.com.attacker.invalid/web/chat/recommend",
    "https://attacker.invalid/?next=https://www.zhipin.com/web/chat/recommend",
    "https://www.zhipin.com/web/chat/recommendation",
    "https://www.zhipin.com/web/chat/index",
    "https://user:secret@www.zhipin.com/web/chat/recommend",
    "http://www.zhipin.com/web/chat/recommend"
  ];
  for (const url of rejected) {
    assert.throws(() => selectTarget([target("bad", url)]), { code: "BOSS_TARGET_NOT_FOUND" });
    assert.throws(() => selectTarget([target("bad", url), target("good")], "bad"), { code: "BOSS_TARGET_NOT_FOUND" });
  }
  assert.equal(selectTarget([target("a", "https://zhipin.com/web/chat/recommend?job=synthetic")]).id, "a");
  assert.throws(() => selectTarget([target("a"), target("b")]), { code: "BOSS_TARGET_AMBIGUOUS" });
  assert.equal(selectTarget([target("a"), target("b")], "b").id, "b");
  assert.throws(() => selectTarget([{ ...target("worker"), type: "service_worker" }]), { code: "BOSS_TARGET_NOT_FOUND" });
});

test("failed selection releases the lease and reports no candidate URLs", async (t) => {
  const f = fixture(t, { targets: [target("wrong", "https://other.invalid/?token=synthetic-secret")] });
  await assert.rejects(f.open(), (error) => error.code === "BOSS_TARGET_NOT_FOUND" && !error.message.includes("synthetic-secret"));
  assert.deepEqual(f.calls, []);
  const lease = acquireBrowserLease({ lockRoot: f.lockRoot, env: {} });
  lease.release();
});

test("evaluate uses by-value evaluation without enabling Runtime", async (t) => {
  const f = fixture(t);
  const session = await f.open();
  assert.equal(await session.evaluate("1 + 16"), 17);
  assert.deepEqual(f.calls.find((call) => typeof call === "object"), { expression: "1 + 16", awaitPromise: true, returnByValue: true });
  await session.close();
  assert.equal(f.client.listenerCount("disconnect"), 0);
});

test("operations reject overlap and remain busy until the callback resolves", async (t) => {
  const f = fixture(t);
  const session = await f.open();
  let finish;
  const pending = session.run(() => new Promise((resolve) => { finish = resolve; }));
  await assert.rejects(session.run(() => 2), { code: "SESSION_BUSY" });
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  finish("done");
  assert.equal(await pending, "done");
  assert.equal(await session.run(() => "next"), "next");
  await session.close();
});

test("abort interrupts sleeping and prevents subsequent DOM and evaluate calls", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const session = await f.open({ signal: controller.signal });
  const pending = session.sleep(30000);
  controller.abort();
  await assert.rejects(pending, { code: "ABORTED" });
  const before = f.calls.length;
  await assert.rejects(session.evaluate("location.href"), { code: "ABORTED" });
  await assert.rejects(dom.querySelector(f.client, 1, "body"), { code: "ABORTED" });
  assert.equal(f.calls.length, before);
  await session.close();
});

test("abort between mouse events prevents the click from being completed", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const session = await f.open({ signal: controller.signal });
  f.client.Input.dispatchMouseEvent = async (event) => {
    f.calls.push(event.type);
    controller.abort();
  };
  await assert.rejects(dom.clickAt(f.client, 2, 2), { code: "ABORTED" });
  assert.ok(f.calls.includes("mouseMoved"));
  assert.ok(!f.calls.includes("mousePressed"));
  await session.close();
});

test("close cancels sleepers, runs cleanup and retains lease until CDP closes", async (t) => {
  const f = fixture(t);
  const session = await f.open();
  let finishClose;
  session.addCleanup(async () => f.calls.push("cleanup"));
  f.client.close = () => new Promise((resolve) => { f.calls.push("close"); finishClose = resolve; });
  const sleeping = session.sleep(30000);
  const closing = session.close();
  assert.equal(session.close(), closing);
  await assert.rejects(sleeping, { code: "SESSION_CLOSED" });
  assert.throws(() => acquireBrowserLease({ lockRoot: f.lockRoot, env: {} }), { code: "BROWSER_BUSY" });
  assert.deepEqual(f.calls.slice(-2), ["cleanup", "close"]);
  finishClose();
  await closing;
  const lease = acquireBrowserLease({ lockRoot: f.lockRoot, env: {} });
  lease.release();
});

test("a safety stop is terminal even if the page later looks normal", async (t) => {
  const f = fixture(t);
  const session = await f.open();
  f.state.warning = true;
  await assert.rejects(session.check(), { code: "BOSS_ANTIBOT_TRIGGERED" });
  f.state.warning = false;
  await assert.rejects(session.run(() => "never"), { code: "BOSS_ANTIBOT_TRIGGERED" });
  await session.close();
});

test("navigation, disconnection and lost lease all prevent later commands", async (t) => {
  for (const kind of ["navigation", "disconnect", "lease"]) {
    const f = fixture(t);
    const session = await f.open();
    const expected = { navigation: "BOSS_TARGET_CHANGED", disconnect: "BROWSER_DISCONNECTED", lease: "BROWSER_LEASE_LOST" }[kind];
    if (kind === "navigation") f.state.url = "https://other.invalid/";
    if (kind === "disconnect") f.client.emit("disconnect");
    if (kind === "lease") fs.unlinkSync(path.join(f.lockRoot, "port-9222.json"));
    await assert.rejects(session.check(), { code: expected });
    await assert.rejects(session.evaluate("1"), { code: expected });
    await session.close();
  }
});

test("abort during a page check stops before the next protocol call", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const session = await f.open({ signal: controller.signal });
  f.client.Page.getFrameTree = async () => {
    controller.abort();
    return { frameTree: { frame: { url: URL } } };
  };
  const before = f.calls.filter((call) => call === "DOM.getDocument").length;
  await assert.rejects(session.check(), { code: "ABORTED" });
  assert.equal(f.calls.filter((call) => call === "DOM.getDocument").length, before);
  await session.close();
});

test("a failed transport close retains the lease", async (t) => {
  const f = fixture(t);
  const session = await f.open();
  f.client.close = async () => { throw new Error("synthetic close failure"); };
  await assert.rejects(session.close(), /synthetic close failure/);
  assert.throws(() => acquireBrowserLease({ lockRoot: f.lockRoot, env: {} }), { code: "BROWSER_BUSY" });
  await assert.rejects(session.evaluate("1"), { code: "SESSION_CLOSED" });
});

test("cleanup failures still close CDP before releasing the lease", async (t) => {
  const f = fixture(t);
  const session = await f.open();
  session.addCleanup(() => { throw new Error("synthetic cleanup failure"); });
  session.addCleanup(() => f.calls.push("last cleanup"));
  await assert.rejects(session.close(), { name: "AggregateError" });
  assert.deepEqual(f.calls.slice(-2), ["last cleanup", "close"]);
  const lease = acquireBrowserLease({ lockRoot: f.lockRoot, env: {} });
  lease.release();
});

test("aborting while evaluation is pending discards the late result", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const session = await f.open({ signal: controller.signal });
  let complete;
  f.client.Runtime.evaluate = () => new Promise((resolve) => { complete = resolve; });
  const pending = session.evaluate("synthetic operation");
  controller.abort();
  complete({ result: { value: "late result" } });
  await assert.rejects(pending, { code: "ABORTED" });
  await session.close();
});

test("session closes transport and releases lease without waiting for a hung network body", { timeout: 2000 }, async (t) => {
  const f = fixture(t);
  const session = await f.open();
  let rejectBody;
  let bodyCalls = 0;
  let transportClosed = false;
  f.client.Network = {
    enable: async () => {},
    getResponseBody: () => {
      bodyCalls++;
      return new Promise((_resolve, reject) => { rejectBody = reject; });
    }
  };
  const monitor = await new ResponseMonitor(session).start();
  f.client.emit("Network.requestWillBeSent", { requestId: "hung", request: { method: "GET", url: "https://www.zhipin.com/wapi/zpjob/rec/geek/list" } });
  f.client.emit("Network.responseReceived", { requestId: "hung", response: { status: 200 } });
  f.client.emit("Network.loadingFinished", { requestId: "hung" });
  assert.equal(bodyCalls, 1);
  f.client.close = async () => {
    assert.equal(f.client.listenerCount("Network.loadingFinished"), 0);
    transportClosed = true;
    rejectBody(new Error("Synthetic transport closed"));
  };
  const closing = session.close();
  let timeout;
  try {
    await Promise.race([
      closing,
      new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("CDP close blocked by a pending response body")), 500); })
    ]);
  } finally {
    clearTimeout(timeout);
    rejectBody(new Error("Synthetic test cleanup"));
    await closing;
  }
  assert.equal(transportClosed, true);
  assert.equal(monitor.pending.size, 0);
  assert.equal(monitor.failure, null);
  const lease = acquireBrowserLease({ lockRoot: f.lockRoot, env: {} });
  lease.release();
});

test("a captured rate limit stops pending reads and subsequent session operations", { timeout: 2000 }, async (t) => {
  const f = fixture(t);
  const session = await f.open();
  t.after(() => session.close());
  f.client.Network = { enable: async () => {}, getResponseBody: () => new Promise(() => {}) };
  const monitor = await new ResponseMonitor(session, { kinds: ["list"] }).start();
  const url = "https://www.zhipin.com/wapi/zpjob/rec/geek/list";
  f.client.emit("Network.requestWillBeSent", { requestId: "pending", request: { method: "GET", url } });
  f.client.emit("Network.responseReceived", { requestId: "pending", response: { status: 200, url } });
  f.client.emit("Network.loadingFinished", { requestId: "pending" });
  const pendingRead = assert.rejects(monitor.flush({ timeoutMs: 10000 }), { code: "BOSS_RATE_LIMITED" });
  const sleeping = session.sleep(10000);
  const stoppedSleep = assert.rejects(sleeping, { code: "BOSS_RATE_LIMITED" });
  f.client.emit("Network.requestWillBeSent", { requestId: "limited", request: { method: "GET", url } });
  f.client.emit("Network.responseReceived", { requestId: "limited", response: { status: 429, url } });
  await stoppedSleep;
  await pendingRead;
  let operationRan = false;
  await assert.rejects(session.run(async () => { operationRan = true; }), { code: "BOSS_RATE_LIMITED" });
  assert.equal(operationRan, false);
  await assert.rejects(monitor.flush(), { code: "BOSS_RATE_LIMITED" });
  await session.close();
});

test("an aborted session issues no body reads for pending or newly arriving responses", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const session = await f.open({ signal: controller.signal });
  let bodyCalls = 0;
  f.client.Network = {
    enable: async () => {},
    getResponseBody: async () => { bodyCalls++; return { body: "{}", base64Encoded: false }; }
  };
  const monitor = await new ResponseMonitor(session).start();
  const request = id => f.client.emit("Network.requestWillBeSent", { requestId: id, request: { method: "GET", url: "https://www.zhipin.com/wapi/zpjob/rec/geek/list" } });
  request("before-abort");
  controller.abort();
  request("after-abort");
  for (const requestId of ["before-abort", "after-abort"]) {
    f.client.emit("Network.responseReceived", { requestId, response: { status: 200 } });
    f.client.emit("Network.loadingFinished", { requestId });
  }
  await assert.rejects(monitor.flush(), { code: "ABORTED" });
  assert.equal(bodyCalls, 0);
  await session.close();
  assert.equal(f.client.listenerCount("Network.requestWillBeSent"), 0);
  assert.equal(f.client.listenerCount("Network.loadingFinished"), 0);
});
