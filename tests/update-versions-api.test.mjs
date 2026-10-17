// Real setup routes with a gated release source: reopening a picker and
// checking manually must not reuse an older list or an older pending read.
import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("version routes refresh reopened pickers and detach reads after a manual check", { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-update-versions-"));
  const home = path.join(root, "home");
  await fs.mkdir(home);
  const harness = path.join(root, "harness.mjs");
  await fs.writeFile(harness, `
    export * from ${JSON.stringify(new URL("../docker/harness/index.mjs", import.meta.url).href)};
    import { promises as fs } from 'node:fs';
    const root = ${JSON.stringify(root)}, calls = {};
    const versions = async (id) => {
      const call = calls[id] = (calls[id] || 0) + 1;
      if (id === 'codex' && call === 1) {
        await fs.writeFile(root + '/started', 'yes');
        while (true) {
          try { await fs.access(root + '/release'); break; }
          catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
        }
      }
      return { latest: String(call), releases: [{ version: String(call) }] };
    };
    export const createHarnessManager = () => ({
      versions, latestRelease: async () => ({ version: '1' }),
      toolchains: { latestRelease: async () => ({ version: '1' }) },
      packages: { versions }, paths: { stateDir: root },
    });
  `);
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  let logs = "";
  const child = spawn(process.execPath, [fileURLToPath(new URL("../docker/setup/server.mjs", import.meta.url))], {
    env: { ...process.env, HOME: home, T3CODE_HOME: path.join(home, ".t3"), T3_WORKSPACE: root,
      T3_SETUP_PORT: String(port), T3CODE_PORT: "1", T3_SETUP_KEY: "fixture", T3_SETUP_KEY_SOURCE: "env",
      T3_HARNESS_MODULE: harness, T3_INFRA_LAUNCHER: "/bin/false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* starting */ }
    await pause(20);
  }
  const request = (route, body) => fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-t3-setup-key": "fixture", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const read = async (id, target = "harnesses") => {
    const response = await request(`/${target}/versions?id=${id}`);
    assert.equal(response.status, 200, logs);
    return response.json();
  };
  assert.equal((await fetch(base + "/harnesses/versions?id=claude")).status, 401);
  for (const [id, target] of [["claude", "harnesses"], ["jq", "packages"]]) {
    assert.equal((await read(id, target)).latest, "1");
    assert.equal((await read(id, target)).latest, "2", "reopening fetches a new list");
  }
  const old = read("codex");
  for (let i = 0; i < 100; i++) {
    try { await fs.access(path.join(root, "started")); break; } catch { await pause(10); }
  }
  await fs.access(path.join(root, "started"));
  assert.equal((await request("/updates/check", {})).status, 202);
  assert.equal((await read("codex")).latest, "2", "manual check detaches the older pending list");
  await fs.writeFile(path.join(root, "release"), "yes");
  assert.equal((await old).latest, "1");
  assert.equal((await read("codex")).latest, "3", "old completion cannot become the next picker result");
});
