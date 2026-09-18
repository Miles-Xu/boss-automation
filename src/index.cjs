"use strict";
const { connect } = require("./browser/session.cjs");
const { listJobs, selectJob, describeFilters, applyFilters } = require("./recommend/filters.cjs");
const { selectPageScope } = require("./recommend/page.cjs");
const { startListCapture } = require("./recommend/list-capture.cjs");
const { readCandidates, scrollCandidates, getCandidateDetail } = require("./recommend/collector.cjs");
const { favoriteCandidate, greetCandidate } = require("./recommend/actions.cjs");
const { parseGeek, parseResumeDetail, mergeCandidateDetail, formatResumeApiData } = require("./candidate-profile.cjs");

module.exports = { connect, listJobs, selectJob, selectPageScope, describeFilters, applyFilters,
  startListCapture, readCandidates, scrollCandidates, getCandidateDetail,
  favoriteCandidate, greetCandidate, parseGeek, parseResumeDetail, mergeCandidateDetail, formatResumeApiData };
