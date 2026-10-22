// Exercise the authenticated HTTP boundary with the real storage service and
// filesystem, replacing only cache tools/process discovery for portable CI.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("storage API authenticates, validates, acknowledges durable jobs, and preserves user data", { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-storage-api-"));
  const home = path.join(root, "home"), workspace = path.join(root, "workspace"), go = path.join(home, ".cache/go-build");
  const protectedFiles = [path.join(workspace, "source"), path.join(home, ".npm/_npx/tool"), path.join(home, ".t3/agents/token"), path.join(home, ".t3/userdata/history.db")];
  for (const file of [...protectedFiles, path.join(go, "aa/archive")]) {
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "keep or cache");
  }
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const module = path.join(root, "harness.mjs");
  await fs.writeFile(module, `
    export * from ${JSON.stringify(new URL("../docker/harness/index.mjs", import.meta.url).href)};
    import { createStorageManager as core } from ${JSON.stringify(new URL("../docker/harness/storage/manager.mjs", import.meta.url).href)};
    import { promises as fs } from 'node:fs';
    export const createStorageManager = (options) => core({ ...options, retention: options.harness.retention,
      temporary: ${JSON.stringify(path.join(root, "tmp"))}, intervalMs: 0,
      processes: async () => ({ complete: true, processes: [] }),
      detectCaches: async () => ({ go: { path: ${JSON.stringify(go)}, executable: '/fixture/go' }, npm: { path: ${JSON.stringify(path.join(home, ".npm"))}, executable: null } }),
      run: async (args) => {
        if (args.join(' ') !== '/fixture/go clean -cache') throw new Error('Unexpected command');
        await new Promise((resolve) => setTimeout(resolve, 400));
        await fs.rm(${JSON.stringify(go)}, { recursive: true, force: true });
        return { code: 0, stdout: '' };
      },
    });
  `);
  let child, logs = "";
  const start = async () => {
    child = spawn(process.execPath, [fileURLToPath(new URL("../docker/setup/server.mjs", import.meta.url))], { env: {
      ...process.env, HOME: home, T3CODE_HOME: path.join(home, ".t3"), T3_WORKSPACE: workspace,
      MISE_DATA_DIR: path.join(home, ".local/share/mise"), MISE_STATE_DIR: path.join(home, ".local/state/mise"),
      MISE_CONFIG_DIR: path.join(home, ".config/mise"), T3_HARNESS_MODULE: module, T3_SETUP_PORT: String(port),
      T3_SETUP_KEY: "fixture-key", T3_SETUP_KEY_SOURCE: "env", T3_INFRA_LAUNCHER: "/bin/false", T3CODE_PORT: "1",
    }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { logs += chunk; }); child.stderr.on("data", (chunk) => { logs += chunk; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(logs);
      try { if ((await fetch(`http://127.0.0.1:${port}/hello`)).ok) return; } catch { /* starting */ }
      await pause(20);
    }
    throw new Error(`Server did not start: ${logs}`);
  };
  const stop = async () => { if (child && child.exitCode === null) { const ended = once(child, "exit"); child.kill(); await ended; } };
  t.after(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });
  await start();
  const request = (route, body, headers = {}) => fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? "GET" : "POST",
    headers: { "x-t3-setup-key": "fixture-key", "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await fetch(`http://127.0.0.1:${port}/storage`)).status, 401);
  assert.equal((await request("/storage/clean", { ids: ["go"] }, { "sec-fetch-site": "cross-site" })).status, 403);
  for (const [route, body] of [["/storage/clean", { ids: ["go"], path: workspace }], ["/storage/clean", { ids: ["../../source"] }], ["/storage/clean", []], ["/storage/policy", { automatic: "true" }], ["/storage/policy", { ignored: true }], ["/storage/versions/prune", {}]]) assert.equal((await request(route, body)).status, 400);
  assert.equal((await request("/storage/versions/prune", { token: "a".repeat(64) })).status, 409);
  for (const includePrevious of ["true", 1, null, {}]) {
    assert.equal((await request("/storage/versions/prune", { token: "a".repeat(64), includePrevious })).status, 400);
  }
  for (const query of ['includePrevious=1', 'includePrevious=true&includePrevious=false', 'path=/workspace']) {
    assert.equal((await request('/storage/versions?' + query)).status, 400);
  }
  const safe = await (await request('/storage/versions')).json();
  const all = await (await request('/storage/versions?includePrevious=true')).json();
  assert.equal(safe.includePrevious, false); assert.equal(all.includePrevious, true);
  assert.notEqual(safe.token, all.token);
  assert.equal((await request('/storage/versions/prune', { token: safe.token, includePrevious: true })).status, 409);
  const pruning = await request('/storage/versions/prune', { token: all.token, includePrevious: true });
  assert.equal(pruning.status, 202);
  const reviewedJob = (await pruning.json()).operation;
  assert.equal(reviewedJob.includePrevious, true);
  for (let i=0;i<100;i++) {
    const state = await (await request('/storage')).json();
    if (state.operation?.state === 'succeeded') break;
    await pause(10);
  }
  const trimmed = await (await request('/storage')).json();
  assert.equal(trimmed.operation.id, reviewedJob.id); assert.equal(trimmed.operation.state,'succeeded');
  assert.equal(trimmed.policy.retainManagedVersions,true,'manual mode does not change automatic retention');
  assert.equal((await request("/proxy/__setup/storage")).status, 200);
  assert.equal((await request("/storage/refresh", {})).status, 202);
  const accepted = await request("/storage/clean", { ids: ["go"] });
  assert.equal(accepted.status, 202);
  const job = await accepted.json(); assert.equal(job.operation.state, "running");
  const record = JSON.parse(await fs.readFile(path.join(home, ".t3/setup/storage-operation.json")));
  assert.equal(record.id, job.operation.id); assert.equal(record.state, "running");
  const concurrent = await request("/storage/clean", { ids: ["go"] }); assert.equal(concurrent.status, 409);
  let status;
  for (let i = 0; i < 60; i++) {
    status = await (await request("/storage")).json();
    if (status.operation?.state === "succeeded") break;
    await pause(20);
  }
  assert.equal(status.operation.state, "succeeded"); assert.ok(status.operation.reclaimedBytes > 0);
  for (const file of protectedFiles) assert.equal(await fs.readFile(file, "utf8"), "keep or cache");
  assert.equal((await request("/storage/policy", { automatic: true, retainManagedVersions: false, goBudgetBytes: 750000000, npmBudgetBytes: 500000000 })).status, 200);
  await stop(); await start();
  status = await (await request("/storage")).json();
  assert.equal(status.policy.automatic, true); assert.equal(status.policy.retainManagedVersions, false);
  assert.equal(status.policy.goBudgetBytes, 750000000); assert.equal(status.operation.id, job.operation.id);
});
