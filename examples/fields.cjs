"use strict";
const { parseGeek, parseResumeDetail, mergeCandidateDetail } = require("boss-automation");
const { featuredCandidate, featuredResumeDetail } = require("../fixtures/candidates.cjs");

const candidate = { ...parseGeek(featuredCandidate), raw: structuredClone(featuredCandidate) };
const detail = parseResumeDetail({ code: 0, zpData: featuredResumeDetail });
const merged = mergeCandidateDetail(candidate, detail.raw, {
  requestSecurityId: candidate.securityId
});

console.log(JSON.stringify({
  rawList: candidate.raw,
  rawDetail: detail.raw,
  listWorkHistory: candidate.profile.workHistory,
  profile: merged.profile
}, null, 2));
