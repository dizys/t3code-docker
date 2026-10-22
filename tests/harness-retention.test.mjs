import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { createFs } from "../docker/harness/io.mjs";
import { createHarnessManager } from "../docker/harness/index.mjs";
import { planRetention, applyRetention } from "../docker/harness/retention.mjs";
import { emptyState, writeState, readState, statePath } from "../docker/harness/state.mjs";
import { DEFAULT_POLICY, policyPath, writeStorageJson } from "../docker/harness/storage/policy.mjs";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-retention-test-"));
  const dataDir = path.join(home, ".local/share/mise"), stateDir = path.join(home, ".local/state/mise");
  const versions = ["1.20.0", "1.21.0", "1.22.0", "1.23.0", "1.24.0", "1.25.0"];
  const installs = versions.map((version) => ({ version, installed: true, install_path: path.join(dataDir, "installs/go", version) }));
  for (const item of installs) await fs.mkdir(path.join(item.install_path, "bin"), { recursive: true });
  let prunable = installs, processes = { complete: true, processes: [] }, fail = false;
  const removed = [], calls = [];
  const env = { HOME: home, T3CODE_HOME: path.join(home, ".t3"), MISE_DATA_DIR: dataDir, MISE_STATE_DIR: stateDir };
  const ctx = { env, home, dataDir, stateDir, statePath: statePath(stateDir), fs: createFs(), now: Date.now,
    miseBin: "mise", timeouts: { mise: 120000, install: 120000 }, retentionProcesses: async () => processes,
    run: async (args) => {
      calls.push(args);
      if (args.includes("ls")) return { code: fail ? 1 : 0, stdout: JSON.stringify({ go: prunable }) };
      if (args.includes("uninstall")) {
        if (fail) return { code: 1, stderr: "uninstall failed" };
        const version = args.at(-1).split("@").at(-1); removed.push(version);
        await fs.rm(path.join(dataDir, "installs/go", version), { recursive: true });
        prunable = prunable.filter((item) => item.version !== version);
        return { code: 0 };
      }
      throw new Error(`Unexpected command ${args}`);
    } };
  const saved = emptyState(); saved.toolchains.go = { version: "1.25.0", previousVersion: "1.24.0", managedVersions: versions };
  await writeState(ctx, saved);
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { ctx, env, home, installs, removed, calls, settings: path.join(home, ".t3/userdata/settings.json"),
    setProcesses: (value) => { processes = value; }, setPrunable: (value) => { prunable = value; }, setFail: (value) => { fail = value; } };
}

test("retention protects current, previous, project pins, provider binaries, and running tools", async (t) => {
  const f = await fixture(t);
  f.setPrunable(f.installs.filter((item) => item.version !== "1.20.0"));
  await writeStorageJson(f.settings, { providerInstances: { custom: { config: { binaryPath: path.join(f.installs[1].install_path, "bin/go") } } } });
  f.setProcesses({ complete: true, processes: [{ args: ["node", path.join(f.installs[2].install_path, "bin/tool.js")], cwd: "/tmp" }] });
  const plan = await planRetention(f.ctx);
  const byVersion = Object.fromEntries(plan.items.map((item) => [item.version, item]));
  assert.equal(byVersion["1.20.0"].reason, "Required by a project or tool selection");
  assert.equal(byVersion["1.21.0"].reason, "Selected by a provider");
  assert.equal(byVersion["1.22.0"].reason, "Used by a running process");
  assert.equal(byVersion["1.23.0"].eligible, true);
  assert.equal(byVersion["1.24.0"].reason, "Previous version");
  assert.equal(byVersion["1.25.0"].reason, "Current version");
  const result = await applyRetention(f.ctx, plan);
  assert.deepEqual(f.removed, ["1.23.0"]); assert.equal(result.failed.length, 0);
  assert.equal((await readState(f.ctx)).toolchains.go.managedVersions.includes("1.23.0"), false);
});

test("provider PATH, process cwd, and flag paths veto removal", async (t) => {
  const f = await fixture(t);
  await writeStorageJson(f.settings, { providerInstances: { custom: { config: { env: { PATH: `${f.installs[0].install_path}/bin:/usr/bin` } } } } });
  f.setProcesses({ complete: true, processes: [{ args: ["worker", `--runtime=${f.installs[1].install_path}/bin/go`], cwd: f.installs[2].install_path }] });
  const plan = await planRetention(f.ctx);
  assert.equal(plan.removableCount, 1);
});

test("provider selections through a custom symlink protect the actual install", async (t) => {
  const f = await fixture(t);
  const binary = path.join(f.installs[0].install_path, "bin/go");
  await fs.writeFile(binary, "tool");
  const link = path.join(f.home, "custom-go"); await fs.symlink(binary, link);
  await writeStorageJson(f.settings, { providers: { custom: { binaryPath: link } } });
  const plan = await planRetention(f.ctx);
  assert.equal(plan.items.find((item) => item.version === "1.20.0").reason, "Selected by a provider");
});

test("linked installs and unmanaged versions remain untouched", async (t) => {
  const f = await fixture(t);
  await fs.rm(f.installs[0].install_path, { recursive: true });
  await fs.symlink(f.installs[1].install_path, f.installs[0].install_path);
  f.setPrunable([...f.installs, { version: "9.0.0", installed: true, install_path: path.join(f.home, "external") }]);
  const plan = await planRetention(f.ctx);
  assert.equal(plan.items.find((item) => item.version === "1.20.0").eligible, false);
  assert.equal(plan.items.some((item) => item.version === "9.0.0"), false);
});

test("unreadable project requirements, process lists, and invalid provider settings all fail closed", async (t) => {
  const f = await fixture(t);
  f.setFail(true); assert.equal((await planRetention(f.ctx)).removableCount, 0);
  f.setFail(false); f.setProcesses({ complete: false, processes: [] });
  assert.equal((await planRetention(f.ctx)).removableCount, 0);
  f.setProcesses({ complete: true, processes: [] });
  for (const value of [null, [], "invalid", 1]) {
    await writeStorageJson(f.settings, value);
    const plan = await planRetention(f.ctx); assert.equal(plan.removableCount, 0); assert.ok(plan.warning);
  }
});

test("references are checked again immediately before each removal", async (t) => {
  const f = await fixture(t), plan = await planRetention(f.ctx);
  f.setProcesses({ complete: true, processes: [{ args: [path.join(f.installs[0].install_path, "bin/go")] }] });
  await applyRetention(f.ctx, plan);
  assert.equal(f.removed.includes("1.20.0"), false);
  assert.equal(f.removed.length, 3);
});

test("failed uninstalls preserve ownership records for retry", async (t) => {
  const f = await fixture(t), plan = await planRetention(f.ctx);
  const original = f.ctx.run;
  f.ctx.run = (args) => args.includes("uninstall") ? Promise.resolve({ code: 1, stderr: "failed" }) : original(args);
  const result = await applyRetention(f.ctx, plan);
  assert.equal(result.failed.length, 4); assert.ok(result.warning);
  assert.equal((await readState(f.ctx)).toolchains.go.managedVersions.length, 6);
});

test("manual pruning rejects stale previews and remains available when automatic retention is off", async (t) => {
  const f = await fixture(t);
  await writeStorageJson(policyPath(f.env, f.home), { ...DEFAULT_POLICY, retainManagedVersions: false });
  const manager = createHarnessManager({ env: f.env, run: f.ctx.run, retentionProcesses: f.ctx.retentionProcesses });
  const plan = await manager.retention.preview(); assert.equal(plan.enabled, false);
  f.setPrunable(f.installs.slice(1));
  assert.equal((await manager.retention.prune({ token: plan.token })).code, "stale-preview");
  assert.equal(f.removed.length, 0);
  const fresh = await manager.retention.preview();
  assert.equal((await manager.retention.prune({ token: fresh.token })).ok, true);
  assert.deepEqual(f.removed, ["1.21.0", "1.22.0", "1.23.0"]);
});

test("manual cleanup can include the only previous version without changing automatic retention", async (t) => {
  const f = await fixture(t);
  const saved = await readState(f.ctx);
  saved.toolchains.go.managedVersions = ["1.24.0", "1.25.0"];
  await writeState(f.ctx, saved);
  const manager = createHarnessManager({ env: f.env, run: f.ctx.run, retentionProcesses: f.ctx.retentionProcesses });
  const safe = await manager.retention.preview();
  assert.equal(safe.removableCount, 0);
  const plan = await manager.retention.preview({ includePrevious: true });
  assert.equal(plan.includePrevious, true);
  assert.equal(plan.removableCount, 1);
  assert.equal((await manager.retention.prune({ token: safe.token, includePrevious: true })).code, "stale-preview");
  assert.equal((await manager.retention.prune({ includePrevious: true })).code, "stale-preview");
  assert.equal(f.removed.length, 0);
  assert.equal((await manager.retention.prune({ token: plan.token, includePrevious: true })).ok, true);
  assert.deepEqual(f.removed, ["1.24.0"]);
  const after = (await readState(f.ctx)).toolchains.go;
  assert.equal(after.version, "1.25.0");
  assert.equal(after.previousVersion, null);
  assert.deepEqual(after.managedVersions, ["1.25.0"]);
  assert.equal((await manager.retention.preview()).includePrevious, false);
});

test("including previous versions still protects pins, provider selections, live tools and unverified installs", async (t) => {
  const f = await fixture(t);
  const previous = f.installs.find((item) => item.version === "1.24.0");
  for (const protect of [
    async () => { f.setPrunable(f.installs.filter((item) => item !== previous)); },
    async () => { f.setPrunable(f.installs); await writeStorageJson(f.settings, { providerInstances: { custom: { binaryPath: previous.install_path + "/bin/go" } } }); },
    async () => { await fs.rm(f.settings); f.setProcesses({ complete: true, processes: [{ args: [previous.install_path + "/bin/go"] }] }); },
    async () => { f.setProcesses({ complete: false, processes: [] }); },
  ]) {
    await protect();
    const plan = await planRetention(f.ctx, { includePrevious: true });
    assert.equal(plan.items.find((item) => item.version === previous.version).eligible, false);
    assert.equal(plan.items.find((item) => item.version === "1.25.0").reason, "Current version");
  }
  f.setProcesses({ complete: true, processes: [] });
  await fs.rm(previous.install_path, { recursive: true });
  await fs.symlink(f.installs[5].install_path, previous.install_path);
  const linked = await planRetention(f.ctx, { includePrevious: true });
  assert.equal(linked.items.find((item) => item.version === previous.version).reason, 'Install location could not be verified');
});

test("a previous version newly used after review is rechecked before removal", async (t) => {
  const f = await fixture(t), plan = await planRetention(f.ctx, { includePrevious: true });
  f.setProcesses({ complete: true, processes: [{ args: [f.installs[4].install_path + "/bin/go"] }] });
  await applyRetention(f.ctx, plan);
  assert.equal(f.removed.includes("1.24.0"), false);
  assert.equal((await readState(f.ctx)).toolchains.go.previousVersion, "1.24.0");
});

test("cleanup mode consent cannot be reused even when the removable set is identical", async (t) => {
  const f = await fixture(t);
  f.setPrunable(f.installs.filter((item) => item.version !== "1.24.0"));
  const safe = await planRetention(f.ctx), all = await planRetention(f.ctx, { includePrevious: true });
  assert.equal(safe.removableCount, all.removableCount);
  assert.notEqual(safe.token, all.token);
  const manager = createHarnessManager({ env: f.env, run: f.ctx.run, retentionProcesses: f.ctx.retentionProcesses });
  assert.equal((await manager.retention.prune({ token: safe.token, includePrevious: true })).code, "stale-preview");
  assert.equal((await manager.retention.prune({ token: all.token, includePrevious: "true" })).code, "invalid-options");
  assert.deepEqual(f.removed, []);
});
