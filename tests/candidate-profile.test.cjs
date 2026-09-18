"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const profile = require("../src/candidate-profile.cjs");
const fixtures = require("../fixtures/candidates.cjs");

function frozenCopy(value) {
  const copy = structuredClone(value);
  function freeze(item) {
    if (!item || typeof item !== "object") return item;
    Object.values(item).forEach(freeze);
    return Object.freeze(item);
  }
  return freeze(copy);
}

test("recommend fields keep typed IDs, source order, and paragraphs", () => {
  const input = frozenCopy(fixtures.recommendCandidate);
  const candidate = profile.parseGeek(input, 3);
  assert.equal(candidate.bossOrder, 3);
  assert.equal(candidate.geekId, "synthetic-encrypted-geek-001");
  assert.deepEqual(candidate.listIdentity, {
    geekId: ["synthetic-geek-001"],
    encryptGeekId: ["synthetic-encrypted-geek-001"],
    encryptUserId: []
  });
  assert.equal(candidate.haveChatted, false);
  assert.equal(candidate.haveChattedRaw, "false");
  assert.equal(candidate.advantage, "Build reliable services.\nKeep original paragraphs.");
  assert.equal(candidate.profile.workHistory[0].responsibility, "List excerpt.\nSecond list paragraph.");
  assert.equal(candidate.profile.workHistory[0].period, "2025.01 - 2026.09");
  assert.deepEqual(candidate.profile.workHistory.map((entry) => entry.company), ["Fixture Systems", "Fixture Previous Company"]);
  assert.equal("legacyScreeningText" in candidate.profile.workHistory[0], false);
  assert.deepEqual(input, fixtures.recommendCandidate);
});

test("featured null arrays stay empty until a valid detail is acquired", () => {
  const candidate = profile.parseGeek(frozenCopy(fixtures.featuredCandidate));
  assert.deepEqual(candidate.listIdentity, {
    geekId: [],
    encryptGeekId: [],
    encryptUserId: ["synthetic-encrypted-user-002"]
  });
  assert.deepEqual(candidate.profile.workHistory, []);
  assert.deepEqual(candidate.profile.education, []);
  assert.equal(candidate.sourceGeekIds.includes("0"), false);
  assert.equal(profile.getSnapshotCandidateGeekId({ geekId: 0, securityId: "synthetic-real-key" }), "synthetic-real-key");
  assert.equal(profile.hasResumeDetailPayload(fixtures.featuredCandidate), false);
  assert.equal(profile.hasResumeDetailPayload(fixtures.featuredResumeDetail), true);
});

test("aliases retain workList and structured fallback labels", () => {
  const candidate = profile.parseGeek(frozenCopy({
    geekCard: {
      geekWorks: null,
      workList: [{ name: "Role | Synthetic Company", responsibility: "Source text." }],
      geekEdus: [{ name: "Synthetic School·Synthetic Major", degreeName: "本科" }]
    }
  }));
  assert.equal(candidate.profile.workHistory[0].company, "Synthetic Company");
  assert.equal(candidate.profile.workHistory[0].role, "Role");
  assert.equal(candidate.profile.education[0].school, "Synthetic School");
  assert.equal(candidate.profile.education[0].major, "Synthetic Major");
});

test("a same-type conflict rejects detail even with matching securityId or another ID", () => {
  const candidate = frozenCopy(profile.parseGeek(fixtures.recommendCandidate));
  const detail = structuredClone(fixtures.recommendResumeDetail);
  assert.equal(profile.resumeDetailIdentityMatches(candidate, frozenCopy(detail)), true);
  detail.geekDetail.geekBaseInfo.geekId = "synthetic-someone-else";
  assert.equal(profile.resumeDetailIdentityMatches(candidate, frozenCopy(detail), candidate.securityId), false);
  assert.equal(profile.resumeDetailIdentityMatches(candidate, fixtures.recommendResumeDetail, "unrelated-request-id"), false);
});

test("featured different ID types require the original request securityId when the response token changes", () => {
  const candidate = frozenCopy(profile.parseGeek(fixtures.featuredCandidate));
  const detail = frozenCopy(fixtures.featuredResumeDetail);
  assert.equal(profile.resumeDetailIdentityMatches(candidate, detail), false);
  assert.equal(profile.resumeDetailIdentityMatches(candidate, detail, candidate.geekId), false);
  assert.equal(profile.resumeDetailIdentityMatches(candidate, detail, candidate.securityId), true);
  assert.equal(profile.resumeDetailIdentityMatches(candidate, detail, detail.geekDetail.securityId), false);
});

test("a long encrypted ID cannot stand in for a missing securityId", () => {
  const longId = "synthetic-user-" + "x".repeat(90);
  const candidate = profile.parseGeek({ geekCard: { encryptUserId: longId, geekName: "Fixture Person" } });
  assert.equal(profile.getCandidateSecurityId(candidate), "");
  assert.equal(profile.resumeDetailIdentityMatches(candidate, fixtures.featuredResumeDetail, longId), false);
  assert.equal(profile.getCandidateSecurityId({ ...candidate, securityId: "synthetic-explicit-token" }), "synthetic-explicit-token");
});

test("equal strings in different ID namespaces and equal names do not establish identity", () => {
  const candidate = frozenCopy(profile.parseGeek(fixtures.featuredCandidate));
  const payload = {
    geekDetail: {
      geekBaseInfo: { encryptGeekId: candidate.listIdentity.encryptUserId[0], name: candidate.name },
      geekWorkExpList: []
    }
  };
  assert.equal(profile.resumeDetailIdentityMatches(candidate, frozenCopy(payload)), false);
  assert.equal(profile.resumeDetailIdentityMatches(candidate, fixtures.recommendResumeDetail), false);
});

test("an identity-free response only uses request linkage when names do not conflict", () => {
  const candidate = frozenCopy(profile.parseGeek(fixtures.featuredCandidate));
  assert.equal(profile.resumeDetailIdentityMatches(candidate, fixtures.emptyResumeDetail), false);
  assert.equal(profile.resumeDetailIdentityMatches(candidate, fixtures.emptyResumeDetail, candidate.securityId), true);
  assert.equal(profile.resumeDetailIdentityMatches(candidate, {
    geekDetail: { geekBaseInfo: { name: "Other Synthetic Person" }, geekWorkExpList: [] }
  }, candidate.securityId), false);
});

test("empty source sections are distinct from absent or text-only detail", () => {
  assert.equal(profile.hasResumeDetailPayload(frozenCopy(fixtures.emptyResumeDetail)), true);
  for (const value of [null, {}, [], { geekDetail: {} }, { resumeText: "Synthetic text" }, { geekDetail: { geekWorkExpList: null } }, { geekDetail: { geekBaseInfo: [] } }]) {
    assert.equal(profile.hasResumeDetailPayload(value), false);
  }
  const candidate = profile.parseGeek(fixtures.featuredCandidate);
  assert.equal(profile.applyResumeDetailToCandidate(candidate, { payload: fixtures.emptyResumeDetail }), true);
  assert.deepEqual(candidate.profile.workHistory, []);
  assert.equal(candidate.resumeText, "");
  const missing = profile.parseGeek(fixtures.featuredCandidate);
  assert.equal(profile.applyResumeDetailToCandidate(missing, {}), false);
});

test("detail merge enriches the candidate in place without changing raw payload", () => {
  const candidate = profile.parseGeek(fixtures.recommendCandidate);
  const raw = frozenCopy(fixtures.recommendResumeDetail);
  const candidateInfo = profile.getCandidateInfoFromResumePayload(raw);
  assert.equal(profile.applyResumeDetailToCandidate(candidate, {
    payload: raw,
    candidateInfo,
    source: "api-detail"
  }), true);
  const first = candidate.profile.workHistory[0];
  assert.equal(first.responsibility, "First responsibility paragraph.\nSecond responsibility paragraph.\nA separate work-content field.");
  assert.equal(first.performance, "Reduced synthetic queue latency by 12%.\nA separate performance field.");
  assert.equal(first.description, "A detailed description.\nA separate work-description field.\nA supplementary note.");
  assert.deepEqual(first.techTags, ["Node.js", "SQL"]);
  assert.deepEqual(candidate.profile.workHistory.map((entry) => entry.company), ["Fixture Systems", "Fixture Internship", "Fixture Previous Company"]);
  assert.equal(candidate.profile.education.length, 1);
  assert.equal(candidate.profile.education[0].description, "Education paragraph one.\nEducation paragraph two.");
  assert.deepEqual(candidate.profile.education[0].courses, ["Distributed systems", "Compilers"]);
  assert.equal(candidate.profile.projects[0].responsibility, "Implemented retry handling.");
  assert.deepEqual(candidate.skills, ["Node.js (熟练)"]);
  assert.deepEqual(candidate.certifications, ["Synthetic certificate"]);
  assert.equal(candidate.resumeSource, "api-detail");
  assert.equal(candidate.resumeDetail, raw);
  assert.equal(candidate.resumeDetail.geekDetail.geekWorkExpList[0].department, "Synthetic platform team");
  assert.equal(candidate.resumeDetail.geekDetail.professionalSkill, "Synthetic free-text professional skill.");
  assert.equal(candidate.resumeDetail.geekDetail.geekHonorList[0].honorName, "Synthetic award");
  assert.equal(candidate.freshGraduate, false);
  assert.deepEqual(raw, fixtures.recommendResumeDetail);
});

test("same employer with conflicting periods or ambiguous list entries never borrows fields", () => {
  const existing = frozenCopy([
    { company: "Synthetic Company", role: "Engineer", period: "2022 - 2023", responsibility: "Old role" },
    { company: "Synthetic Company", role: "Engineer", period: "2024 - 2025", responsibility: "New role" }
  ]);
  const conflict = frozenCopy([{ company: "Synthetic Company", role: "Engineer", period: "2026 - 2027", responsibility: "" }]);
  const conflictResult = profile.mergeWorkHistories(existing, conflict);
  assert.equal(conflictResult.length, 3);
  assert.equal(conflictResult[0].responsibility, "");
  const ambiguous = profile.mergeWorkHistories(existing, frozenCopy([{ company: "Synthetic Company", role: "Engineer", period: "", responsibility: "" }]));
  assert.equal(ambiguous.length, 3);
  assert.equal(ambiguous[0].responsibility, "");
  assert.equal(existing[0].responsibility, "Old role");
});

test("formatted resume preserves paragraphs and contains source facts without screening policy", () => {
  const raw = frozenCopy(fixtures.recommendResumeDetail);
  const formatted = profile.formatResumeApiData(raw);
  assert.match(formatted, /First responsibility paragraph\.\nSecond responsibility paragraph\./);
  assert.match(formatted, /A separate work-content field\./);
  assert.match(formatted, /Implemented retry handling\./);
  assert.match(formatted, /Education paragraph one\.\nEducation paragraph two\./);
  assert.match(formatted, /Synthetic source notice\./);
  assert.doesNotMatch(formatted, /硬判|判定忽略|淘汰|结构化判定|softRisks|redFlags|legacyScreeningText/);
  assert.deepEqual(raw, fixtures.recommendResumeDetail);
  assert.equal(profile.formatResumeApiData(fixtures.emptyResumeDetail), "");
  assert.doesNotMatch(profile.formatResumeApiData({ geekDetail: { geekBaseInfo: { gender: 0 } } }), /性别/);
});

test("encoded angle brackets survive formatting and repeated detail merging", () => {
  const text = "std::vector&lt;int&gt; &amp; literal &lt;b&gt;text&lt;/b&gt; &amp;lt;tag&amp;gt;";
  const expected = "std::vector<int> & literal <b>text</b> &lt;tag&gt;";
  const raw = frozenCopy({
    geekBaseInfo: { geekId: "synthetic-angle-brackets", name: "Fixture &amp; Co" },
    geekWorkExpList: [{ company: "Fixture", responsibility: `<p>${text}</p>`, skillList: [text] }],
    geekSkillList: [{ skillName: text }],
    geekCertificationList: [{ certName: text }]
  });
  const parsed = profile.parseResumeDetail(raw);
  assert.equal(parsed.profile.workHistory[0].responsibility, expected);
  assert.deepEqual(parsed.skills, [expected]);
  assert.deepEqual(parsed.certifications, [expected]);
  const formatted = profile.formatResumeApiData(raw);
  assert.ok(formatted.includes(`职责: ${expected}`));
  assert.ok(formatted.includes(`姓名: Fixture & Co`));
  const candidate = profile.parseGeek({ geekId: "synthetic-angle-brackets" });
  const first = profile.mergeCandidateDetail(candidate, raw);
  const second = profile.mergeCandidateDetail(first, raw);
  assert.equal(first.resumeText, formatted);
  assert.equal(second.resumeText, formatted);
  assert.deepEqual(second.skills, [expected]);
  assert.deepEqual(second.certifications, [expected]);
  assert.deepEqual(second.profile.workHistory[0].techTags, [expected]);
});

test("lookup keys retain source identities without name-based lookup", () => {
  const candidate = frozenCopy(profile.parseGeek(fixtures.recommendCandidate));
  const keys = profile.getCandidateLookupKeys(candidate);
  assert.ok(keys.includes("synthetic-geek-001"));
  assert.ok(keys.includes("synthetic-encrypted-geek-001"));
  assert.ok(keys.includes("synthetic-security-recommend-001"));
  assert.equal(keys.includes(candidate.name), false);
  assert.equal(profile.getCandidateSecurityId(candidate), "synthetic-security-recommend-001");
});

test("offline detail parsing accepts payloads and successful response envelopes", () => {
  const payload = frozenCopy(fixtures.recommendResumeDetail);
  const parsed = profile.parseResumeDetail(payload);
  assert.equal(parsed.name, "Fixture Person");
  assert.equal(parsed.profile.workHistory[0].company, "Fixture Systems");
  assert.match(parsed.profile.workHistory[0].responsibility, /Second responsibility paragraph/);
  assert.equal(parsed.profile.education[0].thesisTitle, "Synthetic retry scheduling");
  assert.equal(parsed.profile.projects[0].name, "Fixture Queue");
  assert.equal(parsed.expectations[0].position, "Backend engineer");
  assert.deepEqual(parsed.skills, ["Node.js (熟练)"]);
  assert.deepEqual(parsed.certifications, ["Synthetic certificate"]);
  assert.deepEqual(parsed.raw, payload);
  assert.notEqual(parsed.raw, payload);
  assert.deepEqual(profile.parseResumeDetail({ code: 0, zpData: payload }), parsed);
  assert.deepEqual(profile.parseResumeDetail({ code: "0", data: payload }), parsed);
  assert.deepEqual(profile.parseResumeDetail(payload.geekDetail).profile, parsed.profile);
  assert.equal(profile.formatResumeApiData({ code: 0, zpData: payload }), profile.formatResumeApiData(payload));
  parsed.raw.geekDetail.geekBaseInfo.name = "Changed local copy";
  assert.deepEqual(payload, fixtures.recommendResumeDetail);
});

test("offline parsing distinguishes empty sections from invalid or failed responses", () => {
  const empty = profile.parseResumeDetail(fixtures.emptyResumeDetail);
  assert.deepEqual(empty.profile, { workHistory: [], education: [], projects: [] });
  assert.equal(profile.formatResumeApiData({ code: 0, zpData: fixtures.emptyResumeDetail }), "");
  for (const input of [null, {}, [], "resume", { geekDetail: {} }, { code: 0 }, { code: 0, zpData: {} },
    { zpData: fixtures.recommendResumeDetail }, { code: 0, data: { resumeText: "Text alone" } }]) {
    assert.throws(() => profile.parseResumeDetail(input), { code: "DETAIL_PAYLOAD_INVALID" });
    assert.throws(() => profile.formatResumeApiData(input), { code: "DETAIL_PAYLOAD_INVALID" });
  }
  const failed = { code: 501, zpData: fixtures.recommendResumeDetail };
  assert.throws(() => profile.parseResumeDetail(failed), { code: "DETAIL_BUSINESS_ERROR", platformCode: 501 });
  assert.throws(() => profile.formatResumeApiData(failed), { code: "DETAIL_BUSINESS_ERROR", platformCode: 501 });
});

test("verified offline merge returns an independent candidate without claiming a browser acquisition", () => {
  const candidate = frozenCopy({
    ...profile.parseGeek(fixtures.recommendCandidate),
    raw: fixtures.recommendCandidate,
    detail: { status: "not_requested" }
  });
  const input = frozenCopy({ code: 0, zpData: fixtures.recommendResumeDetail });
  const result = profile.mergeCandidateDetail(candidate, input);
  assert.deepEqual(result.detail, { status: "not_requested" });
  assert.deepEqual(result.raw, candidate.raw);
  assert.deepEqual(result.resumeDetail, fixtures.recommendResumeDetail);
  assert.notEqual(result.raw, candidate.raw);
  assert.notEqual(result.resumeDetail, input.zpData);
  assert.equal(result.resumeSource, "provided_detail");
  assert.equal(result.profile.workHistory.length, 3);
  assert.match(result.resumeText, /First responsibility paragraph/);
  assert.equal("resumeDetail" in candidate, false);
  result.raw.geekCard.geekName = "Edited result";
  result.resumeDetail.geekDetail.geekBaseInfo.name = "Edited detail";
  assert.deepEqual(candidate.raw, fixtures.recommendCandidate);
  assert.deepEqual(input.zpData, fixtures.recommendResumeDetail);
  const standalone = profile.mergeCandidateDetail(profile.parseGeek(fixtures.recommendCandidate), input);
  assert.equal("detail" in standalone, false);
});

test("offline merge requires original request linkage for featured lists with rotated tokens", () => {
  const candidate = frozenCopy(profile.parseGeek(fixtures.featuredCandidate));
  const input = frozenCopy(fixtures.featuredResumeDetail);
  assert.throws(() => profile.mergeCandidateDetail(candidate, input), { code: "CANDIDATE_IDENTITY_MISMATCH" });
  assert.throws(() => profile.mergeCandidateDetail(candidate, input, { requestSecurityId: candidate.geekId }), {
    code: "CANDIDATE_IDENTITY_MISMATCH"
  });
  const result = profile.mergeCandidateDetail(candidate, input, { requestSecurityId: candidate.securityId, source: "saved_response" });
  assert.equal(result.profile.workHistory[0].company, "Fixture Interface Company");
  assert.equal(result.securityId, candidate.securityId);
  assert.equal(result.resumeSource, "saved_response");
  assert.deepEqual(candidate.profile.workHistory, []);
});

test("offline merge rejects conflicting IDs and failure responses without changing the candidate", () => {
  const candidate = frozenCopy(profile.parseGeek(fixtures.recommendCandidate));
  const other = structuredClone(fixtures.recommendResumeDetail);
  other.geekDetail.geekBaseInfo.geekId = "different-synthetic-person";
  assert.throws(() => profile.mergeCandidateDetail(candidate, other, { requestSecurityId: candidate.securityId }), {
    code: "CANDIDATE_IDENTITY_MISMATCH"
  });
  assert.throws(() => profile.mergeCandidateDetail(candidate, { code: 403, zpData: fixtures.recommendResumeDetail }), {
    code: "DETAIL_BUSINESS_ERROR", platformCode: 403
  });
  assert.deepEqual(candidate, profile.parseGeek(fixtures.recommendCandidate));
});
