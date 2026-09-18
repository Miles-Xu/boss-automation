const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Keep these names and the lock layout compatible with the existing workbench.
const ENV_PORT = "BOSS_BROWSER_LEASE_PORT";
const ENV_TOKEN = "BOSS_BROWSER_LEASE_TOKEN";
const ENV_ROOT = "BOSS_BROWSER_LEASE_ROOT";
const TOKEN_PATTERN = /^[a-f0-9-]{36}$/;

function defaultLockRoot() {
  const user = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
  return path.join(os.tmpdir(), `boss-hr-workbench-browser-leases-${encodeURIComponent(user)}`);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : { invalid: true };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return { invalid: true };
    throw error;
  }
}

function publishJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    fs.linkSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function leaseDirectory(root, token) {
  return TOKEN_PATTERN.test(token || "") ? path.join(root, token) : null;
}

function participantsAt(directory) {
  let files;
  try {
    files = fs.readdirSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [{ invalid: true }];
    throw error;
  }
  return files.filter((name) => /^participant-.*\.json$/.test(name))
    .map((name) => readJson(path.join(directory, name)))
    .filter((entry) => entry && (entry.invalid || processIsAlive(entry.pid)))
    .map((entry) => entry.invalid ? { invalid: true } : { pid: entry.pid, owner: entry.owner, startedAt: entry.startedAt });
}

class BrowserBusyError extends Error {
  constructor(port, record, participants = [], cleanupInterrupted = false) {
    const active = participants.find((entry) => entry.pid) || record || {};
    const owner = active.owner || record?.owner || "unknown browser operation";
    super(`Chrome port ${port} is busy: ${owner}${active.pid ? ` (PID ${active.pid})` : ""}`);
    this.name = "BrowserBusyError";
    this.code = "BROWSER_BUSY";
    this.port = port;
    this.owner = owner;
    this.pid = active.pid || null;
    this.startedAt = active.startedAt || record?.startedAt || null;
    this.participants = participants;
    this.cleanupInterrupted = cleanupInterrupted;
  }

  toJSON() {
    return {
      code: this.code, message: this.message, port: this.port,
      owner: this.owner, pid: this.pid, startedAt: this.startedAt,
      participants: this.participants, cleanupInterrupted: this.cleanupInterrupted
    };
  }
}

class BrowserLeaseLostError extends Error {
  constructor(port) {
    super(`Chrome lease for port ${port} is no longer active`);
    this.name = "BrowserLeaseLostError";
    this.code = "BROWSER_LEASE_LOST";
    this.port = port;
  }
}

// A generation has one retirement claim; interrupted cleanup stays occupied.
function retireIfUnused(root, activeFile, record) {
  const directory = leaseDirectory(root, record?.token);
  if (!directory) return { retired: false, participants: [{ invalid: true }] };
  if (readJson(activeFile)?.token !== record.token) return { retired: true };
  const closingFile = path.join(directory, "closing.json");
  const before = participantsAt(directory);
  if (before.length) return { retired: false, participants: before };
  try {
    publishJson(closingFile, { pid: process.pid, token: randomUUID() });
  } catch (error) {
    if (error.code === "ENOENT") return { retired: readJson(activeFile)?.token !== record.token };
    if (error.code !== "EEXIST") throw error;
    const closing = readJson(closingFile);
    return { retired: false, participants: participantsAt(directory), cleanupInterrupted: !closing || closing.invalid || !processIsAlive(closing.pid) };
  }
  const participants = participantsAt(directory);
  if (participants.length) {
    fs.unlinkSync(closingFile);
    return { retired: false, participants };
  }
  if (readJson(activeFile)?.token === record.token) fs.unlinkSync(activeFile);
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 1 });
  } catch (error) {
    // A contender can still be publishing into this retired generation.
    if (error.code !== "ENOTEMPTY") throw error;
  }
  return { retired: true };
}

function makeHandle({ root, activeFile, record, participantFile, inherited }) {
  let released = false;
  const assertActive = () => {
    const participant = readJson(participantFile);
    if (released || readJson(activeFile)?.token !== record.token || !participant || participant.invalid
      || participant.pid !== process.pid
      || fs.existsSync(path.join(path.dirname(participantFile), "closing.json"))) {
      throw new BrowserLeaseLostError(record.port);
    }
  };
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", onExit);
    fs.rmSync(participantFile, { force: true });
    retireIfUnused(root, activeFile, record);
  };
  const onExit = () => {
    try { release(); } catch { /* Leave the port occupied if cleanup cannot be confirmed. */ }
  };
  process.once("exit", onExit);
  return {
    port: record.port, token: record.token, owner: record.owner, inherited,
    env: { [ENV_PORT]: String(record.port), [ENV_TOKEN]: record.token, [ENV_ROOT]: root },
    assertActive, release
  };
}

function joinLease({ root, activeFile, port, token, owner }) {
  const directory = leaseDirectory(root, token);
  const record = readJson(activeFile);
  if (!directory || record?.token !== token) throw new BrowserLeaseLostError(port);
  const closingFile = path.join(directory, "closing.json");
  if (fs.existsSync(closingFile)) throw new BrowserBusyError(port, record, participantsAt(directory));
  const participantFile = path.join(directory, `participant-${process.pid}-${randomUUID()}.json`);
  try {
    publishJson(participantFile, { pid: process.pid, owner, startedAt: new Date().toISOString() });
    // Participation must be visible before checking concurrent retirement.
    if (fs.existsSync(closingFile) || readJson(activeFile)?.token !== token) throw new BrowserLeaseLostError(port);
    return makeHandle({ root, activeFile, record, participantFile, inherited: true });
  } catch (error) {
    fs.rmSync(participantFile, { force: true });
    if (error.code === "ENOENT") throw new BrowserLeaseLostError(port);
    throw error;
  }
}

function acquireBrowserLease({ port = 9222, owner = "browser operation", env = process.env, lockRoot } = {}) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("Browser port must be an integer from 1 to 65535");
  owner = String(owner).trim().slice(0, 240) || "browser operation";
  const root = path.resolve(lockRoot || env[ENV_ROOT] || defaultLockRoot());
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const activeFile = path.join(root, `port-${port}.json`);
  if (env[ENV_TOKEN] && Number(env[ENV_PORT]) === port) {
    return joinLease({ root, activeFile, port, token: env[ENV_TOKEN], owner });
  }
  const token = randomUUID();
  const directory = leaseDirectory(root, token);
  fs.mkdirSync(directory, { mode: 0o700 });
  const record = { token, port, owner, pid: process.pid, startedAt: new Date().toISOString() };
  const recordFile = path.join(directory, "owner.json");
  const participantFile = path.join(directory, `participant-${process.pid}-${randomUUID()}.json`);
  let acquired = false;
  try {
    fs.writeFileSync(recordFile, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    fs.writeFileSync(participantFile, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        fs.linkSync(recordFile, activeFile);
        acquired = true;
        return makeHandle({ root, activeFile, record, participantFile, inherited: false });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const current = readJson(activeFile);
      if (!current) continue;
      const result = retireIfUnused(root, activeFile, current);
      if (result.retired) continue;
      throw new BrowserBusyError(port, current, result.participants, result.cleanupInterrupted);
    }
    throw new BrowserBusyError(port, readJson(activeFile));
  } finally {
    if (!acquired) fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { acquireBrowserLease, BrowserBusyError, BrowserLeaseLostError, defaultLockRoot };
