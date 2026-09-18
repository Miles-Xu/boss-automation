const SIGNATURES = ["您的账号可能存在异常访问行为", "完成验证后即可正常使用", "请完成安全验证", "请完成人机验证"];
const SEARCH_BATCH_SIZE = 20;

class BossSafetyError extends Error {
  constructor(code, message, evidence = {}) {
    super(message);
    this.name = "BossSafetyError";
    this.code = code;
    this.retryable = false;
    this.evidence = evidence;
  }
}

function isSafetyStop(error) {
  return ["BOSS_ANTIBOT_TRIGGERED", "BOSS_PAGE_CHECK_FAILED", "BOSS_RATE_LIMITED", "BOSS_LOGIN_REQUIRED", "BOSS_TARGET_CHANGED"].includes(error?.code);
}

function isChallengeUrl(value) {
  try {
    const url = new URL(value);
    return /(?:^|\.)(?:zhipin\.com|geetest\.com|dun\.163\.com)$/.test(url.hostname)
      && /(?:captcha|security-check|\/verify(?:\/|$)|\/safe\/)/i.test(url.pathname);
  } catch { return false; }
}

function isRecommendUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && ["www.zhipin.com", "zhipin.com"].includes(url.hostname)
      && (!url.port || url.port === "443")
      && /^\/web\/chat\/recommend\/?$/.test(url.pathname);
  } catch { return false; }
}

function isLoginUrl(value) {
  try {
    const url = new URL(value);
    return ["www.zhipin.com", "zhipin.com"].includes(url.hostname)
      && /\/web\/(?:user|boss\/signup)(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}

function resolveRedirect(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try { return new URL(value, "https://www.zhipin.com").href; }
  catch { return ""; }
}

function frameUrls(tree) {
  return [tree?.frame?.url || "", ...(tree?.childFrames || []).flatMap(frameUrls)];
}

async function visible(call, nodeId) {
  try {
    const { model } = await call("DOM", "getBoxModel", { nodeId });
    if (!model || !Number.isFinite(model.width) || !Number.isFinite(model.height)) throw new Error("Invalid warning box model");
    return model?.width > 0 && model?.height > 0;
  } catch (error) {
    // Chrome reports this specific protocol error for nodes without a layout box.
    if (error?.code === -32000 && /^Could not compute box model\.?$/.test(error.message || "")) return false;
    throw error;
  }
}

async function inspectBossPage(client, { assertActive = () => assertClientActive(client) } = {}) {
  let searchId;
  const call = async (domain, method, params) => {
    assertActive();
    const result = await client[domain][method](params);
    assertActive();
    return result;
  };
  try {
    const { frameTree } = await call("Page", "getFrameTree");
    const urls = frameUrls(frameTree);
    if (urls.some(isChallengeUrl)) return { detected: true, signal: "challenge_url" };
    if (urls.some(isLoginUrl)) throw new BossSafetyError("BOSS_LOGIN_REQUIRED", "BOSS login is required");
    if (!isRecommendUrl(urls[0])) throw new BossSafetyError("BOSS_TARGET_CHANGED", "The selected tab is no longer the BOSS recommendation page");
    await call("DOM", "getDocument", { depth: 1 });
    const query = `//*[not(self::script) and not(self::style) and not(self::noscript) and (${SIGNATURES.map((s) => `contains(text(), '${s}')`).join(" or ")})]`;
    assertActive();
    const search = await client.DOM.performSearch({ query, includeUserAgentShadowDOM: false });
    searchId = search.searchId;
    assertActive();
    if (!searchId || !Number.isSafeInteger(search.resultCount) || search.resultCount < 0) throw new Error("Invalid warning search result");
    for (let fromIndex = 0; fromIndex < search.resultCount; fromIndex += SEARCH_BATCH_SIZE) {
      const toIndex = Math.min(search.resultCount, fromIndex + SEARCH_BATCH_SIZE);
      const { nodeIds } = await call("DOM", "getSearchResults", { searchId, fromIndex, toIndex });
      if (!Array.isArray(nodeIds) || nodeIds.length !== toIndex - fromIndex
        || nodeIds.some(nodeId => !Number.isSafeInteger(nodeId) || nodeId < 1)) throw new Error("Incomplete warning search results");
      for (const nodeId of nodeIds) {
        assertActive();
        if (await visible(call, nodeId)) return { detected: true, signal: "visible_verification_message" };
      }
    }
    return { detected: false };
  } catch (error) {
    assertActive();
    if (isSafetyStop(error)) throw error;
    throw new BossSafetyError("BOSS_PAGE_CHECK_FAILED", "Could not verify the BOSS page state");
  } finally {
    if (searchId) await client.DOM.discardSearchResults({ searchId }).catch(() => {});
  }
}

function checkDetailResponse(response, parsed) {
  const message = String(parsed?.message || parsed?.msg || parsed?.zpData?.message || "");
  const urls = [response?.url, resolveRedirect(parsed?.zpData?.redirectUrl)];
  const text = typeof response?.text === "string" ? response.text : "";
  // Inspect HTML error documents, never a JSON candidate payload containing these words.
  const verificationHtml = /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(text)
    && SIGNATURES.some((value) => text.includes(value));
  if (SIGNATURES.some((value) => message.includes(value)) || urls.some(isChallengeUrl) || verificationHtml) {
    throw new BossSafetyError("BOSS_ANTIBOT_TRIGGERED", "BOSS requires security verification", { signal: "detail_response", status: response?.status, platformCode: parsed?.code });
  }
  if (response?.status === 429) throw new BossSafetyError("BOSS_RATE_LIMITED", "BOSS rate limit reached", { status: 429 });
  if (response?.status === 401 || urls.some(isLoginUrl)) throw new BossSafetyError("BOSS_LOGIN_REQUIRED", "BOSS login is required", { status: response?.status });
}

module.exports = { SIGNATURES, BossSafetyError, isSafetyStop, isChallengeUrl, isRecommendUrl, inspectBossPage, checkDetailResponse };
const { assertClientActive } = require("./dom.cjs");
