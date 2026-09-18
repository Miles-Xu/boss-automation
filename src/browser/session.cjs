const { acquireBrowserLease } = require("./lease.cjs");
const { BossSafetyError, isRecommendUrl, inspectBossPage, isSafetyStop } = require("./safety.cjs");
const { bindSessionClient } = require("./dom.cjs");

function sessionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function selectTarget(targets, targetId) {
  const pages = (Array.isArray(targets) ? targets : []).filter((target) => target?.type === "page");
  const matching = pages.filter((target) => (!targetId || target.id === targetId) && isRecommendUrl(target.url));
  if (!matching.length) throw sessionError("BOSS_TARGET_NOT_FOUND", "No matching BOSS recommendation tab found");
  if (matching.length > 1) throw sessionError("BOSS_TARGET_AMBIGUOUS", "Multiple BOSS recommendation tabs found; provide targetId");
  return matching[0];
}

async function connect({ host = "127.0.0.1", port = 9222, targetId, signal, cdp, lockRoot, env = process.env } = {}) {
  if (signal?.aborted) throw sessionError("ABORTED", "Browser operation aborted");
  if (typeof host !== "string" || !host.trim()) throw new TypeError("Browser host must be a nonempty string");
  port = Number(port);
  const lease = acquireBrowserLease({ port, owner: "boss-automation", lockRoot, env });
  let client;
  let session;
  try {
    const CDP = cdp || require("chrome-remote-interface");
    const target = selectTarget(await CDP.List({ host, port }), targetId);
    if (signal?.aborted) throw sessionError("ABORTED", "Browser operation aborted");
    client = await CDP({ host, port, target });
    session = makeSession({ client, target, host, port, signal, lease });
    await session.check();
    return session;
  } catch (error) {
    if (session) await session.close().catch(() => {});
    else {
      try { if (client) await client.close(); }
      finally { lease.release(); }
    }
    throw error;
  }
}

function makeSession({ client, target, host, port, signal, lease }) {
  let terminalError;
  let closePromise;
  let busy = false;
  const cleanups = new Set();
  const cancellation = new AbortController();
  const stop = (error) => {
    if (!terminalError) terminalError = error;
    cancellation.abort();
    return terminalError;
  };
  const onAbort = () => stop(sessionError("ABORTED", "Browser operation aborted"));
  const onDisconnect = () => stop(sessionError("BROWSER_DISCONNECTED", "Chrome connection closed"));
  signal?.addEventListener("abort", onAbort, { once: true });
  client.on?.("disconnect", onDisconnect);
  if (signal?.aborted) onAbort();

  const session = {
    client, target, host, port, signal,
    stopOnSafetyError(error) {
      if (isSafetyStop(error)) stop(error);
    },
    assertActive() {
      if (signal?.aborted) onAbort();
      if (terminalError) throw terminalError;
      try { lease.assertActive(); }
      catch (error) { throw stop(error); }
    },
    async check() {
      session.assertActive();
      try {
        const state = await inspectBossPage(client, { assertActive: session.assertActive });
        session.assertActive();
        if (state.detected) throw new BossSafetyError("BOSS_ANTIBOT_TRIGGERED", "BOSS requires security verification", { signal: state.signal });
        return state;
      } catch (error) {
        throw stop(error);
      }
    },
    async evaluate(expression) {
      session.assertActive();
      if (typeof expression !== "string") throw new TypeError("Expression must be a string");
      const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      session.assertActive();
      if (result.exceptionDetails) throw sessionError("BROWSER_EVALUATION_FAILED", "Page evaluation failed");
      return result.result?.value;
    },
    async sleep(ms) {
      session.assertActive();
      if (!Number.isFinite(ms) || ms < 0 || ms > 2147483647) throw new TypeError("Sleep duration must be between 0 and 2147483647 milliseconds");
      await new Promise((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          cancellation.signal.removeEventListener("abort", cancel);
        };
        const cancel = () => { finish(); reject(terminalError); };
        const timer = setTimeout(() => { finish(); resolve(); }, ms);
        cancellation.signal.addEventListener("abort", cancel, { once: true });
      });
      session.assertActive();
    },
    async run(callback) {
      session.assertActive();
      if (busy) throw sessionError("SESSION_BUSY", "Another operation is using this browser session");
      if (typeof callback !== "function") throw new TypeError("Operation must be a function");
      busy = true;
      try {
        await session.check();
        const result = await callback(session);
        session.assertActive();
        return result;
      } catch (error) {
        if (isSafetyStop(error) || error?.code === "BROWSER_LEASE_LOST") stop(error);
        throw error;
      } finally { busy = false; }
    },
    addCleanup(callback) {
      session.assertActive();
      if (typeof callback !== "function") throw new TypeError("Cleanup must be a function");
      cleanups.add(callback);
      return () => cleanups.delete(callback);
    },
    close() {
      if (closePromise) return closePromise;
      stop(sessionError("SESSION_CLOSED", "Browser session closed"));
      signal?.removeEventListener("abort", onAbort);
      client.removeListener?.("disconnect", onDisconnect);
      closePromise = (async () => {
        const errors = [];
        for (const cleanup of [...cleanups].reverse()) {
          try { await cleanup(); } catch (error) { errors.push(error); }
        }
        cleanups.clear();
        // Keep the lease until CDP cleanup finishes; a failed close retains it.
        await client.close();
        lease.release();
        if (errors.length) throw new AggregateError(errors, "Browser cleanup failed");
      })();
      return closePromise;
    }
  };
  bindSessionClient(client, session);
  return session;
}

module.exports = { connect, selectTarget };
