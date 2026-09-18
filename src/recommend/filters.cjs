"use strict";

const dom = require("../browser/dom.cjs");
const { getRecommendDocument, readPageScope, hasBox, outerText, fail } = require("./page.cjs");

const JOB_TRIGGERS = [".ui-dropmenu.job-selecter-wrap", ".job-selecter-wrap", ".chat-job-select", ".chat-job-selector", ".job-selecter", ".job-selector", ".job-select-wrap", ".job-select", ".job-select-box", ".job-wrap", ".chat-job-name"];
const JOB_ITEMS = [".ui-dropmenu-list .job-list .job-item", ".job-selecter-options .job-list .job-item", ".job-selector-options .job-list .job-item", ".dropmenu-list .job-list .job-item", ".job-list .job-item"];
const JOB_LABELS = [".ui-dropmenu.job-selecter-wrap .ui-dropmenu-label", ".job-selecter-wrap .ui-dropmenu-label", ".chat-job-name", ".job-selecter .label", ".job-selecter .job-name", ".job-select .label"];
const GROUPS = ["school", "degree", "major", "activation", "exchangeResumeWithColleague", "switchJobFrequency", "experience", "salary", "intention", "gender", "recentNotView"];
const UNLIMITED = new Set(["不限", "全部"]);
const AGE_MIN = 16;
const AGE_MAX = 46;
const normalize = value => String(value ?? "").replace(/\s+/g, " ").trim();

async function query(session, selector) {
  const { docNodeId } = await getRecommendDocument(session);
  return dom.querySelector(session.client, docNodeId, selector);
}

async function queryAll(session, selector) {
  const { docNodeId } = await getRecommendDocument(session);
  return dom.querySelectorAll(session.client, docNodeId, selector);
}

async function click(session, nodeId) {
  await session.check();
  await dom.clickNode(session.client, nodeId);
}

async function dismissRecovery(session) {
  const id = await query(session, ".recover-last-change-params .cancel");
  if (id && await hasBox(session, id)) await click(session, id);
}

async function selectedJobLabel(session) {
  for (const selector of JOB_LABELS) {
    const id = await query(session, selector);
    if (!id) continue;
    const text = outerText(await dom.getOuterHTML(session.client, id));
    if (text) return text;
  }
  throw fail("JOB_SELECTED_LABEL_NOT_FOUND");
}

async function openJobs(session) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const menu = await query(session, ".ui-dropmenu-list");
    if (menu && await hasBox(session, menu)) return;
    let trigger;
    for (const selector of JOB_TRIGGERS) {
      const id = await query(session, selector);
      if (id && await hasBox(session, id)) { trigger = id; break; }
    }
    if (!trigger) throw fail("JOB_TRIGGER_NOT_FOUND");
    await click(session, trigger);
    await session.sleep(280 + attempt * 80);
  }
  throw fail("JOB_MENU_DID_NOT_OPEN");
}

async function readJobs(session) {
  for (const selector of JOB_ITEMS) {
    const ids = await queryAll(session, selector);
    if (!ids.length) continue;
    const jobs = [];
    for (const nodeId of ids) {
      const attrs = await dom.getAttributes(session.client, nodeId);
      const labelId = await dom.querySelector(session.client, nodeId, ".label");
      const label = outerText(await dom.getOuterHTML(session.client, labelId || nodeId));
      const value = normalize(attrs.value || attrs["data-value"]);
      jobs.push({ nodeId, value: value || null, label, current: /\b(?:curr|current|active|selected)\b/.test(attrs.class || "") });
    }
    return jobs;
  }
  throw fail("JOB_LIST_EMPTY_AFTER_OPEN");
}

async function closeJobs(session) {
  const menu = await query(session, ".ui-dropmenu-list");
  if (!menu || !await hasBox(session, menu)) return;
  await session.check();
  await dom.pressKey(session.client, "Escape", { code: "Escape", windowsVirtualKeyCode: 27 });
  await session.sleep(180);
  const remaining = await query(session, ".ui-dropmenu-list");
  if (remaining && await hasBox(session, remaining)) {
    const { docNodeId } = await getRecommendDocument(session);
    const active = await dom.querySelector(session.client, docNodeId, "li.tab-item[data-status].curr, li.tab-item[data-status].active");
    if (active) { await click(session, active); await session.sleep(180); }
  }
  const final = await query(session, ".ui-dropmenu-list");
  if (final && await hasBox(session, final)) throw fail("JOB_MENU_CLOSE_UNCONFIRMED");
}

async function listJobs(session) {
  return session.run(async () => {
    let primaryError;
    try {
      await session.check();
      await openJobs(session);
      const jobs = (await readJobs(session)).map(({ nodeId, ...job }) => job);
      return { jobs, selectedLabel: await selectedJobLabel(session) };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        session.assertActive();
        await closeJobs(session);
      } catch (error) {
        if (primaryError) primaryError.cleanupError = error.code || error.message;
        else throw error;
      }
    }
  });
}

async function selectJobInternal(session, jobValue) {
  await openJobs(session);
  const jobs = await readJobs(session);
  const matches = jobs.filter(job => job.value === jobValue);
  if (matches.length !== 1) throw fail(matches.length ? "JOB_SELECTION_AMBIGUOUS" : "JOB_OPTION_NOT_FOUND", { jobValue });
  const target = matches[0];
  if (!target.current) {
    await click(session, target.nodeId);
    await session.sleep(500);
  }
  // Two jobs may have the same title. Confirm the option's value and current class.
  for (let attempt = 0; attempt < 12; attempt++) {
    await openJobs(session);
    const current = (await readJobs(session)).filter(job => job.current);
    if (current.length === 1 && current[0].value === jobValue) {
      await closeJobs(session);
      return { value: target.value, label: target.label };
    }
    await closeJobs(session);
    await session.sleep(220 + attempt * 50);
  }
  throw fail("JOB_SWITCH_UNCONFIRMED", { jobValue });
}

async function selectJob(session, jobValue) {
  if (typeof jobValue !== "string" || !normalize(jobValue)) throw fail("INVALID_JOB_VALUE");
  return session.run(async () => {
    let primaryError;
    try {
      return await selectJobInternal(session, jobValue);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        session.assertActive();
        await closeJobs(session);
      } catch (error) {
        if (primaryError) primaryError.cleanupError = error.code || error.message;
        else throw error;
      }
    }
  });
}

async function openPanel(session) {
  const existing = await query(session, ".filter-panel");
  if (existing && await hasBox(session, existing)) return;
  const trigger = await query(session, ".filter-label-wrap");
  if (!trigger) throw fail("FILTER_TRIGGER_NOT_FOUND");
  await click(session, trigger);
  for (let i = 0; i < 30; i++) {
    await session.sleep(200);
    const panel = await query(session, ".filter-panel");
    if (panel && await hasBox(session, panel)) return;
  }
  throw fail("FILTER_PANEL_DID_NOT_OPEN");
}

async function closePanel(session, confirm, beforeClick = () => {}) {
  const panel = await query(session, ".filter-panel");
  if (!panel || !await hasBox(session, panel)) return;
  const label = confirm ? "确定" : "取消";
  const buttons = await queryAll(session, ".filter-panel .btn");
  let target;
  for (const id of buttons) {
    if (outerText(await dom.getOuterHTML(session.client, id)) === label) { target = id; break; }
  }
  if (!target) throw fail("FILTER_BUTTON_NOT_FOUND", { label });
  beforeClick();
  await click(session, target);
  for (let i = 0; i < 30; i++) {
    await session.sleep(200);
    const remaining = await query(session, ".filter-panel");
    if (!remaining || !await hasBox(session, remaining)) return;
  }
  throw fail("FILTER_PANEL_CLOSE_UNCONFIRMED");
}

async function readGroup(session, group) {
  const nodeId = await query(session, `.filter-panel .check-box.${group}`);
  if (!nodeId) return { available: false, options: [], activeLabels: [] };
  const options = [];
  const unlimited = await dom.querySelector(session.client, nodeId, ".default.option");
  if (unlimited) {
    const attrs = await dom.getAttributes(session.client, unlimited);
    options.push({ nodeId: unlimited, label: outerText(await dom.getOuterHTML(session.client, unlimited)), active: /\bactive\b/.test(attrs.class || ""), unlimited: true });
  }
  for (const id of await dom.querySelectorAll(session.client, nodeId, ".options .option")) {
    const attrs = await dom.getAttributes(session.client, id);
    options.push({ nodeId: id, label: outerText(await dom.getOuterHTML(session.client, id)), active: /\bactive\b/.test(attrs.class || ""), unlimited: false });
  }
  return { available: true, options, activeLabels: options.filter(option => option.active).map(option => option.label) };
}

function equalLabels(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function validateGroup(info, group, wanted) {
  if (!info.available) throw fail("FILTER_GROUP_NOT_FOUND", { group });
  for (const label of wanted) {
    const matches = info.options.filter(option => option.label === label);
    if (matches.length !== 1) throw fail(matches.length ? "FILTER_OPTION_AMBIGUOUS" : "FILTER_OPTION_NOT_FOUND", { group, label });
  }
}

async function applyGroup(session, group, wanted) {
  let info = await readGroup(session, group);
  validateGroup(info, group, wanted);
  const unlimited = info.options.find(option => option.unlimited && wanted.includes(option.label));
  if (unlimited) {
    if (!unlimited.active) await click(session, unlimited.nodeId);
    await session.sleep(150);
  } else {
    for (const label of info.activeLabels.filter(label => !wanted.includes(label))) {
      info = await readGroup(session, group);
      const option = info.options.find(item => item.label === label);
      if (option?.active && !option.unlimited) { await click(session, option.nodeId); await session.sleep(120); }
    }
    for (const label of wanted) {
      info = await readGroup(session, group);
      const option = info.options.find(item => item.label === label);
      if (!option) throw fail("FILTER_OPTION_DISAPPEARED", { group, label });
      if (!option.active) { await click(session, option.nodeId); await session.sleep(120); }
    }
  }
  const actual = (await readGroup(session, group)).activeLabels;
  if (!equalLabels(actual, wanted)) throw fail("FILTER_READBACK_MISMATCH", { group, expected: wanted, actual });
}

async function readFirstDegree(session) {
  const wrap = await query(session, ".first-degree-wrap");
  if (!wrap) return { available: false };
  const checkbox = await dom.querySelector(session.client, wrap, ".check-box");
  if (!checkbox) return { available: false };
  const attrs = await dom.getAttributes(session.client, checkbox);
  return { available: true, checked: /\bchecked\b/.test(attrs.class || ""), nodeId: wrap };
}

async function applyFirstDegree(session, checked) {
  let state = await readFirstDegree(session);
  if (!state.available) throw fail("FIRST_DEGREE_TOGGLE_NOT_FOUND");
  if (state.checked !== checked) await click(session, state.nodeId);
  for (let i = 0; i < 8; i++) {
    await session.sleep(150);
    state = await readFirstDegree(session);
    if (state.available && state.checked === checked) return;
  }
  throw fail("FIRST_DEGREE_READBACK_MISMATCH");
}

async function readAge(session) {
  if (!await query(session, ".filter-item.age .vue-slider")) return { available: false };
  const labels = [];
  for (const id of await queryAll(session, ".filter-item.age .vue-slider-dot-tooltip-text")) labels.push(outerText(await dom.getOuterHTML(session.client, id)));
  const parse = value => ["不限", "无限制", "无限"].includes(value) ? AGE_MAX : /^\d+$/.test(value || "") ? Number(value) : null;
  const min = parse(labels[0]);
  const max = parse(labels[1]);
  if (labels.length !== 2 || min === null || max === null) throw fail("AGE_LABEL_UNREADABLE", { labels });
  return { available: true, min, max, labels };
}

async function geometry(session, nodeId) {
  const { model } = await session.client.DOM.getBoxModel({ nodeId });
  const q = model?.border?.length ? model.border : model?.content || [];
  if (q.length < 8) throw fail("AGE_GEOMETRY_UNAVAILABLE");
  const left = Math.min(q[0], q[2], q[4], q[6]);
  const right = Math.max(q[0], q[2], q[4], q[6]);
  if (right <= left) throw fail("AGE_GEOMETRY_UNAVAILABLE");
  return { left, right, width: right - left, cx: (left + right) / 2, cy: (Math.min(q[1], q[3], q[5], q[7]) + Math.max(q[1], q[3], q[5], q[7])) / 2 };
}

function ageX(rail, age) {
  if (age <= AGE_MIN) return rail.left - 20;
  if (age >= AGE_MAX) return rail.right + 20;
  return rail.left + (age - AGE_MIN) / (AGE_MAX - AGE_MIN) * rail.width;
}

async function dragAge(session, index, x) {
  let ids = await queryAll(session, ".filter-item.age .vue-slider-dot");
  if (!ids[index]) throw fail("AGE_DOT_NOT_FOUND");
  await session.check();
  await dom.scrollIntoView(session.client, ids[index]);
  await session.sleep(80);
  ids = await queryAll(session, ".filter-item.age .vue-slider-dot");
  if (!ids[index]) throw fail("AGE_DOT_NOT_FOUND");
  const origin = await geometry(session, ids[index]);
  const input = session.client.Input;
  await session.check();
  await input.dispatchMouseEvent({ type: "mouseMoved", x: origin.cx, y: origin.cy, button: "none" });
  await session.sleep(40);
  await input.dispatchMouseEvent({ type: "mousePressed", x: origin.cx, y: origin.cy, button: "left", clickCount: 1 });
  await session.sleep(80);
  for (let step = 1; step <= 14; step++) {
    session.assertActive();
    await input.dispatchMouseEvent({ type: "mouseMoved", x: origin.cx + (x - origin.cx) * step / 14, y: origin.cy, button: "left" });
    await session.sleep(25);
  }
  await input.dispatchMouseEvent({ type: "mouseReleased", x, y: origin.cy, button: "left", clickCount: 1 });
  await session.sleep(280);
}

async function settleAge(session, expected) {
  await session.sleep(600);
  let state;
  for (let i = 0; i < 8; i++) {
    state = await readAge(session);
    if (state.min === expected.min && state.max === expected.max) return state;
    await session.sleep(200);
  }
  return state;
}

async function applyAge(session, expected) {
  let state = await readAge(session);
  if (!state.available) throw fail("AGE_FILTER_NOT_FOUND");
  const slider = await query(session, ".filter-item.age .vue-slider");
  await session.check();
  await dom.scrollIntoView(session.client, slider);
  await session.sleep(120);
  const railId = await query(session, ".filter-item.age .vue-slider-rail");
  if (!railId) throw fail("AGE_RAIL_NOT_FOUND");
  const rail = await geometry(session, railId);
  const perUnit = rail.width / (AGE_MAX - AGE_MIN);
  // Expand first so neither handle blocks the requested range.
  const order = expected.max < state.min ? [0, 1] : [1, 0];
  for (const index of order) {
    const key = index === 0 ? "min" : "max";
    if (state[key] !== expected[key]) await dragAge(session, index, ageX(rail, expected[key]));
  }
  state = await settleAge(session, expected);
  for (let round = 0; round < 2 && (state.min !== expected.min || state.max !== expected.max); round++) {
    for (const index of order) {
      const key = index === 0 ? "min" : "max";
      if (state[key] === expected[key]) continue;
      const dots = await queryAll(session, ".filter-item.age .vue-slider-dot");
      if (!dots[index]) throw fail("AGE_DOT_NOT_FOUND");
      const dot = await geometry(session, dots[index]);
      const delta = expected[key] - state[key];
      const x = expected[key] === AGE_MIN || expected[key] === AGE_MAX ? ageX(rail, expected[key]) : dot.cx + delta * perUnit + Math.sign(delta) * 4;
      await dragAge(session, index, x);
    }
    state = await settleAge(session, expected);
  }
  if (state.min !== expected.min || state.max !== expected.max) throw fail("AGE_READBACK_MISMATCH", { expected, actual: state });
}

async function readPanel(session) {
  const filters = {};
  for (const group of GROUPS) {
    const state = await readGroup(session, group);
    filters[group] = { ...state, options: state.options.map(({ nodeId, ...option }) => option) };
  }
  filters.age = await readAge(session);
  const { nodeId, ...firstDegree } = await readFirstDegree(session);
  filters.firstDegree = firstDegree;
  return filters;
}

async function describeFilters(session) {
  return session.run(async () => {
    let primaryError;
    try {
      await session.check();
      await dismissRecovery(session);
      await openPanel(session);
      return { pageScope: await readPageScope(session), selectedJobLabel: await selectedJobLabel(session), filters: await readPanel(session) };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        session.assertActive();
        await closePanel(session, false);
      } catch (error) {
        if (primaryError) primaryError.cleanupError = error.code || error.message;
        else throw error;
      }
    }
  });
}

function validateFilters(filters) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw fail("INVALID_FILTER_REQUEST");
  const result = {};
  for (const [key, value] of Object.entries(filters)) {
    if (GROUPS.includes(key)) {
      const labels = typeof value === "string" ? [normalize(value)] : Array.isArray(value) && value.every(item => typeof item === "string") ? value.map(normalize) : [];
      if (!labels.length || labels.some(label => !label) || new Set(labels).size !== labels.length || (labels.length > 1 && labels.some(label => UNLIMITED.has(label)))) throw fail("INVALID_FILTER_LABELS", { group: key });
      result[key] = labels;
    } else if (key === "firstDegree") {
      if (typeof value !== "boolean") throw fail("INVALID_FIRST_DEGREE");
      result[key] = value;
    } else if (key === "age") {
      if (!value || !Number.isInteger(value.min) || !Number.isInteger(value.max) || value.min < AGE_MIN || value.max > AGE_MAX || value.min > value.max) throw fail("INVALID_AGE_RANGE");
      result[key] = { min: value.min, max: value.max };
    } else throw fail("FILTER_UNSUPPORTED", { group: key });
  }
  return result;
}

async function applyFilters(session, filters = {}) {
  const desired = validateFilters(filters);
  return session.run(async () => {
    let confirmed = false;
    let confirmationAttempted = false;
    let primaryError;
    try {
      await session.check();
      await dismissRecovery(session);
      await openPanel(session);
      if (Object.keys(desired).length === 0) {
        return { pageScope: await readPageScope(session), selectedJobLabel: await selectedJobLabel(session), filters: await readPanel(session) };
      }
      // Resolve all requested labels before changing the current selection.
      for (const group of GROUPS) if (Object.hasOwn(desired, group)) validateGroup(await readGroup(session, group), group, desired[group]);
      for (const group of GROUPS) if (Object.hasOwn(desired, group)) await applyGroup(session, group, desired[group]);
      if (Object.hasOwn(desired, "firstDegree")) await applyFirstDegree(session, desired.firstDegree);
      if (desired.age) await applyAge(session, desired.age);
      await closePanel(session, true, () => { confirmationAttempted = true; });
      confirmed = true;
      await session.sleep(500);
      await openPanel(session);
      const actual = await readPanel(session);
      for (const group of GROUPS) {
        if (Object.hasOwn(desired, group) && !equalLabels(actual[group].activeLabels, desired[group])) throw fail("FILTER_READBACK_MISMATCH", { group, expected: desired[group], actual: actual[group].activeLabels, confirmed });
      }
      if (Object.hasOwn(desired, "firstDegree") && (!actual.firstDegree.available || actual.firstDegree.checked !== desired.firstDegree)) throw fail("FIRST_DEGREE_READBACK_MISMATCH", { confirmed });
      if (desired.age && (actual.age.min !== desired.age.min || actual.age.max !== desired.age.max)) throw fail("AGE_READBACK_MISMATCH", { confirmed });
      const pageScope = await readPageScope(session);
      return { pageScope, selectedJobLabel: await selectedJobLabel(session), filters: actual };
    } catch (error) {
      error.confirmed = confirmed;
      error.confirmationAttempted = confirmationAttempted;
      primaryError = error;
      throw error;
    } finally {
      try {
        session.assertActive();
        await closePanel(session, false);
      } catch (error) {
        if (primaryError) primaryError.cleanupError = error.code || error.message;
        else {
          error.confirmed = confirmed;
          error.confirmationAttempted = confirmationAttempted;
          throw error;
        }
      }
    }
  });
}

module.exports = { listJobs, selectJob, describeFilters, readFilters: describeFilters, applyFilters };
