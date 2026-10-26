// Exercise the native New project API without a browser, real credentials,
// provider installations or writes outside a disposable home.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const binary = path.resolve(process.argv[2] || process.env.T3_INFRA_BINARY || "/opt/t3/t3");
const apiModule = process.argv[3] || (process.argv[1] ? new URL("../docker/setup/t3-api.mjs", pathToFileURL(process.argv[1])).pathname : "/opt/t3-setup/t3-api.mjs");
const { createT3Api } = await import(pathToFileURL(path.resolve(apiModule)));
const spec = process.argv[1] ? new URL("../docker/runtime/distribution-spec.mjs", pathToFileURL(process.argv[1])) : pathToFileURL("/opt/t3-runtime/distribution-spec.mjs");
const { PATCH_REVISION } = await import(spec);
const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(binary), "package.json"), "utf8"));
assert.equal(manifest.containerPatch?.revision, PATCH_REVISION, "Native integration revision does not match this image");
const execute = promisify(execFile), root = await fs.mkdtemp(path.join(os.tmpdir(), process.env.T3_PROJECTS_UI_OUTPUT ? "t3-" : "t3-projects-smoke-"));
const home = path.join(root, "home"), state = path.join(home, ".t3"), workspace = path.join(root, "Work spaces 世界");
const env = { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: home, T3CODE_HOME: state, T3CODE_PROJECTS_DIR: workspace,
  XDG_CONFIG_HOME: path.join(home, ".config"), CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", T3CODE_HOST: "127.0.0.1" };
let child, done, api;
try {
  await fs.mkdir(path.join(state, "projects/existing"), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(state, "projects/existing/keep.txt"), "Existing project");
  await fs.writeFile(env.GIT_CONFIG_GLOBAL, "[user]\n name = Project smoke\n email = smoke@example.test\n");
  const reserve = net.createServer();
  await new Promise((resolve, reject) => { reserve.once("error", reject); reserve.listen(0, "127.0.0.1", resolve); });
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const issued = await execute(binary, ["auth", "session", "issue", "--ttl", "5m", "--subject", "workspace-smoke", "--json"], { env, timeout: 60_000 });
  const session = JSON.parse(issued.stdout.slice(issued.stdout.indexOf("{")));
  assert.equal(typeof session.token, "string", "Native CLI did not issue a session");
  const connected = await execute(binary, ["connect", "status", "--json"], { env, timeout: 60_000 });
  const connect = JSON.parse(connected.stdout.slice(connected.stdout.indexOf("{")));
  assert.equal(connect.desired, false, "Connect must remain off in the disposable home");
  assert.equal(connect.authenticated, false);
  assert.equal(connect.linked, false);
  assert.ok(["available", "missing"].includes(connect.relayClient?.status), "Public Connect capability must survive a local source build");
  const log = await fs.open(path.join(root, "server.log"), "wx", 0o600);
  child = spawn(binary, ["serve", "--host", "127.0.0.1", "--port", String(port), "--no-browser", workspace], { env, stdio: ["ignore", log.fd, log.fd] });
  done = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  await log.close();
  api = createT3Api({ url: `ws://127.0.0.1:${port}/ws`, issueSession: async () => session, renewWithinMs: 0, connectTimeoutMs: 1000, callTimeoutMs: 10_000 });
  let config, lastError;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !config && child.exitCode === null) {
    try { config = await api.call("server.getConfig", {}); }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  assert(config, `Native server did not become ready: ${lastError?.message || "exited"}`);
  assert.equal(config.newProjectsRoot, workspace, "The native client still advertises the state directory for New project");
  const first = await api.call("projects.createNew", { name: "Workspace project" });
  const second = await api.call("projects.createNew", { name: "Workspace project" });
  assert.equal(first.workspaceRoot, path.join(workspace, "workspace-project"));
  assert.equal(second.workspaceRoot, path.join(workspace, "workspace-project-2"));
  assert.notEqual(first.projectId, second.projectId);
  for (const project of [first, second]) {
    assert.equal((await fs.stat(path.join(project.workspaceRoot, ".git"))).isDirectory(), true);
    assert.match(await fs.readFile(path.join(project.workspaceRoot, "README.md"), "utf8"), /Workspace project/);
  }
  assert.equal(await fs.readFile(path.join(state, "projects/existing/keep.txt"), "utf8"), "Existing project");
  assert.deepEqual(await fs.readdir(path.join(state, "projects")), ["existing"]);
  if (process.env.T3_PROJECTS_UI_OUTPUT) {
    const { auditNativeProjectDirectory } = await import("./lib/project-directory-browser.cjs");
    await auditNativeProjectDirectory({ binary, base: `http://127.0.0.1:${port}`, env, workspace, version: manifest.version, execute, output: process.env.T3_PROJECTS_UI_OUTPUT });
  }
  console.log(JSON.stringify({ newProjectsRoot: workspace, nativeProjectsCreated: 2, collisionHandling: true, existingProjectsPreserved: true, connectAvailable: true }));
} finally {
  api?.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    let timeout;
    await Promise.race([done, new Promise((resolve) => { timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 10_000); })]);
    clearTimeout(timeout);
  }
  await fs.rm(root, { recursive: true, force: true });
}
