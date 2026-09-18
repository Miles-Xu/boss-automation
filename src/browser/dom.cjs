const sessions = new WeakMap();

function bindSessionClient(client, session) {
  sessions.set(client, session);
}

function assertClientActive(client) {
  sessions.get(client)?.assertActive();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pause(client, ms) {
  const session = sessions.get(client);
  if (session) await session.sleep(ms);
  else await sleep(ms);
}

async function call(client, domain, method, params) {
  sessions.get(client)?.assertActive();
  const result = await client[domain][method](params);
  sessions.get(client)?.assertActive();
  return result;
}

async function getDocRoot(client) {
  const { root } = await call(client, "DOM", "getDocument", { depth: -1, pierce: true });
  return { nodeId: root.nodeId, root };
}

async function findIframeDoc(client, rootNodeId, selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  for (const selector of list) {
    if (!selector) continue;
    const nodeId = await querySelector(client, rootNodeId, selector);
    if (!nodeId) continue;
    const node = await describeNode(client, nodeId);
    if (node?.contentDocument?.nodeId) return { iframeNodeId: nodeId, docNodeId: node.contentDocument.nodeId, selector };
  }
  return null;
}

async function querySelector(client, parentNodeId, selector) {
  const { nodeId } = await call(client, "DOM", "querySelector", { nodeId: parentNodeId, selector });
  return nodeId || null;
}

async function querySelectorAll(client, parentNodeId, selector) {
  const { nodeIds } = await call(client, "DOM", "querySelectorAll", { nodeId: parentNodeId, selector });
  return Array.isArray(nodeIds) ? nodeIds : [];
}

async function getOuterHTML(client, nodeId) {
  const { outerHTML } = await call(client, "DOM", "getOuterHTML", { nodeId });
  return outerHTML || "";
}

async function getAttributes(client, nodeId) {
  const { attributes } = await call(client, "DOM", "getAttributes", { nodeId });
  const out = {};
  const entries = Array.isArray(attributes) ? attributes : [];
  for (let index = 0; index < entries.length; index += 2) {
    Object.defineProperty(out, entries[index], { value: entries[index + 1] ?? "", enumerable: true, configurable: true, writable: true });
  }
  return out;
}

async function describeNode(client, nodeId, depth = 1) {
  return (await call(client, "DOM", "describeNode", { nodeId, depth, pierce: true })).node;
}

async function waitForSelector(client, parentNodeIdGetter, selector, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const intervalMs = opts.intervalMs ?? 200;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError("Invalid selector wait duration");
  const start = Date.now();
  do {
    sessions.get(client)?.assertActive();
    let parent;
    try {
      parent = typeof parentNodeIdGetter === "function" ? await parentNodeIdGetter() : parentNodeIdGetter;
      if (parent) {
        const nodeId = await querySelector(client, parent, selector);
        if (nodeId) return nodeId;
      }
    } catch (error) {
      sessions.get(client)?.assertActive();
      if (error?.code) throw error;
    }
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) break;
    await pause(client, Math.min(intervalMs, remaining));
  } while (Date.now() - start <= timeoutMs);
  return null;
}

async function getBoxCenter(client, nodeId) {
  const { model } = await call(client, "DOM", "getBoxModel", { nodeId });
  const quad = model?.border?.length ? model.border : model?.content || [];
  if (quad.length < 8 || !quad.every(Number.isFinite)) throw new Error("Invalid node box model");
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

async function scrollIntoView(client, nodeId) {
  // Do not click a stale/offscreen node when scrolling fails.
  await call(client, "DOM", "scrollIntoViewIfNeeded", { nodeId });
}

async function clickAt(client, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError("Mouse coordinates must be finite numbers");
  await call(client, "Input", "dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await pause(client, 60);
  await call(client, "Input", "dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await pause(client, 60);
  await call(client, "Input", "dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function clickNode(client, nodeId) {
  await scrollIntoView(client, nodeId);
  await pause(client, 80);
  const center = await getBoxCenter(client, nodeId);
  await clickAt(client, center.x, center.y);
  return center;
}

async function pressKey(client, key, opts = {}) {
  const code = opts.code || key;
  const windowsVirtualKeyCode = opts.windowsVirtualKeyCode;
  const nativeVirtualKeyCode = opts.nativeVirtualKeyCode ?? windowsVirtualKeyCode;
  const modifiers = opts.modifiers || 0;
  await call(client, "Input", "dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, nativeVirtualKeyCode, text: opts.text || "", modifiers });
  await call(client, "Input", "dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode, nativeVirtualKeyCode, modifiers });
}

async function insertText(client, text) {
  await call(client, "Input", "insertText", { text: String(text ?? "") });
}

async function findFirstNode(client, parentNodeId, selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  for (const selector of list) {
    if (!selector) continue;
    const nodeId = await querySelector(client, parentNodeId, selector);
    if (nodeId) return { selector, nodeId };
  }
  return null;
}

async function wheelAt(client, x, y, deltaY = 720) {
  await call(client, "Input", "dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await call(client, "Input", "dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
}

async function scrollLastChildIntoView(client, parentDocNodeId, cardSelector) {
  const ids = await querySelectorAll(client, parentDocNodeId, cardSelector);
  if (!ids.length) return { ok: false, error: "NO_CARDS" };
  const lastNodeId = ids[ids.length - 1];
  await scrollIntoView(client, lastNodeId);
  return { ok: true, cardCount: ids.length, lastNodeId };
}

module.exports = {
  bindSessionClient, assertClientActive, getDocRoot, findIframeDoc, querySelector, querySelectorAll,
  getOuterHTML, getAttributes, describeNode, waitForSelector, getBoxCenter,
  scrollIntoView, scrollNodeToTop: scrollIntoView, scrollLastChildIntoView,
  wheelAt, clickAt, clickNode, pressKey, insertText, findFirstNode, sleep
};
