"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dom = require("../src/browser/dom.cjs");
const { listJobs, selectJob, describeFilters, applyFilters } = require("../src/recommend/filters.cjs");
const { selectPageScope } = require("../src/recommend/page.cjs");

function mockPage(options = {}) {
  const state = { menu: false, panel: false, job: "job-a", tab: "0", school: ["不限"], firstDegree: false, age: { min: 16, max: 46 }, clicks: [], drag: null, ...options };
  const nodes = new Map();
  const node = (id, text = "", attrs = {}) => nodes.set(id, { id, text, attrs });
  node(4); node(5); node(6); node(7, "测试岗位");
  node(10, "测试岗位", { value: "job-a" }); node(11, "测试岗位", { value: "job-b" });
  node(20); node(21); node(22);
  node(30); node(31); node(32, "确定"); node(33, "取消");
  node(40); node(41, "不限"); node(42, "985"); node(43, "211");
  node(50); node(51); node(60); node(61); node(62); node(63); node(64); node(65);
  const first = (parent, selector) => {
    if (parent === 1 && selector === 'iframe[name="recommendFrame"]') return 2;
    if (parent === 3) {
      if (selector === ".ui-dropmenu-list") return 4;
      if (selector === ".ui-dropmenu.job-selecter-wrap") return 5;
      if (selector === ".ui-dropmenu.job-selecter-wrap .ui-dropmenu-label") return 7;
      if (selector === ".filter-label-wrap") return 30;
      if (selector === ".filter-panel") return state.panel ? 31 : 0;
      if (selector === ".filter-panel .check-box.school") return state.panel ? 40 : 0;
      if (selector === ".first-degree-wrap") return state.panel && !state.school.includes("不限") ? 50 : 0;
      if (selector === ".filter-item.age .vue-slider") return state.panel ? 60 : 0;
      if (selector === ".filter-item.age .vue-slider-rail") return state.panel ? 61 : 0;
    }
    if (parent === 40 && selector === ".default.option") return 41;
    if (parent === 50 && selector === ".check-box") return 51;
    return 0;
  };
  const many = (parent, selector) => {
    if (parent === 3) {
      if (selector === ".ui-dropmenu-list .job-list .job-item") return [10, 11];
      if (selector === "li.tab-item[data-status]") return options.noFeatured ? [20, 21] : [20, 21, 22];
      if (selector === ".filter-panel .btn") return state.panel ? [32, 33] : [];
      if (selector === ".filter-item.age .vue-slider-dot-tooltip-text") return [62, 63];
      if (selector === ".filter-item.age .vue-slider-dot") return [64, 65];
    }
    if (parent === 40 && selector === ".options .option") return [42, 43];
    return [];
  };
  const attrs = id => {
    if (id === 10 || id === 11) return { ...nodes.get(id).attrs, class: nodes.get(id).attrs.value === state.job ? "job-item curr" : "job-item" };
    if ([20, 21, 22].includes(id)) {
      const status = { 20: "0", 21: "1", 22: "3" }[id];
      return { "data-status": status, class: status === state.tab ? "tab-item curr" : "tab-item" };
    }
    if ([41, 42, 43].includes(id)) return { class: state.school.includes(nodes.get(id).text) ? "option active" : "option" };
    if (id === 51) return { class: state.firstDegree ? "check-box checked" : "check-box" };
    return nodes.get(id)?.attrs || {};
  };
  const press = id => {
    state.clicks.push(id);
    if (id === 5) state.menu = !state.menu;
    if (id === 10 || id === 11) { if (!state.ignoreJob) state.job = nodes.get(id).attrs.value; state.menu = false; }
    if ([20, 21, 22].includes(id)) state.tab = { 20: "0", 21: "1", 22: "3" }[id];
    if (id === 30) state.panel = true;
    if (id === 32 && !state.confirmStuck) state.panel = false;
    if (id === 33 && !state.cancelStuck) state.panel = false;
    if (id === 32 && state.resetOnConfirm) state.school = ["不限"];
    if (id === 41) state.school = ["不限"];
    if ([42, 43].includes(id)) {
      const label = nodes.get(id).text;
      state.school = state.school.filter(value => value !== "不限");
      state.school = state.school.includes(label) ? state.school.filter(value => value !== label) : [...state.school, label];
    }
    if (id === 50) state.firstDegree = !state.firstDegree;
  };
  const client = {
    DOM: {
      getDocument: async () => ({ root: { nodeId: 1 } }),
      describeNode: async () => ({ node: { contentDocument: { nodeId: 3 } } }),
      querySelector: async ({ nodeId, selector }) => ({ nodeId: first(nodeId, selector) }),
      querySelectorAll: async ({ nodeId, selector }) => ({ nodeIds: many(nodeId, selector) }),
      getAttributes: async ({ nodeId }) => ({ attributes: Object.entries(attrs(nodeId)).flat() }),
      getOuterHTML: async ({ nodeId }) => ({ outerHTML: `<span>${nodeId === 62 ? state.age.min : nodeId === 63 ? state.age.max === 46 ? "不限" : state.age.max : nodes.get(nodeId)?.text || ""}</span>` }),
      scrollIntoViewIfNeeded: async () => {},
      getBoxModel: async ({ nodeId }) => {
        if (nodeId === 4 && !state.menu) throw new Error("No layout");
        if (nodeId === 31 && !state.panel) throw new Error("No layout");
        if (nodeId === 61) return { model: { border: [0, 800, 300, 800, 300, 810, 0, 810] } };
        if (nodeId === 64 || nodeId === 65) {
          const x = (state.age[nodeId === 64 ? "min" : "max"] - 16) * 10;
          return { model: { border: [x - 5, 800, x + 5, 800, x + 5, 810, x - 5, 810] } };
        }
        return { model: { border: [nodeId * 20, 0, nodeId * 20 + 10, 0, nodeId * 20 + 10, 10, nodeId * 20, 10] } };
      }
    },
    Input: {
      dispatchMouseEvent: async event => {
        if (event.type === "mousePressed" && event.y === 805) state.drag = Math.abs(event.x - (state.age.min - 16) * 10) < 2 ? "min" : "max";
        if (event.type === "mouseReleased") {
          if (state.drag) {
            state.age[state.drag] = Math.max(16, Math.min(46, Math.round(event.x / 10) + 16));
            state.drag = null;
          } else press(Math.round((event.x - 5) / 20));
        }
      },
      dispatchKeyEvent: async event => { if (event.type === "keyUp" && event.key === "Escape") state.menu = false; }
    }
  };
  let running = false;
  const session = {
    client,
    assertActive() { if (state.cancelled) throw Object.assign(new Error("ABORTED"), { code: "ABORTED" }); },
    async check() { this.assertActive(); },
    async sleep() { this.assertActive(); },
    async run(fn) {
      if (running) throw new Error("BUSY");
      running = true;
      try { return await fn(); } finally { running = false; }
    }
  };
  dom.bindSessionClient(client, session);
  return { session, state };
}

test("listJobs preserves distinct values for identical labels and closes the menu", async () => {
  const { session, state } = mockPage();
  const result = await listJobs(session);
  assert.deepEqual(result.jobs.map(job => job.value), ["job-a", "job-b"]);
  assert.equal(result.jobs[0].label, result.jobs[1].label);
  assert.equal(state.menu, false);
});

test("listJobs closes its menu when reading the selected label fails", async () => {
  const { session, state } = mockPage();
  const getOuterHTML = session.client.DOM.getOuterHTML;
  session.client.DOM.getOuterHTML = options => options.nodeId === 7
    ? Promise.resolve({ outerHTML: "<span></span>" }) : getOuterHTML(options);
  await assert.rejects(listJobs(session), { code: "JOB_SELECTED_LABEL_NOT_FOUND" });
  assert.equal(state.menu, false);
  assert.deepEqual(state.clicks, [5]);
});

test("job selection confirms exact value, never a shared title", async () => {
  const { session, state } = mockPage({ ignoreJob: true });
  await assert.rejects(selectJob(session, "job-b"), { code: "JOB_SWITCH_UNCONFIRMED" });
  assert.equal(state.job, "job-a");
  assert.equal(state.clicks.includes(32), false);
});

test("missing featured tab does not silently apply on recommendation", async () => {
  const { session, state } = mockPage({ noFeatured: true });
  await assert.rejects(selectPageScope(session, "featured"), { code: "PAGE_SCOPE_NOT_FOUND" });
  assert.equal(state.tab, "0");
  assert.deepEqual(state.clicks, []);
});

test("unavailable option fails before changing or confirming any group", async () => {
  const { session, state } = mockPage();
  await assert.rejects(applyFilters(session, { school: "985", degree: "本科" }), { code: "FILTER_GROUP_NOT_FOUND" });
  assert.deepEqual(state.school, ["不限"]);
  assert.equal(state.clicks.includes(32), false);
  assert.equal(state.panel, false);
});

test("group matching is exact and empty arrays cannot accidentally clear criteria", async () => {
  const { session, state } = mockPage();
  await assert.rejects(applyFilters(session, { school: "98" }), { code: "FILTER_OPTION_NOT_FOUND" });
  await assert.rejects(applyFilters(session, { school: [] }), { code: "INVALID_FILTER_LABELS" });
  assert.deepEqual(state.school, ["不限"]);
});

test("school labels, first degree and slider survive confirmed readback", async () => {
  const { session, state } = mockPage();
  await selectJob(session, "job-b");
  await selectPageScope(session, "featured");
  const result = await applyFilters(session, { school: ["985", "211"], firstDegree: true, age: { min: 22, max: 35 } });
  assert.equal(state.job, "job-b");
  assert.equal(result.pageScope, "featured");
  assert.deepEqual(result.filters.school.activeLabels, ["985", "211"]);
  assert.equal(result.filters.firstDegree.checked, true);
  assert.equal(result.filters.age.min, 22);
  assert.equal(result.filters.age.max, 35);
  assert.equal(state.panel, false);
});

test("confirmation that resets the selection is reported with confirmed=true", async () => {
  const { session } = mockPage({ resetOnConfirm: true });
  await assert.rejects(applyFilters(session, { school: "985" }), error => error.code === "FILTER_READBACK_MISMATCH" && error.confirmed === true);
});

test("a confirmation click without closing the panel is marked as attempted", async () => {
  const { session } = mockPage({ confirmStuck: true });
  await assert.rejects(applyFilters(session, { school: "985" }), error => error.code === "FILTER_PANEL_CLOSE_UNCONFIRMED" && error.confirmationAttempted === true && error.confirmed === false);
});

test("failed cleanup preserves the original unavailable-group error", async () => {
  const { session } = mockPage({ cancelStuck: true });
  await assert.rejects(applyFilters(session, { degree: "本科" }), error => error.code === "FILTER_GROUP_NOT_FOUND" && error.cleanupError === "FILTER_PANEL_CLOSE_UNCONFIRMED" && error.confirmationAttempted === false);
});

test("filter failures do not roll back an already changed page scope", async () => {
  const { session, state } = mockPage();
  await selectPageScope(session, "latest");
  await assert.rejects(applyFilters(session, { degree: "本科" }), { code: "FILTER_GROUP_NOT_FOUND" });
  assert.equal(state.tab, "1");
  assert.equal(state.clicks.includes(32), false);
});

test("describe reads actual active scope and age without confirming", async () => {
  const { session, state } = mockPage({ tab: "1" });
  const result = await describeFilters(session);
  assert.equal(result.pageScope, "latest");
  assert.deepEqual(result.filters.age.labels, ["16", "不限"]);
  assert.equal(result.filters.firstDegree.available, false);
  assert.equal(state.clicks.includes(32), false);
  assert.equal(state.panel, false);
});

test("changing only the page does not confirm unrelated filter edits", async () => {
  const { session, state } = mockPage();
  const result = await selectPageScope(session, "latest");
  assert.equal(result, "latest");
  assert.equal(state.panel, false);
  assert.deepEqual(state.clicks, [21]);
  assert.equal(state.clicks.includes(32), false);
});

test("job selection is independent of page scope and filters", async () => {
  const { session, state } = mockPage({ tab: "1", school: ["211"] });
  const result = await selectJob(session, "job-b");
  assert.deepEqual(result, { value: "job-b", label: "测试岗位" });
  assert.equal(state.job, "job-b");
  assert.equal(state.tab, "1");
  assert.deepEqual(state.school, ["211"]);
  assert.equal(state.panel, false);
  assert.equal(state.menu, false);
  assert.equal(state.clicks.includes(30), false);
});

test("applyFilters cannot accept job or page orchestration", async () => {
  const { session, state } = mockPage();
  for (const request of [{ jobValue: "job-b" }, { pageScope: "latest" }, { filters: { school: "985" } }]) {
    await assert.rejects(applyFilters(session, request), { code: "FILTER_UNSUPPORTED" });
  }
  assert.deepEqual(state.clicks, []);
  const result = await applyFilters(session, { school: "985" });
  assert.equal(state.job, "job-a");
  assert.equal(state.tab, "0");
  assert.deepEqual(result.filters.school.activeLabels, ["985"]);
  assert.ok(state.clicks.every(id => ![5, 10, 11, 20, 21, 22].includes(id)));
});

test("invalid independent selections issue no clicks and missing jobs close the menu", async () => {
  const { session, state } = mockPage();
  await assert.rejects(selectJob(session, ""), { code: "INVALID_JOB_VALUE" });
  await assert.rejects(selectPageScope(session, "unknown"), { code: "PAGE_SCOPE_UNSUPPORTED" });
  assert.deepEqual(state.clicks, []);
  await assert.rejects(selectJob(session, "missing-job"), { code: "JOB_OPTION_NOT_FOUND" });
  assert.equal(state.menu, false);
});

test("aborted session does not issue filter clicks", async () => {
  const { session, state } = mockPage({ cancelled: true });
  await assert.rejects(applyFilters(session, { school: "985" }), { code: "ABORTED" });
  assert.deepEqual(state.clicks, []);
});
