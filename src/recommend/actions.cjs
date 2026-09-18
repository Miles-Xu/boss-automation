"use strict";

const dom = require("../browser/dom.cjs");
const page = require("./page.cjs");
const { parseGeek, normalizeText, hasResumeDetailPayload, resumeDetailIdentityMatches } = require("../candidate-profile.cjs");
const { rawMatchesCard } = require("./snapshot.cjs");

const FAVORITE_SELECTORS = [".like-icon-and-text", ".resume-footer.item-operate [class*=collect]", ".resume-footer-wrap [class*=favorite]"];
const GREET_SELECTORS = ["button.btn-v2.btn-sure-v2.btn-greet", "button.btn-v2.position-rights.btn-sure-v2", "button.btn-v2.btn-sure-v2.position-rights", ".resume-footer.item-operate button", ".resume-footer-wrap button"];
const QUOTA_PATTERNS = [
  /(?:打招呼|沟通|联系).{0,12}(?:次数|名额|额度|权益).{0,8}(?:已用完|用尽|不足|不够|已达上限|达到上限|为0)/,
  /(?:今日|今天|本日|当天).{0,10}(?:打招呼|沟通|联系).{0,12}(?:已用完|用尽|不足|不够|已达上限|达到上限)/,
  /(?:去充值|立即充值|购买次数|购买沟通|获取更多沟通|开通.{0,8}畅聊|升级.{0,8}VIP|充值后继续)/,
  /(?:余额不足|权益不足|暂无沟通权益|沟通权益不足|无法继续沟通)/
];

function actionResult(action, status, extra = {}) {
  return { action, status, ...extra };
}

function validateCandidate(candidate) {
  const ref = candidate?.ref;
  const expectedKind = ref?.pageScope === "latest" ? "dom:data-geek" : "dom:data-geekid";
  if (!ref || !["recommend", "latest", "featured"].includes(ref.pageScope)
    || ref.identity?.kind !== expectedKind || typeof ref.identity?.value !== "string" || !ref.identity.value
    || typeof ref.name !== "string" || candidate?.list?.status !== "collected"
    || !candidate.raw || typeof candidate.raw !== "object" || Array.isArray(candidate.raw)
    || !candidate.context || !["jobs", "jobLabel", "tabs", "filters"].every(key => Array.isArray(candidate.context[key]))) {
    throw page.fail("ACTION_CANDIDATE_INVALID");
  }
  const canonical = parseGeek(candidate.raw, 0, ref.identity.value);
  if (!rawMatchesCard(candidate.raw, ref) || !canonical.securityId
    || candidate.securityId !== canonical.securityId
    || normalizeText(candidate.name) !== normalizeText(canonical.name)) throw page.fail("ACTION_CANDIDATE_IDENTITY_MISMATCH");
  return canonical;
}

function trackDetailChanges(session) {
  let armed = false;
  let changed = false;
  let sequence = 0;
  let lastNavigation = 0;
  let latestRequest = null;
  const requests = new Map();
  const onRequest = event => {
    try {
      const url = new URL(event.request?.url);
      if (["zhipin.com", "www.zhipin.com"].includes(url.hostname) && /\/geek\/info\/?$/.test(url.pathname)) {
        latestRequest = { requestId: event.requestId, securityId: url.searchParams.get("securityId"), sequence: ++sequence, finished: 0 };
        requests.set(event.requestId, latestRequest);
        if (armed) changed = true;
      }
    } catch {}
  };
  const onFinished = event => { const request = requests.get(event.requestId); if (request) request.finished = ++sequence; };
  const onNavigation = () => { lastNavigation = ++sequence; if (armed) changed = true; };
  session.client.on("Network.requestWillBeSent", onRequest);
  session.client.on("Network.loadingFinished", onFinished);
  session.client.on("Page.frameNavigated", onNavigation);
  return {
    arm(binding) {
      armed = true;
      if (!latestRequest || latestRequest.requestId !== binding?.requestId
        || latestRequest.securityId !== binding?.requestSecurityId || !latestRequest.finished
        || lastNavigation > latestRequest.finished) throw page.fail("CANDIDATE_DETAIL_CHANGED");
    },
    assertCurrent() { if (changed) throw page.fail("CANDIDATE_DETAIL_CHANGED"); },
    close() {
      session.client.removeListener("Network.requestWillBeSent", onRequest);
      session.client.removeListener("Network.loadingFinished", onFinished);
      session.client.removeListener("Page.frameNavigated", onNavigation);
    }
  };
}

async function visibleNodes(session, rootNodeId, selectors) {
  const ids = new Set();
  for (const selector of selectors) {
    for (const id of await dom.querySelectorAll(session.client, rootNodeId, selector)) {
      if (await page.hasBox(session, id)) ids.add(id);
    }
  }
  return [...ids];
}

async function readActionState(session, binding, action) {
  const selectors = action === "favorite" ? FAVORITE_SELECTORS : GREET_SELECTORS;
  const states = [];
  for (const nodeId of await visibleNodes(session, binding.context.signalNodeId, selectors)) {
    const attributes = await dom.getAttributes(session.client, nodeId);
    const labelId = await dom.querySelector(session.client, nodeId, ".btn-text");
    const label = page.outerText(await dom.getOuterHTML(session.client, labelId || nodeId));
    const disabled = Object.hasOwn(attributes, "disabled") || attributes["aria-disabled"] === "true" || /\bdisabled\b/.test(attributes.class || "");
    if (action === "favorite") {
      if (/不感兴趣|不合适|屏蔽|拉黑/.test(label)) continue;
      const icon = await dom.querySelector(session.client, nodeId, ".like-icon.like-icon-active");
      const active = Boolean(icon) || /^(?:已收藏|已感兴趣)$/.test(label) || /\b(?:active|curr|current|selected|checked)\b/.test(attributes.class || "");
      const inactive = /^(?:收藏|感兴趣)$/.test(label) && !active;
      if (active || inactive) states.push({ nodeId, label, disabled, alreadyDone: active });
    } else {
      const alreadyDone = /^(?:继续沟通|已沟通)$/.test(label);
      const available = /^(?:打招呼|聊一聊|立即沟通)$/.test(label);
      if (alreadyDone || available) states.push({ nodeId, label, disabled, alreadyDone });
    }
  }
  if (states.length > 1) return { unsupported: true, reason: "ACTION_CONTROL_AMBIGUOUS" };
  if (!states.length) return { unsupported: true, reason: "ACTION_CONTROL_UNSUPPORTED" };
  return states[0];
}

async function checkNotices(session) {
  const { rootNodeId, docNodeId } = await page.getRecommendDocument(session);
  for (const root of [rootNodeId, docNodeId]) {
    const nodes = await visibleNodes(session, root, [".dialog-wrap.active", ".ui-dialog-wrap", ".ui-dialog", ".boss-dialog", "button.btn-v2.btn-sure-v2", "button.btn"]);
    for (const nodeId of nodes) {
      const text = page.outerText(await dom.getOuterHTML(session.client, nodeId)).replace(/\s+/g, "");
      if (text === "知道了") throw page.fail("PAGE_NOTICE_OPEN");
      if (QUOTA_PATTERNS.some(pattern => pattern.test(text))) throw page.fail("GREET_QUOTA_EXHAUSTED");
    }
  }
}

async function assertBound(session, binding, tracker) {
  session.assertActive();
  tracker.assertCurrent();
  const node = await dom.describeNode(session.client, binding.context.signalNodeId, 0);
  if (node.backendNodeId !== binding.backendNodeId || !await page.hasBox(session, binding.context.signalNodeId)) throw page.fail("CANDIDATE_DETAIL_CHANGED");
  if (await page.readPageScope(session) !== binding.candidate.ref.pageScope) throw page.fail("CANDIDATE_PAGE_CHANGED");
  tracker.assertCurrent();
}

async function clickOnce(session, binding, tracker, state, action, onPress) {
  await session.check();
  await assertBound(session, binding, tracker);
  await dom.scrollIntoView(session.client, state.nodeId);
  const point = await dom.getBoxCenter(session.client, state.nodeId);
  await assertBound(session, binding, tracker);
  await session.client.Input.dispatchMouseEvent({ type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await session.sleep(60);
  await assertBound(session, binding, tracker);
  const current = await readActionState(session, binding, action);
  if (current.unsupported || current.disabled || current.nodeId !== state.nodeId) throw page.fail("ACTION_CONTROL_CHANGED");
  if (current.alreadyDone) return { alreadyDone: true, label: current.label };
  tracker.assertCurrent();
  onPress();
  await session.client.Input.dispatchMouseEvent({ type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await session.sleep(60);
  await assertBound(session, binding, tracker);
  await session.client.Input.dispatchMouseEvent({ type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  return { alreadyDone: false };
}

async function perform(session, candidate, action, { timeoutMs = 3600, intervalMs = 300, detailTimeoutMs = 10000 } = {}) {
  for (const [name, value] of Object.entries({ timeoutMs, intervalMs, detailTimeoutMs })) {
    if (!Number.isFinite(value) || value < 1 || value > 2147483647) throw new RangeError(`${name} must be 1..2147483647`);
  }
  const canonical = validateCandidate(candidate);
  return session.run(async () => {
    const tracker = trackDetailChanges(session);
    let binding;
    let result;
    let pressed = false;
    let primaryError;
    try {
      binding = await require("./collector.cjs").ensureOpenDetail(session, candidate, { timeoutMs: detailTimeoutMs, intervalMs });
      tracker.arm(binding);
      if (binding?.identityVerified !== true || !binding.context?.signalNodeId || !binding.candidate?.ref) throw page.fail("DETAIL_IDENTITY_UNVERIFIED");
      if (binding.requestSecurityId !== canonical.securityId || !hasResumeDetailPayload(binding.payload)
        || !resumeDetailIdentityMatches(canonical, binding.payload, binding.requestSecurityId)) throw page.fail("DETAIL_IDENTITY_UNVERIFIED");
      const node = await dom.describeNode(session.client, binding.context.signalNodeId, 0);
      if (!Number.isInteger(node.backendNodeId)) throw page.fail("DETAIL_CONTEXT_UNAVAILABLE");
      binding.backendNodeId = node.backendNodeId;
      await session.check();
      await assertBound(session, binding, tracker);
      await checkNotices(session);
      let state = await readActionState(session, binding, action);
      if (state.unsupported) {
        result = actionResult(action, "unsupported", { reason: state.reason });
      } else if (state.alreadyDone) {
        result = actionResult(action, "already_done", { evidence: state.label });
      } else {
        if (state.disabled) throw page.fail("ACTION_UNAVAILABLE", { action });
        // Re-read immediately before clicking: a stale favorite state can toggle it off.
        await assertBound(session, binding, tracker);
        state = await readActionState(session, binding, action);
        if (state.unsupported || state.disabled) throw page.fail("ACTION_CONTROL_CHANGED");
        if (state.alreadyDone) result = actionResult(action, "already_done", { evidence: state.label });
        else {
          const clicked = await clickOnce(session, binding, tracker, state, action, () => { pressed = true; });
          if (clicked.alreadyDone) result = actionResult(action, "already_done", { evidence: clicked.label });
          const deadline = Date.now() + timeoutMs;
          for (let attempt = 0; attempt <= Math.ceil(timeoutMs / intervalMs); attempt++) {
            if (result) break;
            await session.check();
            await assertBound(session, binding, tracker);
            await checkNotices(session);
            const current = await readActionState(session, binding, action);
            if (!current.unsupported && current.alreadyDone) {
              result = actionResult(action, "performed", { evidence: current.label });
              break;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0 || attempt === Math.ceil(timeoutMs / intervalMs)) break;
            await session.sleep(Math.min(intervalMs, remaining));
          }
          result ||= actionResult(action, "unconfirmed", { reason: "ACTION_ACK_UNCONFIRMED" });
        }
      }
    } catch (error) {
      try { session.assertActive(); } catch (stopped) { primaryError = stopped; }
      if (!primaryError && pressed) result = actionResult(action, "unconfirmed", { reason: error.code || "ACTION_TRANSPORT_ERROR" });
      else primaryError ||= error;
    } finally {
      tracker.close();
      if (binding) {
        try {
          session.assertActive();
          await page.closeDetail(session);
        } catch (error) {
          if (primaryError) primaryError.cleanupError = error.code || error.message;
          else { error.actionResult = result || actionResult(action, pressed ? "unconfirmed" : "unsupported"); primaryError = error; }
        }
      }
    }
    if (primaryError) {
      if (pressed && !primaryError.actionResult) primaryError.actionResult = result || actionResult(action, "unconfirmed", { reason: primaryError.code || "ACTION_INTERRUPTED" });
      throw primaryError;
    }
    return result;
  });
}

function favoriteCandidate(session, candidate, options) { return perform(session, candidate, "favorite", options); }
function greetCandidate(session, candidate, options) { return perform(session, candidate, "greet", options); }

module.exports = { favoriteCandidate, greetCandidate };
