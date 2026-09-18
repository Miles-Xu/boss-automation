"use strict";
const { ResponseMonitor } = require("./network.cjs");

async function startListCapture(session, { maxEntries = 200 } = {}) {
  return session.run(async () => {
    const monitor = await new ResponseMonitor(session, { maxEntries, kinds: ["list"] }).start();
    const assertOpen = () => {
      session.assertActive();
      if (!monitor.active) throw Object.assign(new Error("List capture is closed"), { code: "CAPTURE_CLOSED" });
    };
    return {
      mark() { assertOpen(); return monitor.mark(); },
      async read({ after = 0, timeoutMs = 5000 } = {}) {
        if (!Number.isSafeInteger(after) || after < 0) throw new RangeError("after must be a nonnegative request marker");
        return session.run(async () => {
          assertOpen();
          await monitor.flush({ timeoutMs });
          assertOpen();
          return monitor.lists.filter(entry => entry.sequence > after).map(entry => structuredClone({
            sequence: entry.sequence,
            request: { url: entry.url, params: entry.params },
            payload: entry.payload
          }));
        });
      },
      close() { return monitor.close(); }
    };
  });
}

module.exports = { startListCapture };
