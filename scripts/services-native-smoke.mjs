// Real s6, kernel process groups, SQLite, HTTP and native exec. Disposable
// user home only; never opens production settings or credentials.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
const exec = promisify(execFile);
const installed = await fs.access("/opt/t3-services/controller.mjs").then(() => true, () => false);
const source = installed ? new URL("file:///opt/t3-services/") : new URL("../docker/services/", import.meta.url);
const { openStore } = await import(new URL("store.mjs", source));
const { createController } = await import(new URL("controller.mjs", source));
const { createUserTools } = await import(new URL("user-tools.mjs", source));
const { createSupervision } = await import(new URL("supervision.mjs", source));
const { containerBoot } = await import(new URL("paths.mjs", source));
if (process.getuid() === 0) throw new Error("Run this native test as the unprivileged account");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-services-native-"));
const env = { ...process.env, HOME: root, T3CODE_HOME: root + "/.t3", T3_RUN_DIR: root + "/run", T3_SETUP_KEY: "NEVER_INHERIT_NATIVE_CANARY", T3_SERVICES_PROCESS: process.env.T3_TEST_SERVICES_PROCESS || "/usr/local/libexec/t3-service-process" };
const bin = process.env.T3_TEST_S6_BIN || "/usr/bin", scan = root + "/scan";
env.PATH = bin + ":/usr/local/bin:/usr/bin:/bin";
await fs.mkdir(scan); await fs.mkdir(root + "/.t3", { recursive: true });
const scanner = spawn(path.join(bin, "s6-svscan"), [scan], { env, stdio: ["ignore", "ignore", "pipe"] });
let output = ""; scanner.stderr.on("data", data => { output += data; });
const store = openStore(root + "/.t3/setup/services/user");
const supervisor = createSupervision({ scan, domain: "user", node: process.execPath, bin, helper: env.T3_SERVICES_PROCESS, run: (file, args, opts) => exec(file, args, { ...opts, env }) });
const tools = createUserTools({ home: root, stateHome: store.root });
const controller = createController({ store, supervisor, tools });
const waitFor = async (fn, message, timeout = 12000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(message + ": " + output.slice(-1000));
};
const apply = async review => {
  const input = { planId: review.id, expectedRevision: review.expectedRevision, idempotencyKey: randomUUID() };
  const op = controller.apply(input); assert.equal(controller.apply(input).id, op.id);
  await controller.reconcile();
  await waitFor(() => controller.idle(), "controller did not settle");
  const result = controller.operation(op.id);
  assert.equal(result.state, "succeeded", JSON.stringify({ result, supervisorOutput: output, observation: store.meta("observation:" + result.target) }));
  return result;
};
let resource;
try {
  // Real pinned mise must not execute project or home hooks while inspecting
  // inventory or resolving a service's exact installed-tool environment.
  await fs.mkdir(root + '/.config/mise', { recursive: true });
  const hostile = `[env]\nSHOULD_NOT_INHERIT = 'project-value'\n[hooks]\nenter = 'touch ${root}/hook-ran'\n[tools]\nnode = '99.99.99'\n`;
  await fs.writeFile(root + '/mise.toml', hostile); await fs.writeFile(root + '/.config/mise/config.toml', hostile);
  const linked = root + '/.local/share/mise/installs/node/' + process.versions.node;
  await fs.mkdir(linked + '/bin', { recursive: true });
  // A copy is a real installed fixture, not a shim or mutable global default.
  await fs.copyFile(process.execPath, linked + '/bin/node'); await fs.chmod(linked + '/bin/node', 0o700);
  const pinned = await tools.resolve({ cwd: root, tools: [{ tool: 'node', version: process.versions.node }], mode: 'mise', executable: 'node', argv: [], env: {} });
  assert.equal(pinned.executable, linked + '/bin/node'); assert.equal(pinned.env.SHOULD_NOT_INHERIT, undefined);
  await assert.rejects(fs.access(root + '/hook-ran'));
  const listener = net.createServer().listen(0, "127.0.0.1"); await once(listener, "listening"); const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const app = `const fs=require('fs'),http=require('http'),{spawn}=require('child_process'); console.log(JSON.stringify({args:process.argv.slice(1),uid:process.getuid(),key:!!process.env.T3_SETUP_KEY,names:Object.keys(process.env)})); console.error('native stderr'); const orphan=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync('child.pid',String(orphan.pid)); http.createServer((q,s)=>s.end('healthy')).listen(${port},'127.0.0.1'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
  const draft = { name: "Native preview", mode: "executable", executable: process.execPath, argv: ["-e", app, "--", "", "a b", "$(false)", "雪"], cwd: root, enabled: true, restart: "on-failure", shutdownMs: 200, endpoints: [{ port, protocol: "http" }], health: { kind: "http", port, path: "/", graceMs: 1000, intervalMs: 1000 } };
  const review = await controller.plan({ action: "add", expectedRevision: 0, configuration: draft });
  await apply(review); resource = store.get(review.target);
  const logs = controller.logs(resource.id).entries;
  const facts = JSON.parse(logs.find(item => item.text.startsWith('{"args"')).text);
  assert.deepEqual(facts.args, ["", "a b", "$(false)", "雪"]);
  assert.equal(facts.uid, process.getuid()); assert.equal(facts.key, false); assert.ok(!facts.names.some(name => /^(?:T3_|MISE_)/.test(name)));
  assert.ok(logs.some(item => item.stream === "stderr" && item.text === "native stderr"));
  const child = Number(await fs.readFile(root + "/child.pid", "utf8"));
  const pid = store.meta("run:" + resource.id).payloadPid, owner = (await supervisor.observe(resource.id)).pid;
  await controller.reconcile(); assert.equal(store.meta("run:" + resource.id).payloadPid, pid, "read/reconcile must not duplicate a healthy run");
  await apply(await controller.plan({ action: "stop", id: resource.id, expectedRevision: resource.revision }));
  assert.throws(() => process.kill(child, 0), /ESRCH/, "stop must collect descendants");
  assert.throws(() => process.kill(owner, 0), /ESRCH/, 'stop must also finish and reap the monitor');
  resource = store.get(resource.id); assert.equal(resource.enabled, true); assert.equal(resource.stoppedBoot, containerBoot());
  await controller.reconcile(); assert.equal((await supervisor.observe(resource.id)).up, false);
  await apply(await controller.plan({ action: "enable", id: resource.id, expectedRevision: resource.revision }));
  resource = store.get(resource.id);
  const runner = store.meta("run:" + resource.id).pid;
  const orphan = Number(await fs.readFile(root + "/child.pid", "utf8"));
  process.kill(runner, "SIGKILL");
  await waitFor(() => { try { process.kill(orphan, 0); return false; } catch { return true; } }, "kernel parent-death cleanup left a descendant");
  await waitFor(async () => { await controller.reconcile(); return (await supervisor.observe(resource.id)).up; }, "crash did not restart under s6");
  resource = store.get(resource.id);
  await apply(await controller.plan({ action: "disable", id: resource.id, expectedRevision: resource.revision }));
  assert.equal(store.get(resource.id).enabled, false);
  console.log(JSON.stringify({ ok: true, arch: process.arch, uid: process.getuid(), checks: ['isolated real mise inventory and exact resolution', 'hostile project/home hooks ignored', "literal argv", "no inherited controller environment", "separate bounded logs", "real HTTP health", "one process owner", "owned descendant and monitor shutdown", "temporary stop", "kernel parent-death cleanup", "bounded restart", "persistent disable"] }));
} finally {
  controller.close();
  if (resource) await supervisor.stop(resource.id, 200).catch(() => {});
  scanner.kill("SIGTERM");
  if (scanner.exitCode === null) await once(scanner, "exit");
  while (!controller.idle()) await new Promise(resolve => setTimeout(resolve, 10));
  store.close(); await fs.rm(root, { recursive: true, force: true });
}
