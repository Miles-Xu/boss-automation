"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const api = require("..");
const { recommendCandidate, recommendResumeDetail } = require("../fixtures/candidates.cjs");

const PAGE_URL = "https://www.zhipin.com/web/chat/recommend";
const UNLIMITED = "\u4e0d\u9650";
const CONFIRM = "\u786e\u5b9a";
const CANCEL = "\u53d6\u6d88";
const TAB_STATUS = { recommend: "0", latest: "1", featured: "3" };

async function browser(t) {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "boss-public-actions-"));
  const state = {
    menu: false, panel: false, job: "job-a", scope: "recommend", school: [UNLIMITED],
    events: [], clicks: [], cards: [], wheelDeltas: [], evaluations: [], networkEnables: 0, closed: false,
    detailResponse: { ok: true, status: 200, text: JSON.stringify({ code: 0, zpData: recommendResumeDetail }) }
  };
  const client = new EventEmitter();
  const bodies = new Map();
  let serial = 0;
  const emitList = operation => {
    state.events.push(operation);
    const requestId = `synthetic-request-${++serial}`;
    const pathname = state.scope === "featured" ? "/wapi/zpitem/web/refinedGeek/list" : "/wapi/zpjob/rec/geek/list";
    const url = new URL(pathname, "https://www.zhipin.com");
    url.search = new URLSearchParams({ job: state.job, scope: state.scope, school: state.school.join(","), operation });
    bodies.set(requestId, { body: JSON.stringify({ code: 0, zpData: { geekList: [recommendCandidate] } }), base64Encoded: false });
    client.emit("Network.requestWillBeSent", { requestId, request: { url: url.href, method: "GET" } });
    client.emit("Network.responseReceived", { requestId, response: { url: url.href, status: 200 } });
    client.emit("Network.loadingFinished", { requestId });
  };
  const query = (parent, selector) => {
    if (parent === 1 && selector === 'iframe[name="recommendFrame"]') return 2;
    if (parent === 3) {
      if (selector === ".ui-dropmenu-list") return 4;
      if (selector === ".ui-dropmenu.job-selecter-wrap") return 5;
      if (selector === ".ui-dropmenu.job-selecter-wrap .ui-dropmenu-label") return 7;
      if (selector === ".filter-label-wrap") return 30;
      if (selector === ".filter-panel") return state.panel ? 31 : 0;
      if (selector === ".filter-panel .check-box.school") return state.panel ? 40 : 0;
    }
    if (parent === 40 && selector === ".default.option") return 41;
    const cardIndex = state.cards.findIndex((_, index) => parent === 100 + index * 3);
    if (cardIndex >= 0) {
      if ([".card-inner[data-geekid]", ".card-inner[data-geek], [data-geek]", "a[data-geekid]"].includes(selector)) return parent + 1;
      if (selector === ".geek-name-wrap .name") return parent + 2;
    }
    return 0;
  };
  const queryAll = (parent, selector) => {
    if (parent === 3) {
      if (selector === ".ui-dropmenu-list .job-list .job-item") return [10, 11];
      if (selector === "li.tab-item[data-status]") return [20, 21, 22];
      if (selector === ".filter-panel .btn") return state.panel ? [32, 33] : [];
      if (selector === { recommend: "ul.card-list > li.card-item", latest: ".candidate-card-wrap", featured: "li.geek-info-card" }[state.scope]) return state.cards.map((_, index) => 100 + index * 3);
    }
    if (parent === 40 && selector === ".options .option") return [42];
    return [];
  };
  const attributes = id => {
    if (id === 10 || id === 11) {
      const value = id === 10 ? "job-a" : "job-b";
      return { value, class: value === state.job ? "job-item curr" : "job-item" };
    }
    if ([20, 21, 22].includes(id)) {
      const scope = { 20: "recommend", 21: "latest", 22: "featured" }[id];
      return { "data-status": TAB_STATUS[scope], class: scope === state.scope ? "tab-item curr" : "tab-item" };
    }
    if (id === 41 || id === 42) {
      return { class: state.school.includes(id === 41 ? UNLIMITED : "985") ? "option active" : "option" };
    }
    const cardIndex = state.cards.findIndex((_, index) => id === 101 + index * 3);
    if (cardIndex >= 0) return { [state.scope === "latest" ? "data-geek" : "data-geekid"]: state.cards[cardIndex] };
    return {};
  };
  const click = id => {
    state.clicks.push(id);
    if (id === 5) state.menu = !state.menu;
    if (id === 10 || id === 11) {
      state.job = id === 10 ? "job-a" : "job-b";
      state.menu = false;
      emitList(`job:${state.job}`);
    }
    if ([20, 21, 22].includes(id)) {
      state.scope = { 20: "recommend", 21: "latest", 22: "featured" }[id];
      emitList(`page:${state.scope}`);
    }
    if (id === 30) state.panel = true;
    if (id === 32) { state.panel = false; emitList(`filters:${state.school.join(",")}`); }
    if (id === 33) state.panel = false;
    if (id === 41) state.school = [UNLIMITED];
    if (id === 42) state.school = state.school.includes("985") ? [] : ["985"];
  };
  client.Page = { getFrameTree: async () => ({ frameTree: { frame: { url: PAGE_URL } } }) };
  client.DOM = {
    getDocument: async () => ({ root: { nodeId: 1 } }),
    performSearch: async () => ({ searchId: "synthetic-search", resultCount: 0 }),
    discardSearchResults: async () => {},
    describeNode: async () => ({ node: { contentDocument: { nodeId: 3 } } }),
    querySelector: async ({ nodeId, selector }) => ({ nodeId: query(nodeId, selector) }),
    querySelectorAll: async ({ nodeId, selector }) => ({ nodeIds: queryAll(nodeId, selector) }),
    getAttributes: async ({ nodeId }) => ({ attributes: Object.entries(attributes(nodeId)).flat() }),
    getOuterHTML: async ({ nodeId }) => ({ outerHTML: `<span>${({ 7: state.job, 10: "Job A", 11: "Job B", 32: CONFIRM, 33: CANCEL, 41: UNLIMITED, 42: "985" })[nodeId] || ""}</span>` }),
    scrollIntoViewIfNeeded: async () => {},
    getBoxModel: async ({ nodeId }) => {
      if ((nodeId === 4 && !state.menu) || (nodeId === 31 && !state.panel)) throw new Error("No layout");
      return { model: { border: [nodeId * 20, 0, nodeId * 20 + 10, 0, nodeId * 20 + 10, 10, nodeId * 20, 10] } };
    }
  };
  client.Input = {
    dispatchMouseEvent: async event => {
      if (event.type === "mouseReleased") click(Math.round((event.x - 5) / 20));
      if (event.type === "mouseWheel") {
        state.events.push("scroll");
        state.wheelDeltas.push(event.deltaY);
        state.cards = state.cards.map(id => `${id}-next`);
      }
    },
    dispatchKeyEvent: async event => { if (event.type === "keyUp" && event.key === "Escape") state.menu = false; }
  };
  client.Network = {
    enable: async () => { state.networkEnables++; },
    getResponseBody: async ({ requestId }) => {
      if (!bodies.has(requestId)) throw new Error("No resource with given identifier found");
      return bodies.get(requestId);
    }
  };
  client.Runtime = {
    enable: async () => { throw new Error("Runtime.enable is not part of a public action"); },
    evaluate: async ({ expression }) => {
      state.evaluations.push(expression);
      if (expression.includes("fetchDetailInPage")) return { result: { value: state.detailResponse } };
      if (expression.includes("readPageState")) return { result: { value: {
        context: { jobs: [state.job], tabs: [TAB_STATUS[state.scope]], filters: [...state.school] },
        sources: [], error: "PAGE_RAW_UNAVAILABLE"
      } } };
      throw new Error("Unexpected page expression");
    }
  };
  client.close = async () => { state.closed = true; };
  const cdp = async () => client;
  cdp.List = async () => [{ id: "synthetic-target", type: "page", url: PAGE_URL }];
  const session = await api.connect({ cdp, lockRoot, env: {} });
  t.after(async () => {
    try { await session.close(); }
    finally { fs.rmSync(lockRoot, { recursive: true, force: true }); }
  });
  return { session, client, state };
}

test("the package exports independent commands without a batch workflow", () => {
  for (const name of ["connect", "selectJob", "selectPageScope", "applyFilters", "startListCapture", "readCandidates", "scrollCandidates", "getCandidateDetail", "parseGeek"]) {
    assert.equal(typeof api[name], "function", name);
  }
  assert.equal(Object.hasOwn(api, "collectCandidates"), false);
});

test("capture retains responses while the caller chooses page, filters, then job", async t => {
  const { session, state } = await browser(t);
  const capture = await api.startListCapture(session);
  const after = capture.mark();
  await api.selectPageScope(session, "latest");
  await api.applyFilters(session, { school: ["985"] });
  await api.selectJob(session, "job-b");
  const entries = await capture.read({ after, timeoutMs: 100 });
  assert.deepEqual(state.events, ["page:latest", "filters:985", "job:job-b"]);
  assert.deepEqual(entries.map(entry => entry.request.params.operation), state.events);
  assert.deepEqual(entries.map(entry => entry.request.params.job), ["job-a", "job-a", "job-b"]);
  assert.deepEqual(entries.map(entry => entry.request.params.scope), ["latest", "latest", "latest"]);
  assert.ok(entries.every(entry => entry.payload.geekList[0].geekId === recommendCandidate.geekId));
  assert.deepEqual(state.school, ["985"]);
  assert.equal(state.scope, "latest");
  await capture.close();
  assert.equal(state.networkEnables, 1);
});

test("starting capture after filtering does not recover an earlier response", async t => {
  const { session, state } = await browser(t);
  await api.applyFilters(session, { school: ["985"] });
  assert.equal(state.networkEnables, 0);
  const snapshot = await api.readCandidates(session);
  assert.deepEqual(snapshot.candidates, []);
  assert.equal(state.networkEnables, 0);
  const capture = await api.startListCapture(session);
  assert.deepEqual(await capture.read({ timeoutMs: 10 }), []);
  await api.selectPageScope(session, "featured");
  const entries = await capture.read({ timeoutMs: 100 });
  assert.deepEqual(entries.map(entry => entry.request.params.operation), ["page:featured"]);
  assert.equal(entries[0].request.params.school, "985");
  await capture.close();
});

test("captured raw data can request API detail without a visible card or popup fallback", async t => {
  const { session, state } = await browser(t);
  const capture = await api.startListCapture(session);
  await api.selectJob(session, "job-b");
  const [entry] = await capture.read({ timeoutMs: 100 });
  await capture.close();
  const candidate = api.parseGeek(entry.payload.geekList[0]);
  assert.equal(candidate.ref, undefined);
  const clicks = [...state.clicks];
  const result = await api.getCandidateDetail(session, candidate, { method: "api", timeoutMs: 75 });
  assert.equal(result.detail.status, "collected");
  assert.ok(result.profile.workHistory.some(work => work.company === "Fixture Internship"));
  assert.deepEqual(state.clicks, clicks);
  assert.ok(state.evaluations.at(-1).includes("securityId=synthetic-security-recommend-001"));
  assert.match(state.evaluations.at(-1), /, 75\)$/);
  state.detailResponse = { ok: false, status: 503, text: "unavailable" };
  const failed = await api.getCandidateDetail(session, candidate, { method: "api", timeoutMs: 75 });
  assert.equal(failed.detail.status, "failed");
  assert.deepEqual(state.clicks, clicks);
  assert.equal(state.networkEnables, 1);
});

test("scrolling issues one caller-sized gesture without collecting or opening details", async t => {
  const { session, state } = await browser(t);
  state.cards = ["synthetic-visible-a"];
  const result = await api.scrollCandidates(session, { deltaY: 120, timeoutMs: 50, intervalMs: 1 });
  assert.equal(result.changed, true);
  assert.equal(result.before[0].identity.value, "synthetic-visible-a");
  assert.equal(result.after[0].identity.value, "synthetic-visible-a-next");
  assert.deepEqual(state.events, ["scroll"]);
  assert.deepEqual(state.wheelDeltas, [120]);
  assert.deepEqual(state.clicks, []);
  assert.deepEqual(state.evaluations, []);
  assert.equal(state.networkEnables, 0);
});

test("independent public commands cannot overlap on one session", async t => {
  const { session, state } = await browser(t);
  const selecting = api.selectJob(session, "job-b");
  await assert.rejects(api.selectPageScope(session, "latest"), { code: "SESSION_BUSY" });
  await selecting;
  assert.equal(state.scope, "recommend");
  assert.deepEqual(state.events, ["job:job-b"]);
});
