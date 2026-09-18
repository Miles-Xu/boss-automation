"use strict";
const page = require("./page.cjs");
const { parseGeek, getSnapshotCandidateGeekIds, normalizeText } = require("../candidate-profile.cjs");

// Runs in the logged-in page. Read raw objects without changing Vue state.
function readPageState() {
  const frame = [...document.querySelectorAll("iframe")].find(item => new URL(item.src, location.href).pathname.includes("/frame/recommend"));
  const doc = frame?.contentDocument;
  if (!doc) return { error: "NO_RECOMMEND_IFRAME", sources: [] };
  const text = selector => [...doc.querySelectorAll(selector)].map(item => item.textContent.replace(/\s+/g, " ").trim());
  const context = {
    jobs: [...doc.querySelectorAll(".job-list .job-item.curr, .job-list .job-item.active, .job-list .job-item.selected")].map(item => item.getAttribute("value") || item.getAttribute("data-value")),
    jobLabel: text(".job-selecter-wrap .ui-dropmenu-label, .chat-job-name, .job-selecter .job-name"),
    tabs: [...doc.querySelectorAll("li.tab-item.curr, li.tab-item.active, li.tab-item.selected")].map(item => item.getAttribute("data-status")),
    filters: text(".filter-label-wrap, .filter-panel .active, .filter-panel .selected, .filter-panel .checked")
  };
  const root = doc.querySelector(".recommend-wrap")?.__vue__;
  const content = root?.$children?.find(vm => vm?.$options?.name === "RecommendContent");
  const sources = [];
  const add = (source, values) => {
    if (Array.isArray(values) && values.length) sources.push({ source, values });
  };
  for (const card of doc.querySelectorAll("li.geek-info-card, .candidate-card-wrap, ul.card-list > li.card-item")) {
    const vm = card.__vue__;
    const props = vm?._props || vm?.$props;
    add("vue_card_data_list", props?.dataList);
    const geek = props?.geek || vm?.geek;
    if (geek && typeof geek === "object") add("vue_card_geek", [geek]);
  }
  for (const name of ["geekList", "dataList", "newDataList"]) {
    add(`vue_${name}`, content?.[name] || content?._computedWatchers?.[name]?.value);
  }
  return { context, sources, error: sources.length ? null : "PAGE_RAW_UNAVAILABLE" };
}

function cardKey(card) { return `${card.pageScope}:${card.identity.kind}:${card.identity.value}`; }
function cardSignature(cards) { return JSON.stringify(cards.map(card => [cardKey(card), card.name, card.attributes])); }

function rawMatchesCard(raw, card) {
  if (!raw || typeof raw !== "object" || !getSnapshotCandidateGeekIds(raw).includes(card.identity.value)) return false;
  const parsed = parseGeek(raw);
  if (card.name && normalizeText(parsed.name) !== normalizeText(card.name)) return false;
  const securityId = card.attributes?.["data-securityid"];
  return !securityId || parsed.securityId === securityId;
}

function candidateFromCard(card, state) {
  let selected;
  for (const source of state.sources || []) {
    const matches = source.values.filter(raw => rawMatchesCard(raw, card));
    if (!matches.length) continue;
    const distinct = new Set(matches.map(raw => JSON.stringify(raw)));
    if (distinct.size > 1) throw page.fail("LIST_ID_AMBIGUOUS");
    selected = { raw: matches[0], source: source.source };
    break;
  }
  const raw = selected ? structuredClone(selected.raw) : null;
  const parsed = parseGeek(raw, card.order + 1, card.identity.value);
  return {
    ...parsed,
    name: raw ? parsed.name : card.name,
    ref: structuredClone(card),
    context: state.context || null,
    raw,
    list: selected ? { status: "collected", source: selected.source } : { status: "unavailable", reason: state.error || "CARD_RAW_NOT_FOUND" },
    detail: { status: "not_requested" }
  };
}

async function readSnapshot(session) {
  await session.check();
  const before = await page.readVisibleCards(session);
  const state = await session.evaluate(`(${readPageState.toString()})()`);
  if (!state || !Array.isArray(state.sources)) throw page.fail("PAGE_STATE_INVALID");
  const after = await page.readVisibleCards(session);
  if (cardSignature(before) !== cardSignature(after)) throw page.fail("LIST_CHANGED_DURING_READ");
  if (new Set(after.map(cardKey)).size !== after.length) throw page.fail("LIST_ID_AMBIGUOUS");
  return {
    pageScope: after[0]?.pageScope || await page.readPageScope(session),
    context: state.context || null,
    candidates: after.map(card => candidateFromCard(card, state))
  };
}

async function assertCandidateContext(session, candidate) {
  if (!candidate?.ref?.identity?.value) throw page.fail("CANDIDATE_ID_REQUIRED");
  const cards = await page.readVisibleCards(session);
  const matches = cards.filter(card => cardKey(card) === cardKey(candidate.ref));
  if (matches.length !== 1) throw page.fail("CANDIDATE_CARD_NOT_FOUND");
  if (candidate.ref.name !== matches[0].name) throw page.fail("CANDIDATE_NAME_CHANGED");
  if (candidate.context) {
    const state = await session.evaluate(`(${readPageState.toString()})()`);
    if (JSON.stringify(state?.context) !== JSON.stringify(candidate.context)) throw page.fail("CANDIDATE_CONTEXT_CHANGED");
  }
}

module.exports = { readPageState, cardKey, rawMatchesCard, candidateFromCard, readSnapshot, assertCandidateContext };
