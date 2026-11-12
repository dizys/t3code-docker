// Exercise a real sign-in child, /proc retention checks, HTTP lifecycle jobs
// and provider wiring together. Only mise's installation inventory is faked.
import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test("an active device sign-in protects its agent until cancelled, then uninstall retracts its wiring", { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-signin-uninstall-"));
  let child, logs = "", signinPid;
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
    const pid = signinPid ?? Number(await fs.readFile(path.join(root, "signin.pid"), "utf8").catch(() => ""));
    if (pid) { try { process.kill(pid); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    await fs.rm(root, { recursive: true, force: true });
  });
  const home = path.join(root, "home"), state = path.join(home, ".t3");
  const dataDir = path.join(root, "mise-data"), configDir = path.join(root, "mise-config");
  const install = path.join(dataDir, "installs/grok/1.0.34"), executable = path.join(install, "grok");
  const pidFile = path.join(root, "signin.pid"), callsFile = path.join(root, "mise-calls.jsonl");
  const settingsFile = path.join(state, "userdata/settings.json");
  const launcher = path.join(home, ".local/share/t3-harness/launchers/grok/grok");
  await fs.mkdir(install, { recursive: true });
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "login" && process.argv[3] === "--device-auth") {
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  console.log("https://accounts.x.ai/device ABCD-EFGH");
  setInterval(() => {}, 1000);
} else if (process.argv[2] === "--version") console.log("1.0.34");
else process.exit(1);
`, { mode: 0o700 });
  const harnessUrl = new URL("../docker/harness/index.mjs", import.meta.url).href;
  const runnerUrl = new URL("../docker/harness/io.mjs", import.meta.url).href;
  const providerUrl = new URL("../docker/provider-integration/index.mjs", import.meta.url).href;
  const moduleFile = path.join(root, "harness.mjs");
  await fs.writeFile(moduleFile, `
export * from ${JSON.stringify(harnessUrl)};
import { createHarnessManager as createManager } from ${JSON.stringify(harnessUrl)};
import { createRunner } from ${JSON.stringify(runnerUrl)};
import { promises as fs } from "node:fs";
let installed = true, selected = true;
const run = createRunner();
export function createHarnessManager() {
  return createManager({ miseBin: "fixture-mise", run: async (argv, options) => {
    if (argv[0] !== "fixture-mise") return run(argv, options);
    const args = argv.slice(3);
    if (args[0] === "ls") return { code: 0, stdout: JSON.stringify({ grok: installed ? [{
      version: "1.0.34", installed: true, active: selected, install_path: ${JSON.stringify(install)},
      ...(selected ? { source: { path: ${JSON.stringify(path.join(configDir, "config.toml"))} } } : {}),
    }] : [] }) };
    if (args[0] === "settings") return { code: 0, stdout: "1d" };
    await fs.appendFile(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");
    if (args[0] === "unuse") selected = false;
    else if (args[0] === "uninstall") { await fs.rm(${JSON.stringify(install)}, { recursive: true }); installed = false; }
    else throw new Error("Unexpected fixture mise call: " + args[0]);
    return { code: 0, stdout: "" };
  } });
}
`);
  const socket = createServer().listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const env = { ...process.env, HOME: home, T3CODE_HOME: state, T3_RUN_DIR: path.join(root, "run"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"), T3_WORKSPACE: root,
    MISE_DATA_DIR: dataDir, MISE_STATE_DIR: path.join(root, "mise-state"), MISE_CONFIG_DIR: configDir,
    T3_HARNESS_MODULE: moduleFile, T3_PROVIDER_MODULE: providerUrl,
    T3_RUNTIME_MODULE: fileURLToPath(new URL("../docker/runtime/manager.mjs", import.meta.url)),
    T3_SETUP_KEY: "fixture", T3_SETUP_KEY_SOURCE: "env", T3_SETUP_PORT: String(port),
    T3CODE_PORT: "1", T3_INFRA_LAUNCHER: "/bin/false" };
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  await fs.writeFile(settingsFile, JSON.stringify({ theme: "dark", unrelated: { keep: true } }));
  // Use the shipping integration to create its owned launcher and settings.
  const { createProviderIntegration } = await import(providerUrl);
  const { createHarnessManager } = await import(harnessUrl);
  const seedManager = createHarnessManager({ env, run: async () => ({ code: 0, stdout: JSON.stringify({ grok: [{
    version: "1.0.34", installed: true, active: true, install_path: install,
    source: { path: path.join(configDir, "config.toml") },
  }] }) }) });
  const seeded = await createProviderIntegration({ env, harness: seedManager }).sync();
  assert.equal(seeded.ok, true);
  const originalSettings = await fs.readFile(settingsFile, "utf8"), originalLauncher = await fs.readFile(launcher, "utf8");
  child = spawn(process.execPath, [fileURLToPath(new URL("../docker/setup/server.mjs", import.meta.url))], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
  const base = `http://127.0.0.1:${port}`;
  const request = async (route, body) => {
    const response = await fetch(base + route, { method: body ? "POST" : "GET",
      headers: { "x-t3-setup-key": "fixture", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base + "/hello")).ok) { ready = true; break; } } catch {}
    await pause(20);
  }
  assert.equal(ready, true, "fixture Setup becomes ready");
  const signin = await request("/auth/signin", { agent: "grok" }); assert.equal(signin.status, 200);
  let session;
  for (let attempt = 0; attempt < 100; attempt++) {
    session = (await request(`/auth/session?id=${signin.body.id}`)).body;
    if (session.url) break;
    await pause(20);
  }
  assert.equal(session.state, "awaiting-browser"); assert.equal(session.url, "https://accounts.x.ai/device");
  signinPid = Number(await fs.readFile(pidFile, "utf8"));
  const uninstall = async () => {
    const response = await request("/harnesses/uninstall", { id: "grok" });
    assert.equal(response.status, 202);
    let op;
    for (let attempt = 0; attempt < 100; attempt++) {
      op = (await request("/status")).body.operations["harness:grok"];
      if (op && !["queued", "running"].includes(op.state)) return op;
      await pause(20);
    }
    throw new Error("Fixture uninstall did not settle");
  };
  const refused = await uninstall();
  assert.equal(refused.state, "failed"); assert.match(refused.error, /used by a running process/);
  assert.equal(await fs.readFile(settingsFile, "utf8"), originalSettings);
  assert.equal(await fs.readFile(launcher, "utf8"), originalLauncher);
  assert.ok((await fs.stat(executable)).isFile());
  await assert.rejects(fs.access(callsFile), { code: "ENOENT" }, "refusal precedes every mise mutation");
  assert.equal((await request("/auth/cancel", { id: signin.body.id })).body.ok, true);
  assert.equal((await request(`/auth/session?id=${signin.body.id}`)).body.state, "cancelled");
  let exited = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(signinPid, 0); } catch (error) { if (error.code === "ESRCH") { exited = true; break; } throw error; }
    await pause(20);
  }
  assert.equal(exited, true, "cancellation stops the actual sign-in child"); signinPid = 0;
  const removed = await uninstall();
  assert.equal(removed.state, "ok", removed.error);
  for (const file of [install, launcher]) await assert.rejects(fs.access(file), { code: "ENOENT" });
  const settings = JSON.parse(await fs.readFile(settingsFile, "utf8"));
  assert.equal(settings.providerInstances.grok.config.binaryPath, undefined);
  assert.equal(settings.theme, "dark"); assert.deepEqual(settings.unrelated, { keep: true });
  assert.deepEqual((await fs.readFile(callsFile, "utf8")).trim().split("\n").map(JSON.parse), [["unuse", "-g", "grok"], ["uninstall", "grok@1.0.34"]]);
});
