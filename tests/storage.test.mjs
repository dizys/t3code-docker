import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { createStorageManager } from "../docker/harness/storage/manager.mjs";
import { checkCachePath, measureStorage, buildsOrInstallsRunning, detectCaches } from "../docker/harness/storage/system.mjs";
import { DEFAULT_POLICY, GB, readPolicy, writeStorageJson } from "../docker/harness/storage/policy.mjs";
import { runStorageCli } from "../docker/harness/storage/cli.mjs";
import { cacheSafety, CACHE_IDS } from "../docker/harness/storage/caches.mjs";

const idle = async () => ({ complete: true, processes: [] });
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-storage-test-"));
  const home = path.join(root, "home"), workspace = path.join(root, "workspace");
  const go = path.join(home, ".cache/go-build"), npm = path.join(home, ".npm");
  const sentinels = [path.join(workspace, "source.txt"), path.join(home, ".t3/userdata/history.db"), path.join(home, ".t3/agents/credentials"), path.join(npm, "_npx/tool"), path.join(home, ".t3/backups/backup.db")];
  for (const file of [...sentinels, path.join(go, "aa/archive"), path.join(npm, "_cacache/content/package")]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.alloc(8192, 65));
  }
  const calls = [];
  const env = { HOME: home, T3CODE_HOME: path.join(home, ".t3"), MISE_STATE_DIR: path.join(home, ".local/state/mise") };
  const base = { home, workspace, temporary: path.join(root, "tmp"), env, intervalMs: 0, refreshAfterCleanup: false,
    processes: idle, detectCaches: async () => ({ go: { path: go, executable: "/bin/go" }, npm: { path: npm, executable: "/bin/node", argsPrefix: ["/bin/npm"] } }),
    run: async (args, options) => {
      calls.push({ args, options });
      const target = args[0] === "/bin/go" ? go : path.join(npm, "_cacache");
      await fs.rm(target, { recursive: true, force: true });
      return { code: 0, stdout: "", stderr: "" };
    }, ...overrides };
  const manager = createStorageManager(base);
  t.after(async () => { manager.stop(); await fs.rm(root, { recursive: true, force: true }); });
  await manager.ready;
  return { manager, root, home, workspace, go, npm, env, calls, sentinels, base };
}

test("allocated inventory is cached; polling never detects tools or traverses folders", async (t) => {
  const f = await fixture(t);
  let detections = 0, scans = 0;
  const manager = createStorageManager({ ...f.base, detectCaches: async (...args) => { detections++; return f.base.detectCaches(...args); }, measure: async (...args) => { scans++; return measureStorage(...args); } });
  t.after(() => manager.stop());
  const a = manager.refresh(), b = manager.refresh();
  assert.equal(a, b);
  await a;
  const before = scans;
  for (let i = 0; i < 5; i++) await manager.status();
  assert.equal(scans, before); assert.equal(detections, 1);
  assert.ok(manager.snapshot().cleanableBytes >= 16384);
  assert.equal(manager.snapshot().policy.automatic, false);
});

test("preview preserves every file; native cleanup clears only chosen caches and records effects", async (t) => {
  const f = await fixture(t);
  await f.manager.refresh();
  assert.ok((await f.manager.clean(["go", "npm"], { dryRun: true })).estimatedBytes > 0);
  assert.equal(f.calls.length, 0);
  const starts = [];
  const result = await f.manager.clean(["go", "npm"], { onStarted: (op) => starts.push(op) });
  assert.equal(result.ok, true); assert.ok(result.removedCacheBytes >= 16384); assert.equal(result.reclaimedBytes, null);
  assert.equal(starts.length, 1); assert.equal(starts[0].state, "running");
  assert.deepEqual(f.calls.map((c) => c.args), [["/bin/go", "clean", "-cache"], ["/bin/node", "/bin/npm", "cache", "clean", "--force", "--cache", f.npm]]);
  assert.equal(f.calls[0].options.env.GOCACHE, f.go);
  for (const file of f.sentinels) assert.equal((await fs.readFile(file)).length, 8192);
  assert.equal((await f.manager.status()).operation.state, "succeeded");
  assert.equal(f.manager.snapshot().cleanableBytes, 0);
});

test("untrusted cache IDs and running builds fail before any command or running job is recorded", async (t) => {
  const f = await fixture(t, { processes: async () => ({ complete: true, processes: [{ args: ["go", "build"], executable: "/bin/go" }] }) });
  for (const ids of [["all"], ["../../source"], ["go", "go"], [], "go"]) assert.equal((await f.manager.clean(ids)).code, "invalid-cache");
  assert.equal((await f.manager.clean(["go"])).code, "busy");
  assert.equal(f.calls.length, 0); assert.equal(f.manager.snapshot().operation, null);
});

test("unreadable process activity fails closed", async (t) => {
  const f = await fixture(t, { processes: async () => ({ complete: false, processes: [] }) });
  assert.equal((await f.manager.clean(["npm"])).code, "unavailable");
  assert.equal(f.calls.length, 0);
});

test("cleanup shares the cross-process install lock", async (t) => {
  let release, started;
  const wait = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, { run: async () => { started(); await wait; return { code: 0 }; } });
  const second = createStorageManager(f.base); t.after(() => second.stop());
  const first = f.manager.clean(["go"]);
  await began;
  assert.equal((await second.clean(["npm"])).code, "busy");
  release(); assert.equal((await first).ok, true);
  assert.equal((await second.clean(["npm"])).ok, true);
});

test("linked cache ancestors, project caches, credentials, and custom external paths cannot be cleared", async (t) => {
  const f = await fixture(t);
  const guard = (target) => checkCachePath(target, { userHome: f.home, workspace: f.workspace, stateRoot: path.join(f.home, ".t3") });
  await fs.symlink(f.workspace, path.join(f.home, ".cache/linked"));
  for (const target of [path.join(f.home, ".cache/linked/new-cache"), f.workspace, path.join(f.home, ".t3/agents"), path.join(f.root, "outside"), "relative"]) assert.equal((await guard(target)).safe, false, target);
  assert.equal((await guard(path.join(f.home, ".cache/missing"))).safe, true);
});

test("a build that starts during measurement stops cleanup", async (t) => {
  let checks = 0;
  const f = await fixture(t, { processes: async () => ++checks === 1 ? idle() : ({ complete: true, processes: [{ args: ["go", "build"] }] }) });
  const result = await f.manager.clean(["go"]);
  assert.equal(result.ok, false); assert.equal(f.calls.length, 0);
  assert.equal(f.manager.snapshot().operation.state, "failed");
});

test("Go and Bun cache permissions exclude projects and installed tools", async (t) => {
  const f = await fixture(t);
  for (const relative of ["go", "go/src/project", "go/bin", ".bun", ".bun/bin"]) {
    const target = path.join(f.home, relative);
    await fs.mkdir(target, { recursive: true });
    const sentinel = path.join(target, "keep"); await fs.writeFile(sentinel, "project or tool");
    const manager = createStorageManager({ ...f.base, detectCaches: async () => ({ gomod: { path: target, executable: "/bin/go" } }) });
    t.after(() => manager.stop());
    assert.equal((await manager.clean(["gomod"])).code, "unavailable", relative);
    assert.equal(await fs.readFile(sentinel, "utf8"), "project or tool");
  }
  for (const relative of ["go/pkg/mod", ".bun/install/cache"]) {
    assert.equal((await checkCachePath(path.join(f.home, relative), { userHome: f.home, stateRoot: path.join(f.home, ".t3"), workspace: f.workspace })).safe, true);
  }
  assert.equal(f.calls.length, 0);
});

test("Bun discovery uses a disposable project and refuses an unreadable cache configuration", async (t) => {
  const f = await fixture(t), bin = path.join(f.root, "bin"), outside = path.join(f.root, "outside");
  await fs.mkdir(bin); await fs.writeFile(path.join(bin, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const env = { ...f.env, PATH: bin, BUN_INSTALL_CACHE_DIR: outside };
  let project;
  const detected = await detectCaches({ env, userHome: f.home, run: async (argv, options) => {
    if (argv[0] !== path.join(bin, "bun")) return { code: 1, stdout: "" };
    project = options.cwd;
    assert.notEqual(project, f.home);
    assert.equal(JSON.parse(await fs.readFile(path.join(project, "package.json"), "utf8")).private, true);
    return { code: 0, stdout: options.env.BUN_INSTALL_CACHE_DIR + "\n" };
  } });
  assert.equal(detected.bun.path, outside);
  await assert.rejects(fs.stat(project), { code: "ENOENT" });
  const manager = createStorageManager({ ...f.base, detectCaches: async () => detected });
  t.after(() => manager.stop());
  assert.equal((await manager.clean(["bun"])).code, "unavailable");
  assert.equal(f.calls.length, 0);
  const failed = await detectCaches({ env, userHome: f.home, run: async () => ({ code: 1, stdout: "" }) });
  assert.equal(failed.bun.executable, null);
  assert.match(failed.bun.unavailable, /settings could not be read/);
});

test("Bun cleanup pins the validated cache even if ambient configuration differs", async (t) => {
  const f = await fixture(t), target = path.join(f.home, ".bun/install/cache"), outside = path.join(f.root, "outside");
  for (const directory of [target, outside]) { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, "keep"), "cache data"); }
  const manager = createStorageManager({ ...f.base, env: { ...f.env, BUN_INSTALL_CACHE_DIR: outside },
    detectCaches: async () => ({ bun: { path: target, executable: "/bin/bun" } }),
    run: async (argv, options) => {
      assert.equal(options.env.BUN_INSTALL_CACHE_DIR, target);
      await fs.rm(options.env.BUN_INSTALL_CACHE_DIR, { recursive: true });
      return { code: 0, stdout: "" };
    } });
  t.after(() => manager.stop());
  assert.equal((await manager.clean(["bun"])).ok, true);
  assert.equal(await fs.readFile(path.join(outside, "keep"), "utf8"), "cache data");
});

test("failed or partial scans preserve the previous trustworthy inventory", async (t) => {
  let fail = false;
  const f = await fixture(t, { measure: async (...args) => { if (fail) throw new Error("scan timeout"); return measureStorage(...args); } });
  await f.manager.refresh(); const previous = f.manager.snapshot(); fail = true;
  await f.manager.refresh();
  assert.deepEqual(f.manager.snapshot().categories, previous.categories);
  assert.equal(f.manager.snapshot().at, previous.at);
  assert.match(f.manager.snapshot().error, /timeout/);
});

test("cleanup failure is durable; a partial result is never reported as all bytes reclaimed", async (t) => {
  let measures = 0;
  const f = await fixture(t, { measure: async (roots) => ({ sizes: { [roots[0]]: 1000 }, partial: ++measures === 2 }) });
  assert.equal((await f.manager.clean(["go"])).ok, false);
  const restarted = createStorageManager(f.base); t.after(() => restarted.stop());
  assert.equal((await restarted.status()).operation.state, "failed");
  assert.equal((await restarted.status()).operation.removedCacheBytes, 0);
  assert.equal((await restarted.status()).operation.reclaimedBytes, null);
});

test("interrupted jobs are recovered without clearing files", async (t) => {
  const f = await fixture(t);
  await writeStorageJson(path.join(f.home, ".t3/setup/storage-operation.json"), { id: "lost", state: "running", pid: 98765, startedAt: 1 });
  const restarted = createStorageManager({ ...f.base, isAlive: () => false }); t.after(() => restarted.stop());
  await restarted.ready;
  assert.equal(restarted.snapshot().operation.state, "interrupted");
  assert.equal((await restarted.status()).operation.state, "interrupted");
  assert.equal(f.calls.length, 0);
});

test("recent completions remain visible after a second client starts another operation", async (t) => {
  const f = await fixture(t);
  const first = await f.manager.clean(["go"]);
  const second = await f.manager.clean(["npm"]);
  assert.equal(second.operation.recent[0].id, first.operation.id);
  assert.equal(second.operation.recent[0].state, "succeeded");
});

test("CLI cleanup updates the console's cached cache sizes without a new scan", async (t) => {
  const f = await fixture(t);
  await f.manager.refresh();
  const cli = createStorageManager(f.base); t.after(() => cli.stop());
  assert.equal((await cli.clean(["go"])).ok, true);
  const status = await f.manager.status();
  assert.equal(status.categories.find((row) => row.id === "go").bytes, 0);
  assert.equal(status.operation.state, "succeeded");
});

test("preferences are private and atomic; corrupt preferences disable all automatic maintenance", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.manager.setPolicy({ automatic: "on" })).ok, false);
  assert.equal((await f.manager.setPolicy({ arbitrary: true })).ok, false);
  assert.equal((await f.manager.setPolicy({ goBudgetBytes: GB / 8 })).ok, false);
  assert.equal((await f.manager.setPolicy({ ...DEFAULT_POLICY, automatic: true })).ok, true);
  const file = f.manager.paths.policyFile;
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.writeFile(file, "broken json");
  const prefs = await readPolicy(file);
  assert.equal(prefs.policy.automatic, false); assert.equal(prefs.policy.retainManagedVersions, false);
  assert.ok(prefs.error); assert.equal(await f.manager.maintain(), undefined);
});

test("opt-in budget maintenance waits for ten quiet minutes and stops for build activity", async (t) => {
  let clock = 1000, busy = false;
  const f = await fixture(t, { now: () => clock, processes: async () => busy ? ({ complete: true, processes: [{ args: ["go", "build"] }] }) : idle(),
    measure: async (roots) => ({ sizes: Object.fromEntries(roots.map((p) => [p, GB])), partial: false }) });
  await f.manager.refresh(); await f.manager.maintain(); assert.equal(f.calls.length, 0);
  await f.manager.setPolicy({ ...DEFAULT_POLICY, automatic: true, goBudgetBytes: GB / 4, npmBudgetBytes: GB / 4 });
  clock += 599999; await f.manager.maintain(); assert.equal(f.calls.length, 0);
  busy = true; clock++; await f.manager.maintain(); assert.equal(f.calls.length, 0);
  busy = false; clock += 600000; await f.manager.maintain(); assert.equal(f.calls.length, 2);
  assert.equal(f.manager.snapshot().operation.automatic, true);
});

for (const reused of [false, true]) test(`maintenance heals a ${reused ? "recycled" : "dead"} PID without a status poll`, async (t) => {
  let clock = 1000;
  const f = await fixture(t, { now: () => clock, isAlive: (pid) => pid === process.pid || (reused && pid === 424242),
    startTimeOf: (pid) => pid === 424242 ? "new-start" : "self",
    measure: async (roots) => ({ sizes: Object.fromEntries(roots.map((p) => [p, GB])), partial: false }) });
  await f.manager.refresh();
  const operationFile = path.join(path.dirname(f.manager.paths.policyFile), "storage-operation.json");
  const stale = { id: "interrupted-cli", state: "running", pid: 424242, startTime: "old-start", startedAt: clock, completedIds: ["go"], remainingIds: ["npm"] };
  await writeStorageJson(operationFile, stale);
  await f.manager.maintain();
  assert.equal(f.manager.snapshot().operation.state, "interrupted");
  assert.equal(JSON.parse(await fs.readFile(operationFile, "utf8")).state, "interrupted");
  await f.manager.setPolicy({ ...DEFAULT_POLICY, automatic: true, goBudgetBytes: GB / 4, npmBudgetBytes: GB / 4 });
  clock += 11 * 60_000;
  await f.manager.maintain();
  assert.equal(f.calls.length, 2);
  assert.equal(f.manager.snapshot().operation.recent[0].id, stale.id);
  assert.deepEqual(f.manager.snapshot().operation.recent[0].remainingIds, ["npm"]);
});

test("maintenance imports a CLI completion before deciding whether caches exceed their budget", async (t) => {
  let clock = 1000;
  const f = await fixture(t, { now: () => clock,
    measure: async (roots) => ({ sizes: Object.fromEntries(roots.map((p) => [p, GB])), partial: false }) });
  await f.manager.refresh();
  await f.manager.setPolicy({ ...DEFAULT_POLICY, automatic: true, goBudgetBytes: GB / 4, npmBudgetBytes: GB / 4 });
  clock += 11 * 60_000;
  await writeStorageJson(path.join(path.dirname(f.manager.paths.policyFile), "storage-operation.json"), {
    id: "finished-cli", state: "succeeded", startedAt: clock - 100, finishedAt: clock, cacheResults: { go: 0, npm: 0 },
  });
  await f.manager.maintain();
  assert.equal(f.calls.length, 0);
  assert.equal(f.manager.snapshot().cleanableBytes, 0);
});

test("reconciliation re-reads under the cleanup lock and preserves a newer live CLI job", async (t) => {
  const f = await fixture(t, { isAlive: (pid) => pid === process.pid, startTimeOf: () => "self" });
  const file = path.join(path.dirname(f.manager.paths.policyFile), "storage-operation.json");
  const stale = { id: "old-cli", state: "running", pid: 424242, startedAt: 1000 };
  const newer = { id: "new-cli", state: "running", pid: process.pid, startTime: "self", startedAt: 2000 };
  let armed = false;
  const io = { ...fs, readFile: async (target, ...args) => {
    const text = await fs.readFile(target, ...args);
    if (armed && target === file) { armed = false; await writeStorageJson(file, newer); }
    return text;
  } };
  const manager = createStorageManager({ ...f.base, fs: io });
  t.after(() => manager.stop());
  await manager.ready;
  await writeStorageJson(file, stale);
  armed = true;
  await manager.maintain();
  assert.equal(manager.snapshot().operation.id, newer.id);
  assert.equal(manager.snapshot().operation.state, "running");
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), newer);
  assert.equal(f.calls.length, 0);
});

test("package commands executed through node and Go compiler processes block cleanup", () => {
  for (const args of [["node", "/tools/npm-cli.js", "ci"], ["pnpm", "install"], ["yarn", "add", "foo"], ["bun", "install"], ["/go/pkg/tool/linux/compile", "-o", "obj"],
    ["uv", "pip", "install", "requests"], ["uv", "sync"], ["pip", "install", "x"], ["pip3", "download", "x"], ["cargo", "build"], ["cargo", "fetch"], ["rustc", "--crate-name", "x"],
    ["deno", "run", "main.ts"], ["mise", "install"], ["mise", "up"], ["bunx", "prettier"], ["go", "build", "./..."]]) assert.equal(buildsOrInstallsRunning({ complete: true, processes: [{ args }] }), true, args.join(" "));
  for (const args of [["node", "server.mjs"], ["mise", "ls"], ["mise", "cache", "path"], ["cargo", "--version"], ["uv", "--version"], ["git", "status"]]) assert.equal(buildsOrInstallsRunning({ complete: true, processes: [{ args }] }), false, args.join(" "));
});

test("uv, bun and mise caches clear through their own native commands", async (t) => {
  const f = await fixture(t);
  const targets = { uv: path.join(f.home, ".cache/uv"), bun: path.join(f.home, ".bun/install/cache"), mise: path.join(f.home, ".cache/mise") };
  for (const dir of Object.values(targets)) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "blob"), Buffer.alloc(8192, 7));
  }
  const seen = [];
  const manager = createStorageManager({ ...f.base,
    detectCaches: async () => Object.fromEntries(Object.entries(targets).map(([id, target]) => [id, { path: target, executable: `/bin/${id}` }])),
    run: async (args, options) => {
      seen.push({ args, cwd: options.cwd });
      const id = args[0] === "/bin/uv" ? "uv" : args[0] === "/bin/bun" ? "bun" : "mise";
      await fs.rm(targets[id], { recursive: true, force: true });
      return { code: 0, stdout: "", stderr: "" };
    } });
  t.after(() => manager.stop());
  await manager.refresh();
  const preview = await manager.clean(["uv", "bun", "mise"], { dryRun: true });
  assert.equal(preview.ok, true); assert.ok(preview.estimatedBytes >= 3 * 8192);
  const result = await manager.clean(["uv", "bun", "mise"]);
  assert.equal(result.ok, true); assert.ok(result.removedCacheBytes >= 3 * 8192); assert.equal(result.reclaimedBytes, null);
  assert.deepEqual(seen.map((call) => call.args), [["/bin/uv", "cache", "prune", "--cache-dir", targets.uv, "--no-config"], ["/bin/bun", "pm", "cache", "rm"], ["/bin/mise", "-y", "cache", "clear"]]);
  // Bun runs in a scratch project, never in the user's home or workspace.
  assert.ok(path.basename(seen[1].cwd).startsWith("t3-storage-") && !seen[1].cwd.startsWith(f.home));
  assert.ok(seen[1].cwd.startsWith(f.base.temporary));
  await assert.rejects(fs.stat(seen[1].cwd), { code: "ENOENT" });
  for (const file of f.sentinels) assert.equal((await fs.readFile(file)).length, 8192);
});

test("a cache whose tool is missing is reported, not cleaned", async (t) => {
  const f = await fixture(t);
  const manager = createStorageManager({ ...f.base,
    detectCaches: async () => ({ deno: { path: path.join(f.home, ".cache/deno"), executable: null, unavailable: "Install Deno to clean this cache." } }) });
  t.after(() => manager.stop());
  await manager.refresh();
  assert.equal((await manager.clean(["deno"])).code, "unavailable");
  assert.equal((await manager.clean(["go"])).code, "unavailable");
  assert.equal(f.calls.length, 0);
});

test("new cache budgets validate like the existing ones", async (t) => {
  const f = await fixture(t);
  for (const key of ["uvBudgetBytes", "bunBudgetBytes", "miseBudgetBytes", "denoBudgetBytes", "gomodBudgetBytes"]) {
    assert.equal((await f.manager.setPolicy({ [key]: GB / 8 })).ok, false, key);
    assert.equal((await f.manager.setPolicy({ [key]: 501 * GB })).ok, false, key);
  }
  assert.equal((await f.manager.setPolicy({ ...DEFAULT_POLICY, uvBudgetBytes: 3 * GB, bunBudgetBytes: GB, miseBudgetBytes: 4 * GB, denoBudgetBytes: GB, gomodBudgetBytes: GB })).ok, true);
});

test("CLI clean all previews only cleanable caches and accepts new budget flags", async (t) => {
  const f = await fixture(t), out = [], err = [];
  const run = (args) => runStorageCli(args, { create: () => createStorageManager(f.base), out: (line) => out.push(line), err: (line) => err.push(line) });
  assert.equal(await run(["clean", "all", "--yes"]), 0); assert.equal(f.calls.length, 2);
  assert.equal(await run(["policy", "--uv-budget", "3", "--mise-budget", "oops"]), 2);
  assert.equal(await run(["policy", "--uv-budget", "3", "--bun-budget", "1.5", "--mise-budget", "4", "--deno-budget", "0.5", "--gomod-budget", "2"]), 0);
});

test("CLI defaults to previews, requires explicit apply, and rejects irrelevant flags", async (t) => {
  const f = await fixture(t), out = [], err = [];
  const run = (args) => runStorageCli(args, { create: () => createStorageManager(f.base), out: (line) => out.push(line), err: (line) => err.push(line) });
  assert.equal(await run(["clean", "all", "--json"]), 0); assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse(out.pop()).dryRun, true);
  for (const args of [["status", "--yes"], ["policy", "--dry-run"], ["clean", "all", "--yes", "--dry-run"], ["policy", "--go-budget", "oops"], ["clean", "/tmp"]]) assert.equal(await run(args), 2);
  assert.equal(await run(["clean", "go", "--yes"]), 0); assert.equal(f.calls.length, 1);
});

test("cache ownership rejects aggregate roots, other tools and protected descendants", async (t) => {
  const f = await fixture(t);
  const context = { userHome: f.home, env: f.env, workspace: f.workspace, stateRoot: path.join(f.home, '.t3'), io: fs };
  for (const target of [path.join(f.home,'.npm'),path.join(f.home,'.cache'),path.join(f.home,'.cache/uv'),f.npm + '/_cacache']) {
    const detected = { gomod: { path: target, executable: '/bin/go' } };
    const guard = await cacheSafety('gomod',detected,context);
    assert.equal(guard.safe,false,target);
    const manager = createStorageManager({ ...f.base, detectCaches:async()=>detected });t.after(()=>manager.stop());
    assert.equal((await manager.clean(['gomod'])).ok,false,target);
  }
  const custom=path.join(f.home,'.cache/custom'),state=path.join(custom,'private-state');
  const guard=await cacheSafety('gomod',{gomod:{path:custom,executable:'/bin/go'}},{...context,stateRoot:state});
  assert.equal(guard.safe,false,'a parent of protected state is also protected');
  for(const file of f.sentinels)assert.equal((await fs.readFile(file)).length,8192);
  assert.equal(f.calls.length,0);
});

test("Bun shared stores and unreadable dependency checks are protected in preview and cleanup", async(t)=>{
  const f=await fixture(t),target=path.join(f.home,'.bun/install/cache'),store=path.join(target,'links/pkg/node_modules/dep');
  await fs.mkdir(store,{recursive:true});const sentinel=path.join(store,'index.js');await fs.writeFile(sentinel,'module.exports=42');
  const detected={bun:{path:target,executable:'/bin/bun'}};
  const manager=createStorageManager({...f.base,detectCaches:async()=>detected});t.after(()=>manager.stop());
  const plan=await manager.previewClean(['bun']);
  assert.equal(plan.caches[0].eligible,false);assert.equal(plan.caches[0].reason,'Shared dependencies kept');
  assert.equal((await manager.clean(['bun'])).code,'unavailable');
  assert.equal(await fs.readFile(sentinel,'utf8'),'module.exports=42');
  const io={...fs,readdir:async p=>{if(p.endsWith('/links'))throw Object.assign(new Error('unreadable'),{code:'EACCES'});return fs.readdir(p);}};
  const guarded=createStorageManager({...f.base,fs:io,detectCaches:async()=>detected});t.after(()=>guarded.stop());
  assert.equal((await guarded.previewClean(['bun'])).caches[0].reason,'Could not verify dependencies');
  assert.equal(f.calls.length,0);
});

test("mise cleanup pins cache, task and scratch state directories independently of ambient settings",async(t)=>{
  const f=await fixture(t),target=path.join(f.home,'.cache/mise'),outside=path.join(f.workspace,'task-cache');
  await fs.mkdir(target,{recursive:true});await fs.writeFile(path.join(target,'metadata'),'rebuildable');
  await fs.mkdir(outside,{recursive:true});await fs.writeFile(path.join(outside,'keep'),'project-owned');
  let observed;
  const manager=createStorageManager({...f.base,env:{...f.env,MISE_TASK_CACHE_DIR:outside},
    detectCaches:async()=>({mise:{path:target,executable:'/bin/mise'}}),run:async(argv,options)=>{
      observed=options.env;
      assert.equal(options.env.MISE_CACHE_DIR,target);
      assert.equal(options.env.MISE_TASK_CACHE_DIR,path.join(target,'task-artifacts'));
      assert.ok(options.env.MISE_STATE_DIR.startsWith(f.base.temporary + '/t3-storage-'));
      await fs.rm(target,{recursive:true});return {code:0};
    }});t.after(()=>manager.stop());
  assert.equal((await manager.clean(['mise'])).ok,true);
  assert.equal(await fs.readFile(path.join(outside,'keep'),'utf8'),'project-owned');
  assert.notEqual(observed.MISE_STATE_DIR,f.env.MISE_STATE_DIR);
});

test("cleanup consent is bounded, single-use, expiring and allows only reviewed eligible subsets",async(t)=>{
  const f=await fixture(t);let clock=Date.now();
  const manager=createStorageManager({...f.base,now:()=>clock});t.after(()=>manager.stop());
  const plan=await manager.previewClean(['go','npm']);
  assert.equal(f.calls.length,0);assert.ok(plan.caches.every(row=>row.eligible));
  assert.equal((await manager.clean(['uv'],{token:plan.token})).code,'stale-preview');
  assert.equal((await manager.clean(['npm'],{token:plan.token})).ok,true);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].args[0],'/bin/node');
  assert.equal((await manager.clean(['go'],{token:plan.token})).code,'stale-preview');
  const expired=await manager.previewClean(['go']);clock+=5*60*1000;
  assert.equal((await manager.clean(['go'],{token:expired.token})).code,'stale-preview');
  const first=await manager.previewClean(['go']);
  for(let i=0;i<16;i++)await manager.previewClean(['go']);
  assert.equal((await manager.clean(['go'],{token:first.token})).code,'stale-preview');
  assert.equal(f.calls.length,1);
});

test("a cache that moves or gains a shared store after consent cannot be removed",async(t)=>{
  const f=await fixture(t),original=f.go,moved=path.join(f.home,'.cache/go-custom');let target=original;
  await fs.mkdir(moved,{recursive:true});await fs.writeFile(path.join(moved,'archive'),'new data');
  const manager=createStorageManager({...f.base,detectCaches:async()=>({go:{path:target,executable:'/bin/go'}})});t.after(()=>manager.stop());
  const plan=await manager.previewClean(['go']);target=moved;
  assert.equal((await manager.clean(['go'],{token:plan.token})).code,'stale-preview');
  assert.equal(await fs.readFile(path.join(moved,'archive'),'utf8'),'new data');
  const bun=path.join(f.home,'.bun/install/cache');await fs.mkdir(bun,{recursive:true});await fs.writeFile(path.join(bun,'download'),'cache');
  const second=createStorageManager({...f.base,detectCaches:async()=>({bun:{path:bun,executable:'/bin/bun'}})});t.after(()=>second.stop());
  const reviewed=await second.previewClean(['bun']);assert.equal(reviewed.caches[0].eligible,true);
  await fs.mkdir(path.join(bun,'links/installed'),{recursive:true});
  assert.equal((await second.clean(['bun'],{token:reviewed.token})).code,'stale-preview');
  assert.equal(f.calls.length,0);
});

test("activity protects only related caches, including uv run, uvx and Bun application commands",async(t)=>{
  for(const args of [['uv','run','--with','dep','script.py'],['uvx','tool'],['bun','run','dev'],['bun','main.ts','--help']]){
    const snapshot={complete:true,processes:[{args}]};
    assert.equal(buildsOrInstallsRunning(snapshot),true,args.join(' '));
    assert.equal(buildsOrInstallsRunning(snapshot,['npm']),false,args.join(' '));
  }
  const f=await fixture(t,{processes:async()=>({complete:true,processes:[{args:['deno','run','server.ts']}]})});
  const plan=await f.manager.previewClean(['go','npm']);assert.ok(plan.caches.every(row=>row.eligible));
  assert.equal((await f.manager.clean(['go'],{token:plan.token})).ok,true,'an unrelated long-running Deno server does not dead-end cleanup');
});

test("partial cleanup records completed and remaining caches for a fresh, scoped retry",async(t)=>{
  const f=await fixture(t);let calls=0;
  const manager=createStorageManager({...f.base,run:async(args,options)=>{
    calls++;if(calls===2)return {code:1};return f.base.run(args,options);
  }});t.after(()=>manager.stop());
  const plan=await manager.previewClean(['go','npm']);
  assert.equal((await manager.clean(['go','npm'],{token:plan.token})).ok,false);
  const op=(await manager.status()).operation;
  assert.deepEqual(op.completedIds,['go']);assert.deepEqual(op.remainingIds,['npm']);assert.ok(op.removedCacheBytes>0);
  assert.equal(op.reclaimedBytes,null,'cache bytes are not misrepresented as recovered disk blocks');
  const retry=await manager.previewClean(op.remainingIds);
  assert.equal((await manager.clean(['npm'],{token:retry.token})).ok,true);
  assert.equal(calls,3);
});

test("preference migration preserves original automatic scope and rejects concurrent stale saves",async(t)=>{
  const f=await fixture(t),file=path.join(f.home,'.t3/setup/storage-policy.json');
  await writeStorageJson(file,{schema:1,automatic:true,retainManagedVersions:true,goBudgetBytes:GB,npmBudgetBytes:GB});
  const legacy=await readPolicy(file);assert.deepEqual(legacy.policy.automaticCaches,['go','npm']);
  assert.equal(legacy.policy.uvBudgetBytes,2*GB);
  const fresh=await readPolicy(path.join(f.root,'missing-policy'));assert.deepEqual(fresh.policy.automaticCaches,CACHE_IDS);
  assert.equal((await f.manager.setPolicy({...DEFAULT_POLICY,automatic:true,automaticCaches:[]})).ok,false);
  for(const automaticCaches of [['uv','uv'],['unknown'],'uv'])assert.equal((await f.manager.setPolicy({automaticCaches})).ok,false);
  const current=await f.manager.status(),second=createStorageManager(f.base);t.after(()=>second.stop());
  const results=await Promise.all([
    f.manager.setPolicy({...current.policy,uvBudgetBytes:3*GB},{expectedRevision:current.policyRevision}),
    second.setPolicy({...current.policy,uvBudgetBytes:4*GB},{expectedRevision:current.policyRevision}),
  ]);
  assert.equal(results.filter(r=>r.ok).length,1,'only one concurrent write owns the revision');
  const failed=results.find(r=>!r.ok);assert.ok(['busy','stale-policy'].includes(failed.code));
});

test("unchanged caches are not repeatedly pruned by background maintenance",async(t)=>{
  const f=await fixture(t);let clock=Date.now(),runs=0;
  const uv=path.join(f.home,'.cache/uv');await fs.mkdir(uv,{recursive:true});await fs.writeFile(path.join(uv,'blob'),'cache');
  const manager=createStorageManager({...f.base,now:()=>clock,detectCaches:async()=>({uv:{path:uv,executable:'/bin/uv'}}),
    measure:async roots=>({partial:false,sizes:Object.fromEntries(roots.map(root=>[root,root===uv?3*GB:0]))}),
    run:async()=>{runs++;return {code:0};}});t.after(()=>manager.stop());
  assert.equal((await manager.setPolicy({...DEFAULT_POLICY,automatic:true,automaticCaches:['uv']})).ok,true);
  await manager.refresh();clock+=11*60*1000;await manager.maintain();assert.equal(runs,1);
  clock+=11*60*1000;await manager.maintain();assert.equal(runs,1,'native pruning can retain all entries without causing a repeated loop');
});

test("cleanup refreshes disk space without a full home traversal and replays cache results across restart",async(t)=>{
  const f=await fixture(t);let broadScans=0,diskReads=0;
  const manager=createStorageManager({...f.base,refreshAfterCleanup:true,
    diskUsage:async()=>{diskReads++;return {availableBytes:GB,totalBytes:2*GB,usedBytes:GB,usedPercent:50};},
    measure:async roots=>{if(roots.includes(f.home))broadScans++;return measureStorage(roots);}});t.after(()=>manager.stop());
  await manager.refresh();assert.equal(broadScans,1);
  assert.equal((await manager.clean(['go'])).ok,true);assert.equal((await manager.clean(['npm'])).ok,true);
  assert.equal(broadScans,1,'cache cleanup must not repeatedly traverse the whole home');assert.ok(diskReads>=3);
  const restarted=createStorageManager(f.base);t.after(()=>restarted.stop());
  const status=await restarted.status();
  assert.equal(status.categories.find(row=>row.id==='go').bytes,0);
  assert.equal(status.categories.find(row=>row.id==='npm').bytes,0);
});

test("one preview sizes every selected cache with a single measurement", async (t) => {
  const f = await fixture(t);
  const uv = path.join(f.home, ".cache/uv");
  await fs.mkdir(uv, { recursive: true });
  await fs.writeFile(path.join(uv, "blob"), Buffer.alloc(8192, 7));
  let measures = 0;
  const seen = [];
  const manager = createStorageManager({ ...f.base,
    detectCaches: async () => ({ ...(await f.base.detectCaches()), uv: { path: uv, executable: "/bin/uv" } }),
    measure: async (roots) => {
      measures++;
      seen.push([...roots]);
      return { sizes: Object.fromEntries(roots.map((root) => [root, 8192])), partial: false };
    } });
  t.after(() => manager.stop());
  const preview = await manager.previewClean(["go", "npm", "uv"]);
  assert.equal(measures, 1, `expected 1 measurement, got ${measures}`);
  assert.deepEqual(seen[0].sort(), [f.go, path.join(f.npm, "_cacache"), uv].sort());
  assert.ok(preview.caches.every((row) => row.eligible));
  assert.equal(preview.estimatedBytes, 3 * 8192);
});
