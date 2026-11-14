// Regression tests for setup/harness robustness: atomic policy writes,
// unique preinstall temp files, and cheap-by-default status polls.
//
//   node --test tests/setup-harness-robustness.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_POLICY,
  normalizePolicy,
  readPolicy,
  readUpdateState,
  writePolicy,
  writeUpdateState,
} from "../docker/setup/auto-update.mjs";
import { createHarnessCache } from "../docker/setup/cache.mjs";
import { createHarnessManager } from "../docker/harness/index.mjs";
import { runPreinstall } from "../docker/harness/preinstall.mjs";

const STATE_DIR = "/home/t3/.local/state/mise";

/** In-memory fs with tmp+rename semantics and wx support. */
function memoryFs({ failRename = false } = {}) {
  const files = new Map();
  const writtenTemps = [];
  const fs = {
    files,
    writtenTemps,
    async readFile(file) {
      if (!files.has(file)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
      return files.get(file);
    },
    async writeFile(file, data, options = {}) {
      const flag = typeof options === "object" ? options.flag : undefined;
      if (flag === "wx" && files.has(file)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      if (file.includes(".tmp.")) writtenTemps.push(file);
      files.set(file, String(data));
    },
    async mkdir() {},
    async rename(from, to) {
      if (failRename) throw Object.assign(new Error("EIO: power loss"), { code: "EIO" });
      if (!files.has(from)) throw Object.assign(new Error(`ENOENT: ${from}`), { code: "ENOENT" });
      files.set(to, files.get(from));
      files.delete(from);
    },
    async rm(file, options = {}) {
      if (!files.has(file) && options.force) return;
      files.delete(file);
    },
  };
  return fs;
}

test("a crash between temp write and rename keeps the prior policy", async () => {
  // Seed a complete policy with a working fs, then fail renames to simulate
  // power loss mid-commit.
  const seed = memoryFs();
  const enabled = normalizePolicy({ providers: { enabled: true, checkMinutes: 60, idleMinutes: 10 } });
  await writePolicy(seed, STATE_DIR, { providers: { enabled: true, checkMinutes: 60, idleMinutes: 10 } });
  const committed = seed.files.get(`${STATE_DIR}/setup/auto-update.json`);
  assert.ok(committed.includes('"enabled": true'));

  const crashing = memoryFs({ failRename: true });
  crashing.files.set(`${STATE_DIR}/setup/auto-update.json`, committed);
  await assert.rejects(() => writePolicy(crashing, STATE_DIR, { providers: { enabled: false } }));
  // The target still holds the whole prior document: readers never see a mix.
  assert.equal(crashing.files.get(`${STATE_DIR}/setup/auto-update.json`), committed);
  assert.deepEqual(await readPolicy(crashing, STATE_DIR), enabled);
});

test("concurrent policy writes land whole, never torn", async () => {
  const fs = memoryFs();
  const a = { providers: { enabled: true, checkMinutes: 60, idleMinutes: 10 } };
  const b = { toolchains: { enabled: true, checkMinutes: 120, idleMinutes: 20 } };
  await Promise.all([writePolicy(fs, STATE_DIR, a), writePolicy(fs, STATE_DIR, b)]);
  const raw = fs.files.get(`${STATE_DIR}/setup/auto-update.json`);
  const parsed = JSON.parse(raw);
  assert.ok(
    (parsed.providers.enabled === true && parsed.toolchains.enabled === false) ||
    (parsed.providers.enabled === false && parsed.toolchains.enabled === true),
    `expected one whole write to win, got ${raw}`,
  );
  // Unique temp names per write: no shared pid-only path to interleave on.
  assert.ok(fs.writtenTemps.length >= 2, `expected temp files, got ${fs.writtenTemps}`);
  assert.equal(new Set(fs.writtenTemps).size, fs.writtenTemps.length, "temp names collided");
  assert.ok(fs.writtenTemps.every((tmp) => !tmp.endsWith(`.tmp.${process.pid}`)), "pid-only temp name used");
});

test("a torn policy file recovers to defaults (schedules stay off, never half-on)", async () => {
  const fs = memoryFs();
  fs.files.set(`${STATE_DIR}/setup/auto-update.json`, '{"version":2,"providers":{"enabled":tru');
  assert.deepEqual(await readPolicy(fs, STATE_DIR), JSON.parse(JSON.stringify(DEFAULT_POLICY)));
  const stateFs = memoryFs();
  stateFs.files.set(`${STATE_DIR}/setup/auto-update-state.json`, '{"lastProviderCheckAt":12');
  const state = await readUpdateState(stateFs, STATE_DIR);
  assert.equal(state.lastProviderCheckAt, null);
  assert.equal(state.lastProviderRunAt, null);
});

test("a crash between temp write and rename keeps the prior update state", async () => {
  const seed = memoryFs();
  await writeUpdateState(seed, STATE_DIR, { lastResult: "before" });
  const committed = seed.files.get(`${STATE_DIR}/setup/auto-update-state.json`);
  const crashing = memoryFs({ failRename: true });
  crashing.files.set(`${STATE_DIR}/setup/auto-update-state.json`, committed);
  await assert.rejects(() => writeUpdateState(crashing, STATE_DIR, { lastResult: "after" }));
  assert.equal(crashing.files.get(`${STATE_DIR}/setup/auto-update-state.json`), committed);
  assert.equal((await readUpdateState(crashing, STATE_DIR)).lastResult, "before");
});

/** Fake manager with the preinstall surface: nothing installed, installs stick. */
function fakeManager() {
  const present = new Set();
  const side = () => ({
    async resolve(id) {
      return { id, installed: present.has(id), installedVersion: present.has(id) ? "9.9.9" : null,
        version: present.has(id) ? "9.9.9" : null, providedBy: null };
    },
    async install(id) {
      present.add(id);
      return { ok: true, code: "ok", harness: { installed: true, installedVersion: "9.9.9" } };
    },
  });
  const manager = side("agent");
  manager.toolchains = side("toolchain");
  manager.sourceControl = side("source-control");
  manager.refreshLinks = async () => {};
  return manager;
}

const preinstallRun = (fs, env, extra = {}) => runPreinstall({
  manager: fakeManager(),
  fs,
  env,
  stateDir: STATE_DIR,
  sleep: async () => {},
  now: () => 1_700_000_000_000,
  pid: 4242,
  startTimeOf: () => "100",
  log: () => {},
  ...extra,
});

test("concurrent preinstall writes use unique temp names, never a pid-only clobber", async () => {
  const fs = memoryFs();
  await Promise.all([
    preinstallRun(fs, { T3_PREINSTALL: "claude" }),
    preinstallRun(fs, { T3_PREINSTALL: "codex" }),
  ]);
  assert.ok(fs.writtenTemps.length >= 2, `expected temp files, got ${fs.writtenTemps}`);
  assert.equal(new Set(fs.writtenTemps).size, fs.writtenTemps.length, "temp names collided");
  assert.ok(
    fs.writtenTemps.every((tmp) => !tmp.endsWith(`.tmp.${process.pid}`) && !tmp.endsWith(".tmp.4242")),
    `pid-only temp name used: ${fs.writtenTemps}`,
  );
  // Whatever won, the record is whole JSON, not interleaved fragments.
  const record = JSON.parse(fs.files.get(`${STATE_DIR}/t3-preinstall.json`));
  assert.equal(record.schema, 1);
  assert.ok(record.items && typeof record.items === "object");
});

test("a stale pid-only temp from a crashed run is left alone and never read", async () => {
  const fs = memoryFs();
  // The exact pid-only name the old code wrote: a crashed run may have left
  // it behind with a torn document in it.
  const stale = `${STATE_DIR}/t3-preinstall.json.tmp.${process.pid}`;
  fs.files.set(stale, '{"torn":');
  await preinstallRun(fs, { T3_PREINSTALL: "claude" });
  assert.equal(fs.files.get(stale), '{"torn":', "stale temp was touched");
  const record = JSON.parse(fs.files.get(`${STATE_DIR}/t3-preinstall.json`));
  assert.equal(record.schema, 1);
  assert.equal(record.items["agent:claude"]?.state, "done");
});

// --- cheap-by-default status polls -------------------------------------------

const HOME = "/home/t3";
const INSTALL = path.join(HOME, ".local/share/mise/installs/claude/2.1.0");
const EXECUTABLE = path.join(INSTALL, "claude");

/** Manager world with claude installed; counts non-mise CLI probe subprocesses. */
function probeWorld() {
  const files = new Map();
  const probes = [];
  const miseListing = {
    claude: [{
      version: "2.1.0",
      requested_version: "2.1.0",
      install_path: INSTALL,
      installed: true,
      active: true,
      source: { type: "mise.toml", path: path.join(HOME, ".config/mise/config.toml") },
    }],
  };
  const fs = {
    async readFile(file) {
      if (!files.has(file)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
      return files.get(file);
    },
    async writeFile(file, data) { files.set(file, String(data)); },
    async mkdir() {},
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
    async stat(target) {
      if (target === EXECUTABLE) return { isFile: () => true, mode: 0o755, mtimeMs: 1, size: 8 };
      throw Object.assign(new Error(`ENOENT: ${target}`), { code: "ENOENT" });
    },
    async exists() { return false; },
    async readdir() { return []; },
  };
  const run = async (argv) => {
    if (argv[0] === "mise") return { code: 0, stdout: JSON.stringify(miseListing), stderr: "", error: null };
    probes.push(argv);
    if (argv[0] === EXECUTABLE) return { code: 0, stdout: '{"loggedIn":true}', stderr: "", error: null };
    return { code: 0, stdout: "", stderr: "", error: null };
  };
  const manager = createHarnessManager({
    env: {},
    home: HOME,
    fs,
    run,
    now: () => 1_700_000_000_000,
    pid: 4242,
    arch: "x64",
  });
  return { manager, probes };
}

test("status() defaults to cheap: no CLI probes spawned", async () => {
  const { manager, probes } = probeWorld();
  const { harnesses } = await manager.status();
  const claude = harnesses.find((row) => row.id === "claude");
  assert.equal(claude.installed, true);
  assert.equal(claude.authenticated, null, "cheap polls report no verdict, not a fresh probe");
  assert.deepEqual(probes, [], "default status() must not fork CLI probes");
});

test("status({ authenticate: true }) still probes for a fresh verdict", async () => {
  const { manager, probes } = probeWorld();
  const { harnesses } = await manager.status({ authenticate: true });
  const claude = harnesses.find((row) => row.id === "claude");
  assert.equal(claude.authenticated, true);
  assert.ok(probes.some((argv) => argv[0] === EXECUTABLE), "expected a CLI probe");
});

test("resolve() still probes by default, for callers that need fresh auth", async () => {
  const { manager, probes } = probeWorld();
  const facts = await manager.resolve("claude");
  assert.equal(facts.authenticated, true);
  assert.ok(probes.some((argv) => argv[0] === EXECUTABLE), "expected a CLI probe");
});

test("auth refresh happens only on TTL expiry or mutation", async () => {
  let fullCalls = 0;
  let clock = 1_000_000;
  const cache = createHarnessCache({
    full: async () => {
      fullCalls += 1;
      return { harnesses: [{ id: "claude", signedIn: true }], degraded: [] };
    },
    cheap: async () => ({ harnesses: [{ id: "claude", signedIn: false }], degraded: [] }),
    budgetMs: 1000,
    refreshIntervalMs: 15 * 60 * 1000,
    now: () => clock,
  });
  await cache.snapshot();
  assert.equal(fullCalls, 1);
  // Polls inside the 15-minute window reuse the warm verdicts, no refresh.
  for (let poll = 0; poll < 5; poll += 1) {
    clock += 15_000;
    const snap = await cache.snapshot();
    assert.equal(snap.source, "cache");
    assert.deepEqual(snap.harnesses, [{ id: "claude", signedIn: true }]);
  }
  assert.equal(fullCalls, 1, "polls must not re-probe inside the TTL");
  // A mutation invalidates: the next poll refreshes immediately.
  await cache.invalidate();
  assert.equal(fullCalls, 2);
});
