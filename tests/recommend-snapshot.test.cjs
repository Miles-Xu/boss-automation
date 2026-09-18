"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { readPageState, candidateFromCard, rawMatchesCard } = require("../src/recommend/snapshot.cjs");
const { recommendCandidate, featuredCandidate } = require("../fixtures/candidates.cjs");

function card(raw, order = 0) {
  return { pageScope: raw === featuredCandidate ? "featured" : "recommend", order,
    name: raw.geekCard.geekName, identity: { kind: "dom:data-geekid", value: raw.geekCard.encGeekId || raw.geekCard.encryptUserId }, attributes: {} };
}
const context = { jobs: ["synthetic-job"], jobLabel: ["Fixture role"], tabs: ["0"], filters: [] };

test("list data follows exact card identity rather than array index or shared name", () => {
  const refs = [card(featuredCandidate, 0), card(recommendCandidate, 1)];
  const state = { context, sources: [{ source: "vue_geekList", values: [recommendCandidate, featuredCandidate] }] };
  const results = refs.map(ref => candidateFromCard(ref, state));
  assert.deepEqual(results.map(result => result.raw), [featuredCandidate, recommendCandidate]);
  assert.deepEqual(results.map(result => result.bossOrder), [1, 2]);
  assert.equal(results[0].detail.status, "not_requested");
  results[0].raw.geekCard.geekName = "Changed copy";
  assert.equal(featuredCandidate.geekCard.geekName, "Fixture Person");
});

test("unmatched card stays unavailable, without fabricating an API record", () => {
  const ref = card(recommendCandidate);
  ref.identity.value = "synthetic-unknown";
  const result = candidateFromCard(ref, { sources: [{ source: "vue_geekList", values: [recommendCandidate] }] });
  assert.equal(result.raw, null);
  assert.equal(result.name, ref.name);
  assert.equal(result.list.status, "unavailable");
  assert.deepEqual(result.profile.workHistory, []);
});

test("names, explicit security tokens, and conflicting duplicate IDs are checked", () => {
  const ref = card(recommendCandidate);
  assert.equal(rawMatchesCard(recommendCandidate, { ...ref, name: "Other person" }), false);
  assert.equal(rawMatchesCard(recommendCandidate, { ...ref, attributes: { "data-securityid": "synthetic-other" } }), false);
  const collision = structuredClone(recommendCandidate);
  collision.geekCard.securityId = "synthetic-new-token";
  assert.throws(() => candidateFromCard(ref, { sources: [{ source: "vue_geekList", values: [recommendCandidate, collision] }] }), { code: "LIST_ID_AMBIGUOUS" });
});

test("page state reads raw Vue objects but never invents an index-to-card mapping", () => {
  const content = { $options: { name: "RecommendContent" }, geekList: [featuredCandidate, recommendCandidate] };
  const doc = {
    querySelector(selector) { return selector === ".recommend-wrap" ? { __vue__: { $children: [content] } } : null; },
    querySelectorAll() { return []; }
  };
  const result = vm.runInNewContext(`(${readPageState.toString()})()`, {
    URL, location: { href: "https://www.zhipin.com/web/chat/recommend" },
    document: { querySelectorAll() { return [{ src: "https://www.zhipin.com/web/frame/recommend/", contentDocument: doc }]; } }
  });
  assert.equal(result.sources[0].source, "vue_geekList");
  assert.equal(result.sources[0].values[0], featuredCandidate);
  assert.equal(result.sources[0].values[1], recommendCandidate);
});

function snapshotFixture(snapshots, pageState) {
  let index = 0;
  const filename = path.resolve(__dirname, "../src/recommend/snapshot.cjs");
  const realRequire = createRequire(filename);
  const page = {
    async readVisibleCards() { return snapshots[Math.min(index++, snapshots.length - 1)]; },
    async readPageScope() { return "recommend"; },
    fail(code) { return Object.assign(new Error(code), { code }); }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, structuredClone, require(name) { return name === "./page.cjs" ? page : realRequire(name); }
  });
  return { api: module.exports, session: { async check() {}, async evaluate() { return pageState; } } };
}

test("a list changing during extraction fails before attaching any raw data", async () => {
  const f = snapshotFixture([[card(recommendCandidate)], [card(featuredCandidate)]], { sources: [], context });
  await assert.rejects(f.api.readSnapshot(f.session), { code: "LIST_CHANGED_DURING_READ" });
});

test("duplicate rendered identities and changed job context are rejected", async () => {
  const refs = [card(recommendCandidate), card(recommendCandidate, 1)];
  const f = snapshotFixture([refs], { sources: [], context });
  await assert.rejects(f.api.readSnapshot(f.session), { code: "LIST_ID_AMBIGUOUS" });
  const g = snapshotFixture([[card(recommendCandidate)]], { sources: [], context: { ...context, jobs: ["synthetic-other-job"] } });
  await assert.rejects(g.api.assertCandidateContext(g.session, { ref: card(recommendCandidate), context }), { code: "CANDIDATE_CONTEXT_CHANGED" });
});

test("public entry import exposes no connection side effects", () => {
  const api = require("../src/index.cjs");
  assert.equal(typeof api.connect, "function");
  assert.equal(typeof api.scrollCandidates, "function");
  assert.equal(typeof api.startListCapture, "function");
  assert.equal(api.collectCandidates, undefined);
  assert.equal(typeof api.greetCandidate, "function");
  assert.equal(api.hasFullWorkExperienceText, undefined);
});
