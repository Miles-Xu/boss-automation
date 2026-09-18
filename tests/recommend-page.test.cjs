"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dom = require("../src/browser/dom.cjs");
const { getRecommendDocument, readVisibleCards, openCandidate, closeDetail, scrollList } = require("../src/recommend/page.cjs");

function mockPage(overrides = {}) {
  const state = {
    frame: true, detail: false, closeWorks: true, ids: ["synthetic-user-a", "synthetic-user-b"],
    scope: "featured", clicks: [], wheel: false, wheelEvents: [], scrollWorks: true, scrollDelayMs: 0,
    openDelayMs: 0, openWorks: true, openRequested: false, elapsedAfterWheel: 0, elapsedAfterOpen: 0, sleeps: [], ...overrides
  };
  const idFor = index => 20 + index * 3;
  const client = {
    DOM: {
      getDocument: async () => ({ root: { nodeId: 1 } }),
      describeNode: async () => ({ node: { contentDocument: { nodeId: 3 } } }),
      querySelector: async ({ nodeId, selector }) => {
        if (nodeId === 1 && selector === 'iframe[name="recommendFrame"]') return { nodeId: state.frame ? 2 : 0 };
        for (let i = 0; i < state.ids.length; i++) {
          if (nodeId !== idFor(i)) continue;
          if (selector === "a[data-geekid]" || selector === ".card-inner[data-geekid]" || selector === ".card-inner[data-geek], [data-geek]") return { nodeId: idFor(i) + 1 };
          if (selector === ".geek-name-wrap .name") return { nodeId: idFor(i) + 2 };
        }
        return { nodeId: 0 };
      },
      querySelectorAll: async ({ nodeId, selector }) => {
        if (nodeId === 3 && selector === "li.tab-item[data-status]") return { nodeIds: [10] };
        if (nodeId === 3 && selector === { featured: "li.geek-info-card", recommend: "ul.card-list > li.card-item", latest: ".candidate-card-wrap" }[state.scope]) return { nodeIds: state.ids.map((_, i) => idFor(i)) };
        if (nodeId === 1 && selector === ".resume-item-detail" && state.detail) return { nodeIds: [90] };
        if (nodeId === 90 && selector === ".close-btn" && state.detail) return { nodeIds: [91] };
        return { nodeIds: [] };
      },
      getAttributes: async ({ nodeId }) => {
        if (nodeId === 10) return { attributes: ["data-status", { featured: "3", recommend: "0", latest: "1" }[state.scope], "class", "tab-item curr"] };
        const index = state.ids.findIndex((_, i) => nodeId === idFor(i) + 1);
        if (index >= 0) return { attributes: [state.scope === "latest" ? "data-geek" : "data-geekid", state.ids[index], "data-suid", `synthetic-security-${index}`] };
        return { attributes: [] };
      },
      getOuterHTML: async () => ({ outerHTML: "<span>合成人选</span>" }),
      getBoxModel: async ({ nodeId }) => ({ model: { border: [nodeId * 10, 0, nodeId * 10 + 8, 0, nodeId * 10 + 8, 10, nodeId * 10, 10] } }),
      scrollIntoViewIfNeeded: async () => {}
    },
    Input: {
      dispatchMouseEvent: async event => {
        if (event.type === "mouseReleased") {
          const id = Math.round((event.x - 4) / 10);
          state.clicks.push(id);
          if (id === 91 && state.closeWorks) { state.detail = false; state.openRequested = false; }
          if (state.ids.some((_, i) => id === idFor(i) + 1)) {
            state.openRequested = true;
            if (state.openWorks && state.openDelayMs === 0) state.detail = true;
          }
        }
        if (event.type === "mouseWheel") {
          state.wheel = true;
          state.wheelEvents.push(event);
          if (state.scrollWorks && state.scrollDelayMs === 0) state.ids = ["synthetic-user-b", "synthetic-user-c"];
        }
      },
      dispatchKeyEvent: async event => { if (event.type === "keyUp" && state.closeWorks) { state.detail = false; state.openRequested = false; } }
    }
  };
  const session = {
    client,
    assertActive() {},
    async check() {},
    async sleep(ms) {
      state.sleeps.push(ms);
      if (state.wheel) {
        state.elapsedAfterWheel += ms;
        if (state.scrollWorks && state.elapsedAfterWheel >= state.scrollDelayMs) state.ids = ["synthetic-user-b", "synthetic-user-c"];
      }
      if (state.openRequested) {
        state.elapsedAfterOpen += ms;
        if (state.openWorks && state.elapsedAfterOpen >= state.openDelayMs) state.detail = true;
      }
    }
  };
  dom.bindSessionClient(client, session);
  return { session, state };
}

test("unknown iframe never falls back to an unrelated iframe", async () => {
  const { session } = mockPage({ frame: false });
  await assert.rejects(getRecommendDocument(session), { code: "NO_RECOMMEND_IFRAME" });
});

test("featured card identity retains the DOM namespace and exact order", async () => {
  const { session } = mockPage();
  const cards = await readVisibleCards(session);
  assert.deepEqual(cards.map(card => card.identity), [{ kind: "dom:data-geekid", value: "synthetic-user-a" }, { kind: "dom:data-geekid", value: "synthetic-user-b" }]);
  assert.deepEqual(cards.map(card => card.order), [0, 1]);
  assert.equal(cards[0].pageScope, "featured");
  assert.equal(cards[0].attributes["data-suid"], "synthetic-security-0");
});

test("open re-resolves cards and refuses duplicated IDs before clicking", async () => {
  const { session, state } = mockPage();
  const candidate = (await readVisibleCards(session))[0];
  state.ids = ["synthetic-user-a", "synthetic-user-a"];
  await assert.rejects(openCandidate(session, candidate), { code: "CANDIDATE_ID_AMBIGUOUS" });
  assert.deepEqual(state.clicks, []);
});

test("open refuses source change even if a same ID exists", async () => {
  const { session, state } = mockPage();
  const candidate = (await readVisibleCards(session))[0];
  state.scope = "recommend";
  await assert.rejects(openCandidate(session, candidate), { code: "CANDIDATE_PAGE_CHANGED" });
  assert.deepEqual(state.clicks, []);
});

test("open uses fresh candidate node and detects top-level detail", async () => {
  const { session, state } = mockPage();
  const candidate = (await readVisibleCards(session))[0];
  state.ids.reverse();
  const opened = await openCandidate(session, candidate);
  assert.deepEqual(state.clicks, [24]);
  assert.equal(opened.candidate.identity.value, candidate.identity.value);
  assert.equal(opened.detail.scope, "top");
  assert.equal((await closeDetail(session)).closed, true);
  assert.equal(state.detail, false);
});

test("close fails if popup persists despite available candidate list", async () => {
  const { session } = mockPage({ detail: true, closeWorks: false });
  await assert.rejects(closeDetail(session), { code: "DETAIL_CLOSE_UNCONFIRMED" });
});

test("a disappearing recommend frame is not confirmation that detail closed", async () => {
  const { session } = mockPage({ detail: true, frame: false });
  await assert.rejects(closeDetail(session), { code: "NO_RECOMMEND_IFRAME" });
});

test("failed box lookup is not confirmation that the detail disappeared", async () => {
  const { session } = mockPage({ detail: true });
  session.client.DOM.getBoxModel = async () => { throw new Error("CDP connection closed"); };
  await assert.rejects(closeDetail(session), /CDP connection closed/);
});

test("malformed geometry cannot confirm a closed detail", async () => {
  for (const model of [{}, { border: [] }, { border: [0, 0, 8] },
    { border: [0, 0, NaN, 0, 8, 10, 0, 10] },
    { border: [0, 0, "8", 0, 8, 10, 0, 10] }]) {
    const { session, state } = mockPage({ detail: true });
    session.client.DOM.getBoxModel = async () => ({ model });
    await assert.rejects(closeDetail(session), { code: "PAGE_GEOMETRY_INVALID" });
    assert.deepEqual(state.clicks, []);
  }
});

test("visibility checks do not issue protocol calls after cancellation", async () => {
  const { hasBox } = require("../src/recommend/page.cjs");
  let calls = 0;
  const session = {
    assertActive() { throw Object.assign(new Error("aborted"), { code: "ABORTED" }); },
    client: { DOM: { getBoxModel: async () => { calls++; return { model: {} }; } } }
  };
  await assert.rejects(hasBox(session, 1), { code: "ABORTED" });
  assert.equal(calls, 0);
});

test("scroll sees virtual list progress with the same rendered card count", async () => {
  const { session } = mockPage();
  const result = await scrollList(session);
  assert.equal(result.before.length, result.after.length);
  assert.equal(result.changed, true);
  assert.equal(Object.hasOwn(result, "reachedBottom"), false);
});

test("scroll waits for slow list updates without issuing another gesture", async () => {
  const { session, state } = mockPage({ scrollDelayMs: 2000 });
  const result = await scrollList(session, { timeoutMs: 3000, intervalMs: 250, deltaY: 480 });
  assert.equal(result.changed, true);
  assert.equal(state.wheelEvents.length, 1);
  assert.equal(state.wheelEvents[0].deltaY, 480);
  assert.ok(state.elapsedAfterWheel >= 2000);
  assert.deepEqual(result.after.map(card => card.identity.value), ["synthetic-user-b", "synthetic-user-c"]);
});

test("scroll returns unchanged when its polling budget expires", async () => {
  const { session, state } = mockPage({ scrollWorks: false });
  const result = await scrollList(session, { timeoutMs: 1000, intervalMs: 250 });
  assert.equal(result.changed, false);
  assert.deepEqual(result.after, result.before);
  assert.equal(state.wheelEvents.length, 1);
  assert.ok(state.sleeps.length <= 4);
});

test("opening a detail accepts a longer page wait and clicks only once", async () => {
  const { session, state } = mockPage({ openDelayMs: 5500 });
  const candidate = (await readVisibleCards(session))[0];
  const result = await openCandidate(session, candidate, { timeoutMs: 6500, intervalMs: 500 });
  assert.equal(result.detail.closed, false);
  assert.deepEqual(state.clicks, [21]);
  assert.ok(state.elapsedAfterOpen >= 5500);
});

test("opening a detail stops within the supplied polling budget", async () => {
  const { session, state } = mockPage({ openWorks: false });
  const candidate = (await readVisibleCards(session))[0];
  await assert.rejects(openCandidate(session, candidate, { timeoutMs: 500, intervalMs: 250 }), { code: "DETAIL_OPEN_TIMEOUT" });
  assert.deepEqual(state.clicks, [21]);
  assert.ok(state.elapsedAfterOpen <= 500);
});

test("invalid wait and scroll options fail before interacting with the page", async () => {
  const { session, state } = mockPage();
  const candidate = (await readVisibleCards(session))[0];
  for (const options of [{ timeoutMs: -1 }, { timeoutMs: Infinity }, { intervalMs: 0 }, { intervalMs: NaN }]) {
    await assert.rejects(openCandidate(session, candidate, options), RangeError);
    await assert.rejects(scrollList(session, options), RangeError);
  }
  for (const deltaY of [0, -1, Infinity, "720"]) await assert.rejects(scrollList(session, { deltaY }), RangeError);
  assert.deepEqual(state.clicks, []);
  assert.deepEqual(state.wheelEvents, []);
});
