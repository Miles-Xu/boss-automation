const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { acquireBrowserLease, defaultLockRoot } = require("../src/browser/lease.cjs");

function root(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-automation-lease-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("shared lock naming and inherited participants keep the browser occupied", (t) => {
  const lockRoot = root(t);
  assert.match(defaultLockRoot(), /boss-hr-workbench-browser-leases-/);
  const first = acquireBrowserLease({ lockRoot, env: {}, owner: "fixture parent" });
  t.after(first.release);
  assert.equal(first.env.BOSS_BROWSER_LEASE_PORT, "9222");
  assert.equal(first.env.BOSS_BROWSER_LEASE_TOKEN, first.token);
  assert.equal(first.env.BOSS_BROWSER_LEASE_ROOT, lockRoot);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockRoot, "port-9222.json"))).token, first.token);
  assert.throws(() => acquireBrowserLease({ lockRoot, env: {} }), { code: "BROWSER_BUSY" });
  const second = acquireBrowserLease({ env: first.env, owner: "fixture child" });
  t.after(second.release);
  assert.equal(second.inherited, true);
  first.release();
  second.assertActive();
  assert.throws(() => acquireBrowserLease({ lockRoot, env: {} }), { code: "BROWSER_BUSY" });
  second.release();
  assert.throws(second.assertActive, { code: "BROWSER_LEASE_LOST" });
  const third = acquireBrowserLease({ lockRoot, env: {} });
  t.after(third.release);
  assert.notEqual(third.token, first.token);
  assert.throws(() => acquireBrowserLease({ lockRoot, env: first.env }), { code: "BROWSER_LEASE_LOST" });
});

test("pre-existing compatible workbench records are honored without importing production", (t) => {
  const lockRoot = root(t);
  const token = randomUUID();
  const generation = path.join(lockRoot, token);
  const record = { token, port: 9222, owner: "synthetic workbench", pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" };
  fs.mkdirSync(generation);
  fs.writeFileSync(path.join(lockRoot, "port-9222.json"), JSON.stringify(record));
  fs.writeFileSync(path.join(generation, "owner.json"), JSON.stringify(record));
  fs.writeFileSync(path.join(generation, `participant-${process.pid}-synthetic.json`), JSON.stringify(record));
  assert.throws(() => acquireBrowserLease({ lockRoot, env: {} }), { code: "BROWSER_BUSY", owner: "synthetic workbench" });
  const child = acquireBrowserLease({ env: { BOSS_BROWSER_LEASE_PORT: "9222", BOSS_BROWSER_LEASE_TOKEN: token, BOSS_BROWSER_LEASE_ROOT: lockRoot } });
  t.after(child.release);
  child.assertActive();
  child.release();
  assert.ok(fs.existsSync(path.join(lockRoot, "port-9222.json")));
});

test("invalid records fail closed and a retired generation can be reclaimed", (t) => {
  const lockRoot = root(t);
  fs.writeFileSync(path.join(lockRoot, "port-9222.json"), "{");
  assert.throws(() => acquireBrowserLease({ lockRoot, env: {} }), { code: "BROWSER_BUSY" });
  fs.unlinkSync(path.join(lockRoot, "port-9222.json"));
  const token = randomUUID();
  const generation = path.join(lockRoot, token);
  const record = { token, port: 9222, owner: "retired fixture", pid: process.pid };
  fs.mkdirSync(generation);
  fs.writeFileSync(path.join(lockRoot, "port-9222.json"), JSON.stringify(record));
  fs.writeFileSync(path.join(generation, "owner.json"), JSON.stringify(record));
  const next = acquireBrowserLease({ lockRoot, env: {} });
  t.after(next.release);
  assert.notEqual(next.token, token);
  assert.ok(!fs.existsSync(generation));
});
