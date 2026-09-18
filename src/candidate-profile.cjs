// Pure field readers, typed identity checks, and explicit in-place detail merging.
"use strict";

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseBoolean(value, fallback = null) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueValues(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const text = normalizeText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function extractStructuredText(value) {
  if (typeof value === "string") return normalizeText(value);
  if (!value || typeof value !== "object") return "";
  return normalizeText(
    value.content
    || value.name
    || value.text
    || value.value
    || value.desc
    || value.label
    || value.labelName
    || value.title
    || ""
  );
}

function stripHtml(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/gi, entity => ({
      "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'"
    })[entity.toLowerCase()]);
}

// Already-decoded text must not pass through HTML removal or entity decoding again.
function normalizePlainText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function uniquePlainText(values) {
  return [...new Set(safeArray(values).map(normalizePlainText).filter(Boolean))];
}

function normalizeRichText(value) {
  return normalizePlainText(stripHtml(value));
}

function firstNonEmptyText(...values) {
  for (const value of values) {
    const field = value && typeof value === "object"
      ? value.content ?? value.name ?? value.text ?? value.value ?? value.desc ?? value.label ?? value.title ?? value.tagName ?? value.subjectName ?? ""
      : value;
    const text = normalizeRichText(field);
    if (text) return text;
  }
  return "";
}

function originalTextList(values) {
  return [...new Set(safeArray(values).map((value) => firstNonEmptyText(value)).filter(Boolean))];
}

function joinOriginalText(...values) {
  return originalTextList(values).join("\n");
}

function firstNonEmptyArray(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) {
      return value;
    }
  }
  return [];
}

function normalizeResumeDate(value) {
  const text = normalizeText(value);
  if (!text || text === "0") return "";
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}.${text.slice(4, 6)}`;
  if (/^\d{6}$/.test(text)) return `${text.slice(0, 4)}.${text.slice(4, 6)}`;
  if (/^\d{4}$/.test(text)) return text;
  return text;
}

function formatResumeTimeRange(item) {
  if (!item || typeof item !== "object") return "";
  const explicitRange = firstNonEmptyText(item.dateRange, item.timeRange, item.period, item.eduTime);
  if (explicitRange) return explicitRange;
  const start = normalizeResumeDate(
    item.startYearMonStr
    || item.startYearStr
    || item.startDateDesc
    || item.startDateStr
    || item.startDate
    || item.startDate8
    || item.startTime
  );
  const end = normalizeResumeDate(
    item.endYearMonStr
    || item.endYearStr
    || item.endDateDesc
    || item.endDateStr
    || item.endDate
    || item.endDate8
    || item.endTime
  );
  if (start && end) return `${start} - ${end}`;
  if (start || end) return start || end;
  return "";
}

function detailRootFromResumePayload(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  return root.geekDetail || root.geekDetailInfo || root.detail || root;
}

function hasResumeDetailPayload(payload) {
  const detail = detailRootFromResumePayload(payload);
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return false;
  // Empty source sections are valid; formatted text alone cannot validate an API response.
  return Boolean(detail.geekBaseInfo && typeof detail.geekBaseInfo === "object" && !Array.isArray(detail.geekBaseInfo))
    || ["geekWorkExpList", "geekWorkList", "workExpList", "workList", "geekProjExpList",
      "geekProjectList", "projectExpList", "projectList", "projects", "geekEduExpList",
      "geekEducationList", "educationList", "eduExpList", "geekExpectList", "geekExpPosList",
      "geekSkillList", "skillList", "geekCertificationList"].some((key) => Array.isArray(detail[key]));
}

function unwrapResumeDetail(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new TypeError("Expected a resume detail object or a successful API response"), { code: "DETAIL_PAYLOAD_INVALID" });
  }
  const isResponse = Object.hasOwn(input, "code") || Object.hasOwn(input, "zpData") || Object.hasOwn(input, "data");
  if (isResponse && Object.hasOwn(input, "code") && ![0, "0"].includes(input.code)) {
    throw Object.assign(new Error("Resume detail response was not successful"), {
      code: "DETAIL_BUSINESS_ERROR", platformCode: input.code
    });
  }
  const payload = isResponse && [0, "0"].includes(input.code) ? input.zpData ?? input.data : input;
  if ((isResponse && ![0, "0"].includes(input.code)) || !hasResumeDetailPayload(payload)) {
    throw Object.assign(new TypeError("Resume detail is missing its base information or source sections"), { code: "DETAIL_PAYLOAD_INVALID" });
  }
  return payload;
}

function parseResumeDetail(input) {
  const payload = unwrapResumeDetail(input);
  const detail = detailRootFromResumePayload(payload);
  return {
    name: firstNonEmptyText(detail.geekBaseInfo?.name, detail.geekName, payload.geekName),
    profile: {
      workHistory: extractResumeWorkHistoryFromPayload(payload),
      education: extractResumeEducationFromPayload(payload),
      projects: extractResumeProjectsFromPayload(payload)
    },
    expectations: extractResumeExpectationsFromPayload(payload),
    skills: extractResumeSkillsFromPayload(payload),
    certifications: extractResumeCertificationsFromPayload(payload),
    raw: structuredClone(payload)
  };
}

function extractTypedGeekIdentity(...records) {
  return {
    geekId: uniqueValues(records.map((item) => item?.geekId)).filter((id) => id !== "0"),
    encryptGeekId: uniqueValues(records.flatMap((item) => [item?.encGeekId, item?.encryptGeekId])),
    encryptUserId: uniqueValues(records.map((item) => item?.encryptUserId))
  };
}

function getSnapshotCandidateGeekIds(candidate) {
  return uniqueValues([
    candidate?.geek_id,
    candidate?.key,
    candidate?.geekId,
    candidate?.encryptGeekId,
    candidate?.encGeekId,
    candidate?.encryptUserId,
    candidate?.securityId,
    candidate?.geekCard?.encGeekId,
    candidate?.geekCard?.encryptGeekId,
    candidate?.geekCard?.encryptUserId,
    candidate?.geekCard?.securityId,
    candidate?.geekCard?.geekId
  ].map((item) => (item == null ? "" : String(item)))).filter((id) => id !== "0");
}

function getSnapshotCandidateGeekId(candidate) {
  return getSnapshotCandidateGeekIds(candidate)[0] || "";
}

function getCandidateLookupKeys(candidate) {
  return uniqueValues([
    candidate?.geekId,
    candidate?.geek_id,
    candidate?.key,
    candidate?.securityId,
    ...safeArray(candidate?.sourceGeekIds),
    ...Object.values(candidate?.listIdentity || {}).flat(),
    ...(Array.isArray(candidate?.requestMeta?.apiGeekIds) ? candidate.requestMeta.apiGeekIds : [])
  ].map((item) => (item == null ? "" : String(item))));
}

function getCandidateSecurityId(candidate) {
  return normalizeText(candidate?.securityId || "");
}

function normalizeWorkEntry(value, fallback = {}) {
  const item = value && typeof value === "object" ? value : {};
  return {
    company: firstNonEmptyText(item.company, item.companyName, item.brandName, fallback.company),
    role: firstNonEmptyText(item.positionName, item.positionCategory, item.position, item.role, item.title, fallback.role),
    period: formatResumeTimeRange(item),
    duration: firstNonEmptyText(item.duration, item.workDuration, item.workTime),
    responsibility: joinOriginalText(item.responsibility, item.workContent),
    performance: joinOriginalText(item.workPerformance, item.performance),
    description: joinOriginalText(item.description, item.desc, item.workEmphasis),
    techTags: originalTextList(firstNonEmptyArray(item.workEmphasisList, item.skillList, item.skills, item.keywordList, item.tags))
  };
}

function normalizeEducationEntry(value, fallback = {}) {
  const item = value && typeof value === "object" ? value : {};
  return {
    school: firstNonEmptyText(item.school, item.schoolName, fallback.school),
    major: firstNonEmptyText(item.major, item.majorName, fallback.major),
    degree: firstNonEmptyText(item.degreeName, item.degreeCategory, typeof item.degree === "string" ? item.degree : ""),
    period: formatResumeTimeRange(item),
    description: joinOriginalText(item.eduDescription, item.description),
    courses: originalTextList([item.courseDesc, ...safeArray(item.keySubjectList), ...safeArray(item.courses)]),
    thesisTitle: firstNonEmptyText(item.thesisTitle),
    thesisDescription: firstNonEmptyText(item.thesisDesc, item.thesisDescription),
    schoolTags: originalTextList(firstNonEmptyArray(item.schoolTagList, item.schoolTags, item.schoolLabelList))
  };
}

function extractResumeWorkHistoryFromPayload(payload) {
  const detail = detailRootFromResumePayload(payload);
  const workList = firstNonEmptyArray(
    detail.geekWorkExpList,
    detail.geekWorkList,
    detail.workExpList,
    detail.workList,
    payload?.bossViewGeekWorkExp
  );
  return workList.map((value) => {
    const item = value && typeof value === "object" ? value : {};
    return {
      ...normalizeWorkEntry(item),
      description: joinOriginalText(item.description, item.desc, item.workDesc, item.workEmphasis)
    };
  });
}

function extractResumeEducationFromPayload(payload) {
  const detail = detailRootFromResumePayload(payload);
  const eduList = firstNonEmptyArray(
    detail.geekEduExpList,
    detail.geekEducationList,
    detail.educationList,
    detail.eduExpList
  );
  return eduList.map((item) => normalizeEducationEntry(item));
}

function extractResumeProjectsFromPayload(payload) {
  const detail = detailRootFromResumePayload(payload);
  return firstNonEmptyArray(detail.geekProjExpList, detail.geekProjectList, detail.projectExpList, detail.projectList, detail.projects)
    .map((value) => {
      const item = value && typeof value === "object" ? value : {};
      return {
        name: firstNonEmptyText(item.name, item.projectName),
        role: firstNonEmptyText(item.roleName, item.role),
        period: formatResumeTimeRange(item),
        description: joinOriginalText(item.description, item.projectDescription),
        responsibility: joinOriginalText(item.responsibility, item.projectResponsibility),
        performance: joinOriginalText(item.performance, item.projectPerformance)
      };
    });
}

function extractResumeExpectationsFromPayload(payload) {
  const detail = detailRootFromResumePayload(payload);
  const expectList = firstNonEmptyArray(
    detail.geekExpectList,
    detail.geekExpPosList,
    detail.expectations,
    detail.showExpectPosition ? [detail.showExpectPosition] : [],
    detail.geekExpect ? [detail.geekExpect] : [],
    payload?.showExpectPosition ? [payload.showExpectPosition] : []
  );
  return expectList.filter((item) => item && typeof item === "object").map((item) => ({
    position: firstNonEmptyText(item.positionName, item.position, item.name),
    location: firstNonEmptyText(item.locationName, item.location, item.cityName, item.city),
    salary: firstNonEmptyText(item.salaryDesc, item.salary),
    industry: firstNonEmptyText(item.industryDesc, item.industryName, item.industry)
  }));
}

function extractResumeSkillsFromPayload(payload) {
  const detail = detailRootFromResumePayload(payload);
  return uniquePlainText(firstNonEmptyArray(detail.geekSkillList, detail.skillList, detail.skills).map((item) => {
    if (!item || typeof item !== "object") return firstNonEmptyText(item);
    const name = firstNonEmptyText(item.skillName, item.name);
    const level = firstNonEmptyText(item.levelName, item.level);
    return name && level ? `${name} (${level})` : name;
  }));
}

function extractResumeCertificationsFromPayload(payload) {
  const detail = detailRootFromResumePayload(payload);
  return uniquePlainText(firstNonEmptyArray(detail.geekCertificationList, detail.certificationList, detail.certifications)
    .map((item) => item && typeof item === "object" ? firstNonEmptyText(item.certName, item.name) : firstNonEmptyText(item)));
}

function mergeProfileEntries(existingEntries, detailedEntries, identityFields) {
  const existing = safeArray(existingEntries);
  const detailed = safeArray(detailedEntries);
  if (detailed.length === 0) return existing;
  const used = new Set();
  const merged = detailed.map((detail) => {
    const matches = existing.map((item, index) => ({ item, index })).filter(({ item, index }) => {
      if (used.has(index)) return false;
      const anchor = identityFields[0];
      if (!normalizeText(item?.[anchor]) || normalizeText(item[anchor]) !== normalizeText(detail[anchor])) return false;
      return identityFields.every((field) => (
        !normalizeText(item?.[field]) || !normalizeText(detail[field])
        || normalizeText(item[field]) === normalizeText(detail[field])
      ));
    });
    // Ambiguous or conflicting entries stay separate instead of borrowing another record's fields.
    if (matches.length !== 1) return detail;
    const { item: prior, index } = matches[0];
    used.add(index);
    const result = { ...prior, ...detail };
    for (const [key, value] of Object.entries(detail)) {
      result[key] = Array.isArray(value)
        ? uniquePlainText([...safeArray(prior[key]), ...value])
        : value || prior[key] || "";
    }
    return result;
  });
  return [...merged, ...existing.filter((_, index) => !used.has(index))];
}

function mergeWorkHistories(existingWorkHistory, detailedWorkHistory) {
  return mergeProfileEntries(existingWorkHistory, detailedWorkHistory, ["company", "role", "period"]);
}

function mergeEducation(existingEducation, detailedEducation) {
  return mergeProfileEntries(existingEducation, detailedEducation, ["school", "major", "degree", "period"]);
}

// List fields vary between recommend and featured pages.

function parseGeek(rawGeek, bossOrder = 0, forcedGeekId = "") {
  const g = rawGeek && typeof rawGeek === "object" ? rawGeek : {};
  const card = g.geekCard && typeof g.geekCard === "object" ? g.geekCard : g;
  const splitWorkName = (value) => {
    const text = extractStructuredText(value);
    if (!text) return { company: "", role: "" };
    if (text.includes("·")) {
      const [company, role] = text.split("·").map((item) => normalizeText(item));
      return { company: company || "", role: role || "" };
    }
    if (text.includes("|")) {
      const [role, company] = text.split("|").map((item) => normalizeText(item));
      return { company: company || "", role: role || "" };
    }
    return { company: "", role: text };
  };
  const splitEducationName = (value) => {
    const text = extractStructuredText(value);
    if (!text) return { school: "", major: "" };
    const [school, major] = text.split("·").map((item) => normalizeText(item));
    return { school: school || text, major: major || "" };
  };
  const works = (
    safeArray(card.geekWorks).length > 0
      ? safeArray(card.geekWorks)
      : safeArray(card.workList).length > 0
        ? safeArray(card.workList)
      : safeArray(g.geekWorks).length > 0
        ? safeArray(g.geekWorks)
        : safeArray(g.showWorks).length > 0
          ? safeArray(g.showWorks)
          : safeArray(g.works).length > 0
            ? safeArray(g.works)
            : safeArray(card.works).length > 0
              ? safeArray(card.works)
              : card.geekWork
                ? [card.geekWork]
                : g.geekLastWork
                  ? [g.geekLastWork]
                  : []
  ).map((w) => {
    const split = splitWorkName(w.name || w.workDesc);
    return normalizeWorkEntry(w, split);
  });

  const edus = (
    safeArray(card.geekEdus).length > 0
      ? safeArray(card.geekEdus)
      : safeArray(g.geekEdus).length > 0
        ? safeArray(g.geekEdus)
        : safeArray(g.showEdus).length > 0
          ? safeArray(g.showEdus)
          : card.geekEdu
            ? [card.geekEdu]
            : g.geekEdu
              ? [g.geekEdu]
              : card.eduSchool || g.school
                ? [{
                    school: card.eduSchool || g.school || "",
                    major: card.eduMajor || g.major || "",
                    degreeName: card.eduDegreeName || g.eduDegreeName || "",
                    startDate: g.startDate || "",
                    endDate: g.endDate || ""
                  }]
                : []
  ).map((e) => {
    const split = splitEducationName(e.name);
    return normalizeEducationEntry(e, split);
  });

  const tags = [];
  const pushTag = (value) => {
    if (Array.isArray(value)) {
      value.forEach(pushTag);
      return;
    }
    const text = extractStructuredText(value);
    if (text) tags.push(text);
  };
  if (Array.isArray(g.recLabels)) tags.push(...g.recLabels.map((item) => item?.name || item));
  if (Array.isArray(g.hlmatches)) tags.push(...g.hlmatches.map((item) => item?.content || item));
  pushTag(card.matches);
  pushTag(card.labels);
  pushTag(card.allLabels);
  pushTag(card.tagList);
  pushTag(card.tags);
  pushTag(card.cardLabelInfos);
  pushTag(card.geekProfileList);
  pushTag(card.expectLabel);
  pushTag(card.rcdReasonList);
  pushTag(card.recommendedReason);
  pushTag(card.aiRcdReason);
  pushTag(card.rcdReason);
  if (card.expectText || g.expectText || card.expect?.name) tags.push(card.expectText || g.expectText || card.expect?.name);
  if (card.expectPositionName) tags.push(card.expectPositionName);
  if (g.pushCardExpectName || g.highlightExpectName) tags.push(g.pushCardExpectName || g.highlightExpectName);

  const activeMatch = safeArray(g.hlmatches)
    .map((item) => extractStructuredText(item))
    .find((item) => item.includes("活跃")) || "";

  const combined = { ...g, ...card };
  const expectations = extractResumeExpectationsFromPayload(combined);
  const expectPosition = firstNonEmptyText(
    card.expectPositionName, g.expectPositionName, g.positionName,
    g.pushCardExpectName, g.highlightExpectName, g.showExpectPosition?.positionName,
    g.geekExpect?.positionName,
    extractStructuredText(card.expect?.name).replace(/^求职期望[:：]\s*/, ""),
    expectations[0]?.position
  );
  const expectLocation = firstNonEmptyText(
    card.expectLocationName, g.expectLocationName, card.expectCityName, g.expectCityName,
    g.showExpectPosition?.locationName, g.geekExpect?.locationName,
    card.city, g.city, expectations[0]?.location
  );
  const salary = firstNonEmptyText(card.salary, card.salaryDesc, g.salary, g.salaryDesc, expectations[0]?.salary);
  if (expectations.length === 0 && (expectPosition || expectLocation || salary)) {
    expectations.push({ position: expectPosition, location: expectLocation, salary, industry: "" });
  }

  return {
    bossOrder,
    geekId: forcedGeekId || card.encGeekId || card.encryptGeekId || card.encryptUserId || card.securityId || g.encGeekId || g.encryptGeekId || g.securityId || g.geekId || g.id || "",
    securityId: card.securityId || g.securityId || "",
    listIdentity: extractTypedGeekIdentity(g, card),
    sourceGeekIds: getSnapshotCandidateGeekIds(g),
    encryptJobId: card.encryptJobId || g.encryptJobId || card.jobId || g.jobId || "",
    lid: card.lid || g.lid || "",
    encryptExpectId: card.encryptExpectId || g.encryptExpectId || "",
    name: card.geekName || card.name || g.geekName || g.name || "",
    age: firstNonEmptyText(card.ageDesc, g.ageDesc, card.age, g.age),
    exp: firstNonEmptyText(card.geekWorkYear, card.workYear, g.geekWorkYear, g.workYear, card.workExpDesc, g.workExpDesc, g.expectExperience),
    degree: card.geekDegree || card.highestDegreeName || card.degreeName || g.geekDegree || g.highestDegreeName || g.degreeName || "",
    salary,
    jobStatus: firstNonEmptyText(card.applyStatusDesc, g.applyStatusDesc, card.intention, g.intention),
    advantage: firstNonEmptyText(card.geekDesc, g.geekDesc, card.geekAdvantage, g.geekAdvantage, card.advantage, g.advantage),
    tags: uniqueValues(tags),
    haveChatted: parseBoolean(g.haveChatted),
    haveChattedRaw: g.haveChatted ?? null,
    profile: {
      workHistory: works,
      education: edus,
      projects: extractResumeProjectsFromPayload(combined)
    },
    expectPosition,
    expectLocation,
    expectations,
    skills: extractResumeSkillsFromPayload(combined),
    certifications: extractResumeCertificationsFromPayload(combined),
    activeTime: g.activeTimeDesc || card.activeDesc || activeMatch || "",
    recommendReason: extractStructuredText(card.recommendedReason || card.aiRcdReason || card.rcdReason || g.webRecommendReason || g.recommendReason) || null,
    hasBg: g.hasBg || false
  };
}

function resumeDetailIdentityMatches(candidate, payload, requestGeekId = "") {
  const detail = detailRootFromResumePayload(payload);
  const baseInfo = detail.geekBaseInfo || {};
  const responseIdentity = extractTypedGeekIdentity(payload, detail, baseInfo);
  const responseSecurityIds = uniqueValues([payload?.securityId, detail.securityId, baseInfo.securityId]);
  const candidateKeys = getCandidateLookupKeys(candidate);
  const requestKey = normalizeText(requestGeekId);
  if (requestKey && !candidateKeys.includes(requestKey)) return false;

  let matched = false;
  if (candidate?.listIdentity) {
    for (const field of ["geekId", "encryptGeekId", "encryptUserId"]) {
      const listIds = safeArray(candidate.listIdentity[field]);
      const detailIds = responseIdentity[field];
      if (!listIds.length || !detailIds.length) continue;
      if (!listIds.some((id) => detailIds.includes(id))) return false;
      matched = true;
    }
  } else {
    // Older records have only untyped aliases; retain exact-ID matching for them.
    matched = Object.values(responseIdentity).flat().some((id) => candidateKeys.includes(id));
  }
  const securityId = getCandidateSecurityId(candidate);
  if (matched || (securityId && responseSecurityIds.includes(securityId))) return true;

  // Featured lists expose encryptUserId, while details expose encryptGeekId and a
  // rotated securityId. The response belongs to the request's original securityId.
  if (!securityId || requestKey !== securityId) return false;
  const hasResponseIdentity = Object.values(responseIdentity).some((ids) => ids.length) || responseSecurityIds.length > 0;
  if (hasResponseIdentity) return true;
  const name = firstNonEmptyText(baseInfo.name, detail.geekName, payload?.geekName);
  return !name || !normalizeText(candidate?.name) || normalizeText(name) === normalizeText(candidate.name);
}

function mergeCandidateDetail(candidate, input, { requestSecurityId = "", source = "provided_detail" } = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new TypeError("candidate must be an object");
  if (typeof requestSecurityId !== "string") throw new TypeError("requestSecurityId must be a string");
  if (typeof source !== "string" || !source.trim()) throw new TypeError("source must be a non-empty string");
  const payload = unwrapResumeDetail(input);
  if (!resumeDetailIdentityMatches(candidate, payload, requestSecurityId)) {
    throw Object.assign(new Error("Resume detail does not match the candidate's identity"), { code: "CANDIDATE_IDENTITY_MISMATCH" });
  }
  const result = structuredClone(candidate);
  const raw = structuredClone(payload);
  applyResumeDetailToCandidate(result, { payload: raw, candidateInfo: getCandidateInfoFromResumePayload(raw), source });
  return result;
}

function applyResumeDetailToCandidate(candidate, detail, formatResumeText = formatResumeApiData) {
  const payload = detail?.payload || null;
  const candidateInfo = detail?.candidateInfo || {};
  const profile = candidate.profile && typeof candidate.profile === "object" ? candidate.profile : {};
  const detailedWork = payload ? extractResumeWorkHistoryFromPayload(payload) : [];
  const detailedEducation = payload ? extractResumeEducationFromPayload(payload) : [];
  const detailedProjects = payload ? extractResumeProjectsFromPayload(payload) : [];
  const expectations = payload ? extractResumeExpectationsFromPayload(payload) : [];
  const resumeRoot = detailRootFromResumePayload(payload);
  const baseInfo = resumeRoot.geekBaseInfo || {};
  const resumeText = payload
    ? normalizePlainText(candidateInfo.resumeText || formatResumeText(payload))
    : String(candidateInfo.resumeText || "").replace(/\r\n?/g, "\n").trim();

  candidate.profile = {
    ...profile,
    workHistory: mergeWorkHistories(profile.workHistory, detailedWork),
    education: mergeEducation(profile.education, detailedEducation),
    projects: mergeProfileEntries(profile.projects, detailedProjects, ["name", "role", "period"])
  };

  candidate.name = candidateInfo.name || candidate.name || "";
  candidate.age = firstNonEmptyText(baseInfo.ageDesc, candidate.age);
  const genderCode = String(baseInfo.gender ?? "");
  if (genderCode === "1" || genderCode === "2") candidate.gender = genderCode === "1" ? "男" : "女";
  const freshGraduate = parseBoolean(baseInfo.freshGraduate);
  if (freshGraduate !== null) candidate.freshGraduate = freshGraduate;
  candidate.workStart = firstNonEmptyText(normalizeResumeDate(baseInfo.workDate8), candidate.workStart);
  candidate.exp = firstNonEmptyText(baseInfo.workYearDesc, candidate.exp);
  candidate.degree = firstNonEmptyText(baseInfo.degreeCategory, candidate.degree);
  candidate.jobStatus = firstNonEmptyText(baseInfo.applyStatusContent, candidate.jobStatus);
  candidate.activeTime = firstNonEmptyText(baseInfo.activeTimeDesc, candidate.activeTime);
  candidate.advantage = firstNonEmptyText(resumeRoot.geekAdvantage, baseInfo.userDesc, baseInfo.userDescription, candidate.advantage);
  candidate.expectations = mergeProfileEntries(candidate.expectations, expectations, ["position", "location", "salary", "industry"]);
  candidate.expectPosition = candidate.expectPosition || candidate.expectations[0]?.position || "";
  candidate.expectLocation = candidate.expectLocation || candidate.expectations[0]?.location || "";
  candidate.salary = candidate.salary || candidate.expectations[0]?.salary || "";
  candidate.skills = uniquePlainText([...safeArray(candidate.skills), ...extractResumeSkillsFromPayload(payload)]);
  candidate.certifications = uniquePlainText([...safeArray(candidate.certifications), ...extractResumeCertificationsFromPayload(payload)]);
  candidate.workValidation = uniquePlainText([
    ...safeArray(candidate.workValidation),
    ...originalTextList(safeArray(resumeRoot.workExpCheckRes).flatMap((item) => [item?.desc, item?.firstTip, item?.chatDesc]))
  ]);
  candidate.resumeText = resumeText;
  candidate.resumeSource = detail?.source || "";
  if (payload) candidate.resumeDetail = payload;
  return hasResumeDetailPayload(payload) || Boolean(resumeText);
}

function getCandidateInfoFromResumePayload(payload, formatResumeText = formatResumeApiData) {
  if (!payload || typeof payload !== "object") return null;
  const detail = detailRootFromResumePayload(payload);
  const baseInfo = detail.geekBaseInfo || {};
  const work = firstNonEmptyArray(detail.geekWorkExpList, detail.geekWorkList, detail.workExpList)[0] || {};
  const edu = firstNonEmptyArray(detail.geekEduExpList, detail.geekEducationList, detail.educationList)[0] || {};
  const resumeText = normalizePlainText(formatResumeText(payload));
  return {
    name: firstNonEmptyText(baseInfo.name, detail.geekName, payload.geekName),
    school: firstNonEmptyText(edu.school, edu.schoolName),
    major: firstNonEmptyText(edu.major, edu.majorName),
    company: firstNonEmptyText(work.company, work.companyName),
    position: firstNonEmptyText(work.positionName, work.position, work.role),
    resumeText,
    alreadyInterested: payload.alreadyInterested === true || detail.alreadyInterested === true
  };
}

function formatResumeApiData(input) {
  const payload = unwrapResumeDetail(input);
  const root = detailRootFromResumePayload(payload);
  const base = root.geekBaseInfo || {};
  const sections = [];
  const field = (label, value) => {
    const text = normalizePlainText(value);
    return text ? label + ": " + text : "";
  };
  const rawField = (label, value) => field(label, firstNonEmptyText(value));
  const section = (title, lines) => {
    const text = lines.filter(Boolean).join("\n");
    if (text) sections.push("=== " + title + " ===\n" + text);
  };
  const gender = String(base.gender ?? "");
  const graduate = parseBoolean(base.freshGraduate);
  section("基本信息", [
    rawField("姓名", base.name || root.geekName),
    rawField("年龄", base.ageDesc),
    field("性别", gender === "1" ? "男" : gender === "2" ? "女" : ""),
    rawField("学历", base.degreeCategory),
    rawField("工作经验", base.workYearDesc),
    field("应届状态", graduate === null ? "" : graduate ? "应届生" : "非应届生"),
    field("参加工作时间", normalizeResumeDate(base.workDate8)),
    rawField("活跃状态", base.activeTimeDesc),
    rawField("求职状态", base.applyStatusContent)
  ]);
  section("期望工作", extractResumeExpectationsFromPayload(payload).map((item) => [
    field("职位", item.position),
    field("城市", item.location),
    field("薪资", item.salary),
    field("行业", item.industry)
  ].filter(Boolean).join("\n")));
  section("个人优势", [firstNonEmptyText(root.geekAdvantage, base.userDesc, base.userDescription)]);
  section("工作经历", extractResumeWorkHistoryFromPayload(payload).map((item, index) => [
    (index + 1) + ". " + [item.company, item.role].filter(Boolean).join(" - "),
    field("时间", item.period),
    field("时长", item.duration),
    field("职责", item.responsibility),
    field("成果", item.performance),
    field("补充", item.description),
    field("技术标签", item.techTags.join("、"))
  ].filter(Boolean).join("\n")));
  section("项目经历", extractResumeProjectsFromPayload(payload).map((item, index) => [
    (index + 1) + ". " + item.name,
    field("角色", item.role),
    field("时间", item.period),
    field("描述", item.description),
    field("职责", item.responsibility),
    field("成果", item.performance)
  ].filter(Boolean).join("\n")));
  section("教育经历", extractResumeEducationFromPayload(payload).map((item, index) => [
    (index + 1) + ". " + item.school,
    field("专业", item.major),
    field("学历", item.degree),
    field("时间", item.period),
    field("描述", item.description),
    field("课程", item.courses.join("\n")),
    field("论文", item.thesisTitle),
    field("论文描述", item.thesisDescription),
    field("学校标签", item.schoolTags.join("、"))
  ].filter(Boolean).join("\n")));
  section("技能标签", extractResumeSkillsFromPayload(payload));
  section("资格证书", extractResumeCertificationsFromPayload(payload));
  section("工作经历提示", originalTextList(safeArray(root.workExpCheckRes)
    .flatMap((item) => [item?.desc, item?.firstTip, item?.chatDesc])));
  return sections.join("\n\n");
}

module.exports = {
  normalizeText,
  parseBoolean,
  safeArray,
  uniqueValues,
  extractStructuredText,
  stripHtml,
  normalizeRichText,
  firstNonEmptyText,
  originalTextList,
  joinOriginalText,
  firstNonEmptyArray,
  normalizeResumeDate,
  formatResumeTimeRange,
  detailRootFromResumePayload,
  hasResumeDetailPayload,
  extractTypedGeekIdentity,
  getSnapshotCandidateGeekId,
  getSnapshotCandidateGeekIds,
  getCandidateLookupKeys,
  getCandidateSecurityId,
  resumeDetailIdentityMatches,
  normalizeWorkEntry,
  normalizeEducationEntry,
  extractResumeWorkHistoryFromPayload,
  extractResumeEducationFromPayload,
  extractResumeProjectsFromPayload,
  extractResumeExpectationsFromPayload,
  extractResumeSkillsFromPayload,
  extractResumeCertificationsFromPayload,
  mergeProfileEntries,
  mergeWorkHistories,
  mergeEducation,
  parseGeek,
  parseResumeDetail,
  mergeCandidateDetail,
  applyResumeDetailToCandidate,
  getCandidateInfoFromResumePayload,
  formatResumeApiData
};
