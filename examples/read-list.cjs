"use strict";
const { parseArgs } = require("node:util");
const { connect, readCandidates } = require("boss-automation");

async function readList(connectionOptions = {}) {
  const session = await connect(connectionOptions);
  try {
    return await readCandidates(session);
  } finally {
    await session.close();
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    host: { type: "string" },
    port: { type: "string" },
    target: { type: "string" }
  } });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  try {
    const snapshot = await readList({
      host: values.host,
      port: values.port,
      targetId: values.target,
      signal: controller.signal
    });
    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.code || error.message);
  process.exitCode = 1;
});

module.exports = { readList };
