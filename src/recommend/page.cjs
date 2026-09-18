"use strict";

const dom = require("../browser/dom.cjs");

const IFRAME_SELECTORS = ['iframe[name="recommendFrame"]', 'iframe[src*="/web/frame/recommend/"]'];
const PAGE_STATUS = { recommend: "0", latest: "1", featured: "3" };
const TAB_SELECTORS = ["li.tab-item[data-status]", 'li[data-status][class*="tab"]'];
const CARD_SELECTORS = {
  recommend: "ul.card-list > li.card-item",
  latest: ".candidate-card-wrap",
  featured: "li.geek-info-card"
};
const INNER_SELECTORS = {
  recommend: ".card-inner[data-geekid]",
  latest: ".card-inner[data-geek], [data-geek]",
  featured: "a[data-geekid]"
};
const POPUPS = [".boss-popup__wrapper", ".boss-popup_wrapper", ".boss-dialog_wrapper", ".dialog-wrap.active", ".boss-dialog", ".geek-detail-modal", ".resume-item-detail", ".boss-dialog__wrapper.dialog-lib-resume"];
const RESUME_FRAMES = ['iframe[src*="/web/frame/c-resume/"]', 'iframe[name*="resume"]'];
const DETAIL_SIGNALS = [...POPUPS, ...RESUME_FRAMES, ".resume-center-side", ".resume-detail-wrap", ".resume-section", ".resume-footer.item-operate", ".resume-footer-wrap"];
const CLOSE_SELECTORS = [".boss-popup__close", ".popup-close", ".modal-close", ".dialog-close", ".close-btn", 'button[aria-label*="关闭"]', 'button[title*="关闭"]', ".icon-close"];
const normalize = value => String(value ?? "").replace(/\s+/g, " ").trim();

function fail(code, detail = {}) {
  return Object.assign(new Error(code), { code, ...detail });
}

function validateWait(timeoutMs, intervalMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) throw new RangeError("timeoutMs must be between 0 and 2147483647");
  if (!Number.isFinite(intervalMs) || intervalMs < 1 || intervalMs > 2147483647) throw new RangeError("intervalMs must be between 1 and 2147483647");
}

async function pollPage(session, read, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  const attempts = Math.ceil(timeoutMs / intervalMs) + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await session.check();
    const result = await read();
    if (result) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0 || attempt + 1 === attempts) break;
    await session.sleep(Math.min(intervalMs, remaining));
  }
  return null;
}

function outerText(html) {
  return normalize(String(html || "").replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[\da-f]+|\d+);/gi, entity => {
    const named = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const value = entity.slice(2, -1);
    const number = value[0].toLowerCase() === "x" ? parseInt(value.slice(1), 16) : Number(value);
    return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  }));
}

async function getRecommendDocument(session) {
  session.assertActive();
  const root = await dom.getDocRoot(session.client);
  const frame = await dom.findIframeDoc(session.client, root.nodeId, IFRAME_SELECTORS);
  if (!frame) throw fail("NO_RECOMMEND_IFRAME");
  return { rootNodeId: root.nodeId, ...frame };
}

async function hasBox(session, nodeId) {
  session.assertActive();
  try {
    const { model } = await session.client.DOM.getBoxModel({ nodeId });
    session.assertActive();
    const q = model?.border?.length ? model.border : model?.content;
    if (!Array.isArray(q) || q.length !== 8 || !q.every(Number.isFinite)) throw fail("PAGE_GEOMETRY_INVALID");
    return Math.max(q[0], q[2], q[4], q[6]) - Math.min(q[0], q[2], q[4], q[6]) > 2
      && Math.max(q[1], q[3], q[5], q[7]) - Math.min(q[1], q[3], q[5], q[7]) > 2;
  } catch (error) {
    session.assertActive();
    if (/Could not compute box model|does not have a layout object|No layout/i.test(error?.message || "")) return false;
    throw error;
  }
}

async function readTabs(session) {
  const { docNodeId } = await getRecommendDocument(session);
  for (const selector of TAB_SELECTORS) {
    const ids = await dom.querySelectorAll(session.client, docNodeId, selector);
    if (!ids.length) continue;
    const tabs = [];
    for (const nodeId of ids) {
      const attrs = await dom.getAttributes(session.client, nodeId);
      tabs.push({ nodeId, status: attrs["data-status"], active: /\b(?:curr|current|active|selected)\b/.test(attrs.class || "") });
    }
    return tabs;
  }
  throw fail("PAGE_TABS_NOT_FOUND");
}

async function readPageScope(session) {
  const active = (await readTabs(session)).filter(tab => tab.active);
  if (active.length !== 1) throw fail("PAGE_SCOPE_AMBIGUOUS", { active });
  const scope = Object.keys(PAGE_STATUS).find(key => PAGE_STATUS[key] === active[0].status);
  if (!scope) throw fail("PAGE_SCOPE_UNSUPPORTED", { status: active[0].status });
  return scope;
}

async function selectPageScopeInternal(session, pageScope) {
  const tabs = await readTabs(session);
  const matches = tabs.filter(tab => tab.status === PAGE_STATUS[pageScope]);
  if (matches.length !== 1) throw fail("PAGE_SCOPE_NOT_FOUND", { pageScope });
  if (matches[0].active && tabs.filter(tab => tab.active).length === 1) return pageScope;
  await session.check();
  await dom.clickNode(session.client, matches[0].nodeId);
  for (let attempt = 0; attempt < 12; attempt++) {
    await session.sleep(180 + attempt * 60);
    const active = (await readTabs(session)).filter(tab => tab.active);
    if (active.length === 1 && active[0].status === PAGE_STATUS[pageScope]) return pageScope;
  }
  throw fail("PAGE_SCOPE_SWITCH_TIMEOUT", { pageScope });
}

async function selectPageScope(session, pageScope) {
  if (!Object.hasOwn(PAGE_STATUS, pageScope)) throw fail("PAGE_SCOPE_UNSUPPORTED", { pageScope });
  return session.run(() => selectPageScopeInternal(session, pageScope));
}

async function readVisibleCards(session) {
  const pageScope = await readPageScope(session);
  const { docNodeId } = await getRecommendDocument(session);
  const ids = await dom.querySelectorAll(session.client, docNodeId, CARD_SELECTORS[pageScope]);
  const cards = [];
  for (const nodeId of ids) {
    if (!await hasBox(session, nodeId)) continue;
    const clickNodeId = await dom.querySelector(session.client, nodeId, INNER_SELECTORS[pageScope]);
    if (!clickNodeId) throw fail("CANDIDATE_ID_MISSING", { pageScope, nodeId });
    const attrs = await dom.getAttributes(session.client, clickNodeId);
    const attribute = pageScope === "latest" ? "data-geek" : "data-geekid";
    const value = normalize(attrs[attribute]);
    if (!value) throw fail("CANDIDATE_ID_MISSING", { pageScope, nodeId });
    let name = "";
    for (const selector of [".geek-name-wrap .name", ".name-wrap .name", "span.name", ".name", ".geek-name"]) {
      const nameId = await dom.querySelector(session.client, nodeId, selector);
      if (nameId) name = outerText(await dom.getOuterHTML(session.client, nameId));
      if (name) break;
    }
    const attributes = {};
    for (const key of ["data-geekid", "data-geek", "data-suid", "data-securityid"]) {
      if (attrs[key]) attributes[key] = attrs[key];
    }
    cards.push({ pageScope, order: cards.length, nodeId, clickNodeId, name, identity: { kind: `dom:${attribute}`, value }, attributes });
  }
  return cards;
}

async function detailState(session) {
  // Check both documents: BOSS can render a resume over the top-level page.
  const context = await getRecommendDocument(session);
  const documents = [{ scope: "top", docNodeId: context.rootNodeId }, { scope: "recommend", docNodeId: context.docNodeId }];
  for (const doc of documents) {
    const buttons = await dom.querySelectorAll(session.client, doc.docNodeId, "button.btn-v2.btn-sure-v2, button.btn");
    for (const id of buttons) {
      if (outerText(await dom.getOuterHTML(session.client, id)) === "知道了" && await hasBox(session, id)) {
        throw fail("PAGE_NOTICE_OPEN");
      }
    }
    for (const selector of DETAIL_SIGNALS) {
      const ids = await dom.querySelectorAll(session.client, doc.docNodeId, selector);
      for (const nodeId of ids) {
        if (await hasBox(session, nodeId)) return { closed: false, ...context, ...doc, signalNodeId: nodeId, signalSelector: selector };
      }
    }
  }
  return { closed: true, ...context };
}

async function openCandidate(session, candidate, { timeoutMs = 5000, intervalMs = 250 } = {}) {
  validateWait(timeoutMs, intervalMs);
  const identity = candidate?.identity;
  if (!identity?.kind || !normalize(identity.value)) throw fail("CANDIDATE_ID_REQUIRED");
  if (!(await detailState(session)).closed) throw fail("DETAIL_ALREADY_OPEN");
  const pageScope = await readPageScope(session);
  if (candidate.pageScope !== pageScope) throw fail("CANDIDATE_PAGE_CHANGED");
  const cards = await readVisibleCards(session);
  const matches = cards.filter(card => card.identity.kind === identity.kind && card.identity.value === identity.value);
  if (matches.length !== 1) throw fail(matches.length ? "CANDIDATE_ID_AMBIGUOUS" : "CANDIDATE_CARD_NOT_FOUND");
  const current = matches[0];
  if (candidate.name && current.name !== candidate.name) throw fail("CANDIDATE_NAME_CHANGED");
  await session.check();
  await dom.clickNode(session.client, current.clickNodeId);
  const opened = await pollPage(session, async () => {
    const detail = await detailState(session);
    return detail.closed ? null : { candidate: current, detail };
  }, timeoutMs, intervalMs);
  if (opened) return opened;
  throw fail("DETAIL_OPEN_TIMEOUT");
}

async function closeDetail(session) {
  let state = await detailState(session);
  if (state.closed) return { closed: true, alreadyClosed: true };
  for (let attempt = 0; attempt < 4; attempt++) {
    await session.check();
    let clicked = false;
    for (const selector of CLOSE_SELECTORS) {
      const ids = await dom.querySelectorAll(session.client, state.signalNodeId, selector);
      for (const id of ids) {
        if (!await hasBox(session, id)) continue;
        await session.check();
        await dom.clickNode(session.client, id);
        clicked = true;
        break;
      }
      if (clicked) break;
    }
    if (!clicked) {
      for (const selector of [".boss-popup__wrapper .close-btn", ".boss-dialog__wrapper .close-btn", ".dialog-lib-resume .close-btn", ".resume-item-detail .close-btn", ".boss-popup__close"]) {
        const ids = await dom.querySelectorAll(session.client, state.docNodeId, selector);
        for (const id of ids) {
          if (!await hasBox(session, id)) continue;
          await session.check();
          await dom.clickNode(session.client, id);
          clicked = true;
          break;
        }
        if (clicked) break;
      }
    }
    if (!clicked) await dom.pressKey(session.client, "Escape", { code: "Escape", windowsVirtualKeyCode: 27 });
    await session.sleep(500);
    state = await detailState(session);
    if (state.closed) return { closed: true, alreadyClosed: false };
    await session.check();
    await dom.pressKey(session.client, "Escape", { code: "Escape", windowsVirtualKeyCode: 27 });
    await session.sleep(500);
    state = await detailState(session);
    if (state.closed) return { closed: true, alreadyClosed: false };
  }
  throw fail("DETAIL_CLOSE_UNCONFIRMED");
}

async function scrollList(session, { timeoutMs = 5000, intervalMs = 250, deltaY = 720 } = {}) {
  validateWait(timeoutMs, intervalMs);
  if (!Number.isFinite(deltaY) || deltaY <= 0) throw new RangeError("deltaY must be a positive finite number");
  if (!(await detailState(session)).closed) throw fail("DETAIL_ALREADY_OPEN");
  const before = await readVisibleCards(session);
  if (!before.length) return { before, after: [], changed: false };
  await session.check();
  await dom.scrollIntoView(session.client, before.at(-1).nodeId);
  const point = await dom.getBoxCenter(session.client, before.at(-1).nodeId);
  await session.check();
  await dom.wheelAt(session.client, point.x, point.y, deltaY);
  const signature = cards => cards.map(card => `${card.identity.kind}:${card.identity.value}`).join("|");
  const previous = signature(before);
  let after = before;
  const changed = await pollPage(session, async () => {
    after = await readVisibleCards(session);
    return previous !== signature(after);
  }, timeoutMs, intervalMs);
  return { before, after, changed: Boolean(changed) };
}

module.exports = { getRecommendDocument, readPageScope, readVisibleCards, openCandidate, closeDetail, scrollList, readTabs, selectPageScope, hasBox, outerText, fail };
