import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { nativeRegistry } from "./fixtures/native-registry.mjs";
import { PATCH_REVISION, channelTag, distributionTag, manifestUrl } from "../docker/runtime/distribution-spec.mjs";
import { runtimePaths, writeJson, readJson, readSelection, selectedRuntime, releaseDirectory, exactVersion } from "../docker/runtime/state.mjs";
import { createRuntimeManager, packageRelease, installRelease, executableVersion } from "../docker/runtime/manager.mjs";
import { recoverUpdate, snapshotDatabase, syncAuthentication, pruneRuntimes, projectScopes } from "../docker/runtime/supervisor.mjs";

const NIGHTLY = "0.0.46-nightly.20261011.2980";
const cleanups = new WeakMap();
async function world(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-runtime-test-"));
  const stops = [];
  cleanups.set(t, stops);
  t.after(async () => {
    for (const stop of stops.reverse()) await stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  const env = { ...process.env, T3CODE_HOME: path.join(root, "home"), T3_RUN_DIR: path.join(root, "run"), T3_INFRA_BINARY: path.join(root, "bundled/t3") };
  const paths = runtimePaths(env);
  await fs.mkdir(path.dirname(paths.binary), { recursive: true });
  await writeJson(path.join(path.dirname(paths.binary), "package.json"), { version: "0.0.45" });
  await fs.mkdir(path.join(paths.home, "userdata"), { recursive: true });
  return { root, env, paths };
}
const waitFor = async (fn, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("Timed out waiting for runtime state");
};
const nightlyIndex = (url) => url.endsWith('/manifests/' + channelTag('nightly'));
const stableChecksum = (url) => url.endsWith('/manifests/' + channelTag('stable'));
const registry = nativeRegistry().fetcher;
async function seedDatabase(file, value) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE content (body TEXT)");
  db.prepare("INSERT INTO content VALUES (?)").run(value);
  db.close();
}
async function databaseContent(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT body FROM content").get().body; } finally { db.close(); }
}

test("only stable and real nightly versions can select a runtime", () => {
  for (const version of ["0.0.45", NIGHTLY]) assert.equal(exactVersion(version), true);
  for (const version of ["latest", "nightly", "../0.0.45", "/tmp/t3", "0.0.46-preview.20261011.1", "0.0.46-nightly.x", "0.0.45\n"]) assert.equal(exactVersion(version), false, version);
});

test("both the stable and nightly CLI version banners are checked against the package", () => {
  assert.equal(executableVersion("0.0.45\n"), "0.0.45");
  assert.equal(executableVersion(`t3 v${NIGHTLY}\n`), NIGHTLY);
  assert.equal(executableVersion("another-program 0.0.45"), null);
});

test("invalid or incomplete persisted selections fail closed", async (t) => {
  const { paths } = await world(t);
  assert.equal((await selectedRuntime(paths)).bundled, true);
  await writeJson(paths.selection, { schema: 1, channel: "stable", version: "../../wrong" });
  await assert.rejects(readSelection(paths), /invalid/);
  await writeJson(paths.selection, { schema: 1, channel: "nightly", version: NIGHTLY });
  await assert.rejects(selectedRuntime(paths), /missing or incomplete/);
});

test("managed CLI resolution parks database commands during activation", async (t) => {
  const { env, paths } = await world(t);
  const execute = promisify(execFile);
  const resolve = () => execute(process.execPath, [new URL("../docker/runtime/resolve.mjs", import.meta.url).pathname], { env });
  await writeJson(paths.operation, { phase: "downloading" });
  assert.equal((await resolve()).stdout.trim(), paths.binary);
  await writeJson(paths.operation, { phase: "starting" });
  await assert.rejects(resolve(), /applying an update/);
  await writeJson(paths.operation, { phase: "succeeded" });
  assert.equal((await resolve()).stdout.trim(), paths.binary);
});

test("integrity failure never executes or publishes the download", async (t) => {
  const { paths } = await world(t);
  const pkg = await packageRelease("nightly", { fetcher: registry });
  pkg.size = Buffer.byteLength("corrupt archive");
  let runs = 0;
  await assert.rejects(installRelease(paths, pkg, { fetcher: async (url) => new Response(url.includes("/token?") ? JSON.stringify({ token: "fixture" }) : "corrupt archive"), run: async () => { runs += 1; } }), /integrity check/);
  assert.equal(runs, 0);
  assert.equal((await selectedRuntime(paths)).version, "0.0.45");
  assert.deepEqual(await fs.readdir(paths.versions), []);
});

test("two Setup instances cannot stage concurrent upgrades", async (t) => {
  const { env, paths } = await world(t);
  let releaseInstall;
  let installs = 0;
  const install = async () => { installs += 1; await new Promise((resolve) => { releaseInstall = resolve; }); throw new Error("download test ended"); };
  const options = { env, fetcher: registry, supervised: () => true, install };
  const first = createRuntimeManager(options);
  const second = createRuntimeManager(options);
  const answers = await Promise.all([first.update({ channel: "nightly", version: NIGHTLY }), second.update({ channel: "nightly", version: NIGHTLY })]);
  assert.deepEqual(answers.map((answer) => answer.http).sort(), [202, 409]);
  await waitFor(() => installs === 1);
  assert.equal((await second.status()).operation.phase, "checking");
  releaseInstall();
  await waitFor(async () => (await readJson(paths.operation))?.phase === "failed");
  assert.equal((await selectedRuntime(paths)).version, "0.0.45");
  assert.equal(await readJson(paths.request), null);
});

test("same-channel Update preserves newer installed releases", async (t) => {
  const { env, paths } = await world(t);
  await writeJson(path.join(path.dirname(paths.binary), "package.json"), { version: "0.0.50" });
  const manager = createRuntimeManager({ env, supervised: () => true, fetcher: registry });
  const answer = await manager.update({ channel: "stable", version: "0.0.45" });
  assert.equal(answer.http, 409);
  assert.match(answer.body.error, /will not downgrade/);
  assert.equal(await readJson(paths.operation), null);
});

test("a same-version integration uses the pinned native release even after its channel advances", async (t) => {
  const { env, paths } = await world(t);
  await fakeRuntime(paths, "0.0.45");
  await writeJson(path.join(paths.versions, "0.0.45/.installed.json"), { version: "0.0.45", database: "statev2.sqlite", scopes: ["orchestration:read"] });
  await writeJson(paths.selection, { schema: 1, channel: "stable", version: "0.0.45" });
  const feed = nativeRegistry({ stable: "0.0.50" }), pinned = nativeRegistry({ stable: "0.0.45" });
  for (const [url, text] of pinned.records) if (url !== manifestUrl(channelTag("stable"))) feed.records.set(url, text);
  let installed, restarted = false;
  const manager = createRuntimeManager({ env, fetcher: feed.fetcher, supervised: () => true, restart: async () => { restarted = true; },
    install: async (paths, release) => {
      installed = release;
      const directory = releaseDirectory(paths, release);
      await writeJson(path.join(directory, ".installed.json"), { version: release.version, patchRevision: release.patchRevision, database: "statev2.sqlite", scopes: ["orchestration:read"] });
      return directory;
    } });
  assert.equal((await manager.update({ channel: "stable", version: "0.0.45" })).http, 202);
  await waitFor(() => restarted);
  const request = await readJson(paths.request);
  assert.equal(installed.version, "0.0.45");
  assert.equal(request.version, "0.0.45");
  assert.equal(request.patchRevision, PATCH_REVISION);
  assert.equal(request.previous.version, "0.0.45");
  assert.ok(feed.calls.some(({ url }) => url === manifestUrl(distributionTag("0.0.45"))));
  assert.equal(feed.calls.some(({ url }) => url === manifestUrl(channelTag("stable"))), false);
  assert.equal((await selectedRuntime(paths)).patchRevision, null, "staging alone never changes the saved selection");
});

test("cached release checks remain available offline without selecting or installing", async (t) => {
  const { env, paths } = await world(t);
  await writeJson(paths.releases, { checkedAt: 1, channels: { stable: { version: "0.0.45" } } });
  const manager = createRuntimeManager({ env, fetcher: async () => { throw new Error("offline"); } });
  const checked = await manager.check();
  assert.match(checked.error, /offline/);
  assert.equal((await manager.status()).releases.stable.version, "0.0.45");
  assert.equal(await readJson(paths.selection), null);
});

test("an unavailable nightly tag does not block a fresh stable release check", async (t) => {
  const { env } = await world(t);
  const manager = createRuntimeManager({ env, fetcher: async (url) => nightlyIndex(url) ? new Response("missing", { status: 404 }) : registry(url) });
  const checked = await manager.check();
  assert.equal(checked.error, null);
  assert.match(checked.errors.nightly, /404/);
  assert.equal(checked.channels.stable.version, "0.0.45");
  assert.equal((await manager.status()).checkError, null);
});

test("a failed selected channel keeps its successful timestamp across restarts", async (t) => {
  const { env } = await world(t);
  let offline = false;
  const options = { env, fetcher: async (url) => {
    if (offline && stableChecksum(url)) throw new Error("stable offline");
    return registry(url);
  } };
  const manager = createRuntimeManager(options);
  await manager.check();
  const before = await manager.status();
  assert.ok(before.checkedAt);
  offline = true;
  const failed = await manager.check();
  assert.match(failed.error, /stable offline/, "Nightly success does not mask Stable failure");
  const after = await manager.status();
  assert.equal(after.checkedAt, before.checkedAt);
  assert.equal(after.releases.stable.version, before.releases.stable.version);
  assert.match(after.checkError, /stable offline/);
  const restarted = await createRuntimeManager(options).status();
  assert.equal(restarted.checkedAt, before.checkedAt);
  assert.match(restarted.checkError, /stable offline/);
  offline = false;
  assert.equal((await manager.check()).error, null);
  assert.equal((await manager.status()).checkError, null);
});

test("Stable success does not mask a failed selected Nightly channel", async (t) => {
  const { env, paths } = await world(t);
  await fakeRuntime(paths, NIGHTLY);
  await writeJson(paths.selection, { schema: 1, channel: "nightly", version: NIGHTLY });
  const manager = createRuntimeManager({ env, fetcher: async (url) => nightlyIndex(url) ? new Response("missing", { status: 404 }) : registry(url) });
  const result = await manager.check();
  assert.match(result.error, /404/);
  assert.equal(result.channels.stable.version, "0.0.45");
  const status = await manager.status();
  assert.equal(status.checkedAt, null);
  assert.match(status.checkError, /404/);
});

test("switching checks report the requested channel independently of the selected one", async (t) => {
  const { env } = await world(t);
  const calls = [];
  const manager = createRuntimeManager({ env, fetcher: async (url) => {
    calls.push(url);
    if (stableChecksum(url)) throw new Error('stable offline');
    return registry(url);
  } });
  const [stable, nightly] = await Promise.all([manager.check(), manager.check({ channel: 'nightly' })]);
  assert.match(stable.error, /stable offline/);
  assert.equal(nightly.error, null);
  assert.equal(nightly.channels.nightly.version, NIGHTLY);
  assert.equal(calls.length, 4, 'concurrent channel checks share anonymous registry authentication');
  await assert.rejects(manager.check({ channel: 'preview' }), /Stable or Nightly/);
});

test("legacy cached releases are shown without claiming a verified channel timestamp", async (t) => {
  const { env, paths } = await world(t);
  await writeJson(paths.releases, { checkedAt: 1234, channels: { stable: { version: "0.0.45" } } });
  const status = await createRuntimeManager({ env }).status();
  assert.equal(status.releases.stable.version, "0.0.45");
  assert.equal(status.checkedAt, null);
});

async function fakeRuntime(paths, version, mode = "ready", bundled = false, auth = {}, patchRevision) {
  const dir = bundled ? path.dirname(paths.binary) : releaseDirectory(paths, { version, patchRevision });
  await fs.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, "package.json"), { version });
  await writeJson(path.join(dir, ".installed.json"), { version, ...(patchRevision ? { patchRevision } : {}) });
  const code = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const version = ${JSON.stringify(version)}, mode = ${JSON.stringify(mode)};
const home = process.env.T3CODE_HOME;
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT || '{}');
if (process.argv[2] === 'auth') {
  const {DatabaseSync} = require('node:sqlite');
  const db = new DatabaseSync(path.join(home, 'userdata/statev2.sqlite'));
  db.exec("UPDATE content SET body='authentication preparation'");
  db.close();
  const auth = ${JSON.stringify(auth)};
  setTimeout(() => process.exit(auth.exitCode || 0), process.argv[3] === 'session' ? (auth.delayMs || 0) : 0);
  return;
}
fs.appendFileSync(path.join(home, 'starts'), version + ' ' + process.pid + '\\n');
fs.writeFileSync(path.join(home, 'project-environment.json'), JSON.stringify({ projectsDir: process.env.T3CODE_PROJECTS_DIR, home, version }));
if (context.update) {
  const {DatabaseSync} = require('node:sqlite');
  const db = new DatabaseSync(path.join(home, 'userdata/statev2.sqlite'));
  db.exec("UPDATE content SET body='trial migration'");
  db.close();
  const added = new DatabaseSync(path.join(home, 'userdata/introduced.sqlite'));
  added.exec('CREATE TABLE IF NOT EXISTS introduced (id TEXT)');
  added.close();
  if (mode === 'crash') process.exit(9);
  if (mode === 'ready') process.send({type:'prepared',updateId:context.update.id});
}
process.on('message', msg => { if (msg.type === 'committed') fs.writeFileSync(path.join(home, 'activated'), version); });
process.on('SIGTERM', () => process.exit(143));
setInterval(() => {}, 1000);
`;
  await fs.writeFile(path.join(dir, "t3"), code, { mode: 0o755 });
  await fs.mkdir(path.join(dir, "client"), { recursive: true });
  await fs.writeFile(path.join(dir, "client/index.html"), "<body>Fixture native client</body>");
}

test("starting a retained runtime refreshes only its image-owned Setup bridge", async t => {
  const {root,env,paths} = await world(t);
  await fakeRuntime(paths, NIGHTLY);
  const directory = releaseDirectory(paths,{version:NIGHTLY});
  const shell = path.join(directory,'client/index.html');
  const script = '// data-t3-setup-entry\nconst currentNavigation = true;';
  env.T3_SETUP_BRIDGE = path.join(root,'image-bridge.js');
  await fs.writeFile(env.T3_SETUP_BRIDGE,script);
  await fs.writeFile(shell,'<body><script data-t3-setup-bridge>obsoleteModal()</script></body>');
  const selection = {schema:1,channel:'nightly',version:NIGHTLY,updateId:'keep-update-identity'};
  await writeJson(paths.selection,selection);
  const binaryBefore = await fs.readFile(path.join(directory,'t3'));
  await supervisor(t,env);
  assert((await fs.readFile(shell,'utf8')).includes(script));
  assert(!(await fs.readFile(shell,'utf8')).includes('obsoleteModal'));
  assert.deepEqual(await readSelection(paths),selection);
  assert.deepEqual(await fs.readFile(path.join(directory,'t3')),binaryBefore);
});

async function supervisor(t, env, timeout = 2000, authenticationTimeoutMs) {
  const options = { preparedTimeoutMs: timeout, ...(authenticationTimeoutMs === undefined ? {} : { authenticationTimeoutMs }) };
  const driver = `import {runSupervisor} from ${JSON.stringify(new URL('../docker/runtime/supervisor.mjs', import.meta.url).href)}; process.exitCode = await runSupervisor(['serve'], ${JSON.stringify(options)});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", driver], { env, stdio: "pipe" });
  let log = "";
  child.stderr.on("data", (chunk) => { log += chunk; });
  const done = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  cleanups.get(t).push(async () => { child.kill("SIGTERM"); await done; });
  await waitFor(async () => Boolean(await fs.readFile(path.join(env.T3_RUN_DIR, "t3.pid")).catch(() => null)));
  return { child, done, log: () => log };
}

async function requestTrial(paths, version, channel = "nightly", database = {}) {
  await waitFor(async () => !await readJson(paths.request));
  const request = { id: randomUUID(), version, channel, fromVersion: (await selectedRuntime(paths)).version, phase: "stopping", previous: await readSelection(paths), ...database };
  await writeJson(paths.request, request);
  await fs.writeFile(path.join(paths.run, "restart"), "requested");
  process.kill(Number(await fs.readFile(path.join(paths.run, "t3.pid"), "utf8")), "SIGTERM");
  return request;
}

test("the workspace is the New project default across native release changes", async (t) => {
  const { paths, env, root } = await world(t);
  env.T3_WORKSPACE = path.join(root, "Work spaces 世界");
  delete env.T3CODE_PROJECTS_DIR;
  await seedDatabase(path.join(paths.home, "userdata/statev2.sqlite"), "original data");
  await fakeRuntime(paths, "0.0.45", "ready", true);
  await fakeRuntime(paths, NIGHTLY);
  const sup = await supervisor(t, env);
  const recorded = () => readJson(path.join(paths.home, "project-environment.json"));
  await waitFor(async () => (await recorded())?.version === "0.0.45");
  assert.deepEqual(await recorded(), { projectsDir: env.T3_WORKSPACE, home: paths.home, version: "0.0.45" });
  await requestTrial(paths, NIGHTLY);
  await waitFor(async () => (await readJson(paths.operation))?.phase === "succeeded");
  assert.deepEqual(await recorded(), { projectsDir: env.T3_WORKSPACE, home: paths.home, version: NIGHTLY });
  assert.doesNotThrow(() => process.kill(sup.child.pid, 0));
});

test("an explicit native New project directory takes precedence over the workspace", async (t) => {
  const { paths, env, root } = await world(t);
  env.T3_WORKSPACE = path.join(root, "workspace");
  env.T3CODE_PROJECTS_DIR = path.join(root, "chosen projects");
  await fakeRuntime(paths, "0.0.45", "ready", true);
  await supervisor(t, env);
  const file = path.join(paths.home, "project-environment.json");
  await waitFor(async () => Boolean(await readJson(file)));
  assert.deepEqual(await readJson(file), { projectsDir: env.T3CODE_PROJECTS_DIR, home: paths.home, version: "0.0.45" });
});

test("an integration update can replace the same native version without overwriting its original runtime", async (t) => {
  const { paths, env } = await world(t);
  await seedDatabase(path.join(paths.home, "userdata/statev2.sqlite"), "original data");
  await fakeRuntime(paths, "0.0.45");
  const original = await fs.readFile(path.join(paths.versions, "0.0.45/t3"));
  await writeJson(paths.selection, { schema: 1, channel: "stable", version: "0.0.45" });
  await fakeRuntime(paths, "0.0.45", "ready", false, {}, PATCH_REVISION);
  await supervisor(t, env);
  await requestTrial(paths, "0.0.45", "stable", { patchRevision: PATCH_REVISION });
  await waitFor(async () => (await readJson(paths.operation))?.phase === "succeeded");
  assert.equal((await readSelection(paths)).patchRevision, PATCH_REVISION);
  assert.equal((await selectedRuntime(paths)).patchRevision, PATCH_REVISION);
  assert.equal((await selectedRuntime(paths)).version, "0.0.45");
  assert.deepEqual(await fs.readFile(path.join(paths.versions, "0.0.45/t3")), original);
});

test("a failed same-version integration trial restores the original runtime and database", async (t) => {
  const { paths, env } = await world(t);
  await seedDatabase(path.join(paths.home, "userdata/statev2.sqlite"), "original data");
  await fakeRuntime(paths, "0.0.45");
  const selection = { schema: 1, channel: "stable", version: "0.0.45" };
  await writeJson(paths.selection, selection);
  await fakeRuntime(paths, "0.0.45", "crash", false, {}, PATCH_REVISION);
  await supervisor(t, env);
  await requestTrial(paths, "0.0.45", "stable", { patchRevision: PATCH_REVISION });
  await waitFor(async () => (await readJson(paths.operation))?.phase === "rolled-back");
  assert.deepEqual(await readSelection(paths), selection);
  assert.equal((await selectedRuntime(paths)).patchRevision, null);
  assert.equal(await databaseContent(path.join(paths.home, "userdata/statev2.sqlite")), "original data");
});

test("runtime selection rejects invalid and mismatched patch identities", async (t) => {
  const { paths } = await world(t);
  await assert.rejects(Promise.resolve().then(() => releaseDirectory(paths, { version: "0.0.45", patchRevision: "../escape" })), /Invalid/);
  await writeJson(paths.selection, { schema: 1, channel: "stable", version: "0.0.45", patchRevision: "../escape" });
  await assert.rejects(readSelection(paths), /invalid/);
  await fakeRuntime(paths, "0.0.45", "ready", false, {}, PATCH_REVISION);
  await writeJson(paths.selection, { schema: 1, channel: "stable", version: "0.0.45", patchRevision: PATCH_REVISION });
  await writeJson(path.join(releaseDirectory(paths, { version: "0.0.45", patchRevision: PATCH_REVISION }), ".installed.json"), { version: "0.0.45", patchRevision: "a".repeat(64) });
  await assert.rejects(selectedRuntime(paths), /patch is missing/);
});

test("a ready upgrade commits without replacing the supervisor; stable can be selected again", async (t) => {
  const { paths, env } = await world(t);
  await seedDatabase(path.join(paths.home, "userdata/statev2.sqlite"), "original data");
  await fakeRuntime(paths, "0.0.45", "ready", true);
  await fakeRuntime(paths, NIGHTLY);
  await fakeRuntime(paths, "0.0.45");
  await writeJson(paths.releases, { channels: { stable: { version: "0.0.45" }, nightly: { version: NIGHTLY } } });
  const sup = await supervisor(t, env);
  await requestTrial(paths, NIGHTLY);
  await waitFor(async () => (await readJson(paths.operation))?.phase === "succeeded");
  assert.equal((await readSelection(paths)).channel, "nightly");
  assert.equal((await selectedRuntime(paths)).version, NIGHTLY);
  assert.doesNotThrow(() => process.kill(sup.child.pid, 0));
  await waitFor(async () => (await fs.readFile(path.join(paths.home, "activated"), "utf8").catch(() => null)) === NIGHTLY);
  await requestTrial(paths, "0.0.45", "stable");
  await waitFor(async () => (await readSelection(paths)).channel === "stable" && (await readJson(paths.operation))?.phase === "succeeded");
  assert.equal((await selectedRuntime(paths)).version, "0.0.45");
  assert.doesNotThrow(() => process.kill(sup.child.pid, 0));
});

test("first database preparation can exceed thirty seconds before activation", async (t) => {
  const { paths, env } = await world(t);
  await seedDatabase(path.join(paths.home, "userdata/statev2.sqlite"), "original data");
  await fakeRuntime(paths, "0.0.45", "ready", true);
  await fakeRuntime(paths, NIGHTLY, "ready", false, { delayMs: 31_000 });
  const sup = await supervisor(t, env);
  await requestTrial(paths, NIGHTLY, "nightly", { fromDatabase: "statev2.sqlite", targetDatabase: "statev2.sqlite" });
  await waitFor(async () => ["succeeded", "rolled-back"].includes((await readJson(paths.operation))?.phase), 40_000);
  assert.equal((await readJson(paths.operation)).phase, "succeeded");
  assert.equal((await selectedRuntime(paths)).version, NIGHTLY);
  assert.doesNotThrow(() => process.kill(sup.child.pid, 0));
});

for (const [kind, auth, error] of [
  ["timeout", { delayMs: 5000 }, /database.*timed out/],
  ["invalid records", { exitCode: 1 }, /cannot read the paired devices/],
]) test(`authentication preparation ${kind} restores data and keeps Stable`, async (t) => {
  const { paths, env } = await world(t);
  await seedDatabase(path.join(paths.home, "userdata/statev2.sqlite"), "original data");
  await fakeRuntime(paths, "0.0.45", "ready", true);
  await fakeRuntime(paths, NIGHTLY, "ready", false, auth);
  const sup = await supervisor(t, env, 2000, 1000);
  await requestTrial(paths, NIGHTLY, "nightly", { fromDatabase: "statev2.sqlite", targetDatabase: "statev2.sqlite" });
  await waitFor(async () => (await readJson(paths.operation))?.phase === "rolled-back");
  assert.match((await readJson(paths.operation)).error, error);
  assert.equal((await selectedRuntime(paths)).version, "0.0.45");
  assert.equal(await databaseContent(path.join(paths.home, "userdata/statev2.sqlite")), "original data");
  assert.equal(await readJson(paths.request), null);
  assert.doesNotThrow(() => process.kill(sup.child.pid, 0));
});

for (const mode of ["crash", "hang"]) test(`a ${mode} trial restores SQLite and keeps the container supervisor alive`, async (t) => {
  const { paths, env } = await world(t);
  await seedDatabase(path.join(paths.home, "userdata/statev2.sqlite"), "original database");
  await fakeRuntime(paths, "0.0.45", "ready", true);
  await fakeRuntime(paths, NIGHTLY, mode);
  const sup = await supervisor(t, env, 200);
  await requestTrial(paths, NIGHTLY);
  await waitFor(async () => (await readJson(paths.operation))?.phase === "rolled-back");
  assert.equal((await selectedRuntime(paths)).version, "0.0.45");
  assert.equal(await databaseContent(path.join(paths.home, "userdata/statev2.sqlite")), "original database");
  assert.equal(await fs.readFile(path.join(paths.home, "userdata/introduced.sqlite")).catch(() => null), null);
  assert.doesNotThrow(() => process.kill(sup.child.pid, 0));
});

test("an interrupted trial restores its original snapshot before any runtime boots", async (t) => {
  const { paths } = await world(t);
  const request = { id: randomUUID(), version: NIGHTLY, channel: "nightly", fromVersion: "0.0.45", phase: "starting", previous: await readSelection(paths) };
  const database = path.join(paths.home, "userdata/statev2.sqlite");
  await seedDatabase(database, "before upgrade");
  await snapshotDatabase(paths, request.id);
  await fs.writeFile(database, "partially migrated");
  await writeJson(paths.request, request);
  await recoverUpdate(paths);
  assert.equal(await databaseContent(database), "before upgrade");
  assert.equal((await readJson(paths.operation)).phase, "interrupted");
  assert.equal(await readJson(paths.request), null);
});

test("recovery preserves a committed target even if cleanup was interrupted", async (t) => {
  const { paths } = await world(t);
  const request = { id: randomUUID(), version: NIGHTLY, channel: "nightly", fromVersion: "0.0.45", phase: "starting", previous: await readSelection(paths) };
  await writeJson(paths.request, request);
  await writeJson(paths.selection, { schema: 1, version: NIGHTLY, channel: "nightly", updateId: request.id });
  const database = path.join(paths.home, "userdata/statev2.sqlite");
  await fs.writeFile(database, "committed data");
  await recoverUpdate(paths);
  assert.equal(await fs.readFile(database, "utf8"), "committed data");
  assert.equal((await readJson(paths.operation)).phase, "succeeded");
});

test("recovery requires the committed integration identity as well as its native version", async (t) => {
  const { paths } = await world(t);
  const request = { id: randomUUID(), version: "0.0.45", channel: "stable", patchRevision: PATCH_REVISION, fromVersion: "0.0.45", phase: "starting", previous: { schema: 1, channel: "stable", version: "0.0.45" } };
  const database = path.join(paths.home, "userdata/statev2.sqlite");
  await fs.writeFile(database, "committed data");
  await writeJson(paths.request, request);
  await writeJson(paths.selection, { schema: 1, version: request.version, channel: "stable", updateId: request.id, patchRevision: "a".repeat(64) });
  await assert.rejects(recoverUpdate(paths), /does not match/);
  assert.equal((await readJson(paths.request)).id, request.id);
  await writeJson(paths.selection, { schema: 1, version: request.version, channel: "stable", updateId: request.id, patchRevision: PATCH_REVISION });
  await recoverUpdate(paths);
  assert.equal((await readJson(paths.operation)).phase, "succeeded");
  assert.equal(await fs.readFile(database, "utf8"), "committed data");
});

test("a SQLite snapshot includes committed WAL data and needs no disappearing sidecars", async (t) => {
  const { paths } = await world(t);
  const { DatabaseSync } = await import("node:sqlite");
  const file = path.join(paths.home, "userdata/statev2.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE content (body TEXT); INSERT INTO content VALUES ('committed in WAL')");
  assert((await fs.stat(`${file}-wal`)).size > 0);
  await snapshotDatabase(paths, "wal-proof");
  db.close(); // Removes/checkpoints the live sidecars after the snapshot.
  const backup = await readJson(path.join(paths.backup, "complete.json"));
  assert.deepEqual(backup.files, ["statev2.sqlite"]);
  assert.equal(await databaseContent(path.join(paths.backup, "files/statev2.sqlite")), "committed in WAL");
});

test("switching stores preserves new pairings and revocations without replacing either thread history", async (t) => {
  const { paths } = await world(t);
  const { DatabaseSync } = await import("node:sqlite");
  for (const [file, history] of [["state.sqlite", "stable thread"], ["statev2.sqlite", "nightly thread"]]) {
    const db = new DatabaseSync(path.join(paths.home, "userdata", file));
    db.exec("CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, revoked TEXT); CREATE TABLE auth_pairing_links (id TEXT PRIMARY KEY, consumed TEXT); CREATE TABLE threads (body TEXT)");
    db.prepare("INSERT INTO threads VALUES (?)").run(history);
    db.prepare("INSERT INTO auth_sessions VALUES (?, ?)").run("original device", file === "statev2.sqlite" ? "revoked" : null);
    db.close();
  }
  const nightly = new DatabaseSync(path.join(paths.home, "userdata/statev2.sqlite"));
  nightly.prepare("INSERT INTO auth_sessions VALUES (?, ?)").run("new nightly device", null);
  nightly.prepare("INSERT INTO auth_pairing_links VALUES (?, ?)").run("one-time link", "consumed");
  nightly.close();
  await syncAuthentication(paths, { fromDatabase: "statev2.sqlite", targetDatabase: "state.sqlite" });
  const stable = new DatabaseSync(path.join(paths.home, "userdata/state.sqlite"));
  assert.equal(stable.prepare("SELECT revoked FROM auth_sessions WHERE id='original device'").get().revoked, "revoked");
  assert.equal(stable.prepare("SELECT count(*) AS n FROM auth_sessions").get().n, 2);
  assert.equal(stable.prepare("SELECT consumed FROM auth_pairing_links").get().consumed, "consumed");
  assert.equal(stable.prepare("SELECT body FROM threads").get().body, "stable thread");
  stable.prepare("INSERT INTO auth_sessions VALUES (?, ?)").run("new stable device", null);
  stable.close();
  await syncAuthentication(paths, { fromDatabase: "state.sqlite", targetDatabase: "statev2.sqlite" });
  const reread = new DatabaseSync(path.join(paths.home, "userdata/statev2.sqlite"));
  assert.equal(reread.prepare("SELECT count(*) AS n FROM auth_sessions").get().n, 3);
  assert.equal(reread.prepare("SELECT body FROM threads").get().body, "nightly thread");
  reread.close();
});

test("an incompatible authentication schema rolls back the whole transfer", async (t) => {
  const { paths } = await world(t);
  const { DatabaseSync } = await import("node:sqlite");
  for (const file of ["state.sqlite", "statev2.sqlite"]) {
    const db = new DatabaseSync(path.join(paths.home, "userdata", file));
    db.exec("CREATE TABLE auth_sessions (id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO auth_sessions VALUES (?)").run(file);
    db.exec(file === "state.sqlite" ? "CREATE TABLE auth_pairing_links (id TEXT)" : "CREATE TABLE auth_pairing_links (id TEXT, incompatible TEXT)");
    db.close();
  }
  await assert.rejects(syncAuthentication(paths, { fromDatabase: "statev2.sqlite", targetDatabase: "state.sqlite" }), /incompatible/);
  const db = new DatabaseSync(path.join(paths.home, "userdata/state.sqlite"));
  assert.equal(db.prepare("SELECT id FROM auth_sessions").get().id, "state.sqlite");
  db.close();
});

test("retired nightly caches are removed while active, previous and channel targets are retained", async (t) => {
  const { paths } = await world(t);
  const old = "0.0.46-nightly.20261008.1000";
  const previous = "0.0.46-nightly.20261010.2900";
  for (const version of [old, previous, NIGHTLY, "0.0.45"]) await fakeRuntime(paths, version);
  await fs.mkdir(path.join(paths.versions, "unrecognized"));
  await writeJson(paths.releases, { channels: { stable: { version: "0.0.45" }, nightly: { version: NIGHTLY } } });
  await pruneRuntimes(paths, { version: NIGHTLY, previous: { version: previous } });
  assert.deepEqual((await fs.readdir(paths.versions)).sort(), ["0.0.45", previous, NIGHTLY, "unrecognized"].sort());
});

test("patch cache cleanup keeps the active, previous and channel builds without accumulating retired variants", async (t) => {
  const { paths } = await world(t);
  const previous = "b".repeat(64), retired = "c".repeat(64), target = "d".repeat(64), oldVersion = "0.0.44";
  for (const revision of [PATCH_REVISION, previous, retired]) await fakeRuntime(paths, "0.0.45", "ready", false, {}, revision);
  await fakeRuntime(paths, "0.0.45");
  await fakeRuntime(paths, NIGHTLY, "ready", false, {}, target);
  await fakeRuntime(paths, oldVersion, "ready", false, {}, retired);
  const unknown = path.join(paths.versions, "0.0.45/patches", "e".repeat(64));
  await fs.mkdir(unknown);
  await fs.writeFile(path.join(unknown, "unrecognized"), "Keep unowned files");
  await writeJson(paths.releases, { channels: { stable: { version: "0.0.45", patchRevision: PATCH_REVISION }, nightly: { version: NIGHTLY, patchRevision: target } } });
  await pruneRuntimes(paths, { version: "0.0.45", patchRevision: PATCH_REVISION, previous: { version: "0.0.45", patchRevision: previous } });
  assert.deepEqual((await fs.readdir(path.join(paths.versions, "0.0.45/patches"))).sort(), [PATCH_REVISION, previous, "e".repeat(64)].sort());
  await fs.access(path.join(releaseDirectory(paths, { version: NIGHTLY, patchRevision: target }), "t3"));
  await fs.access(path.join(paths.versions, "0.0.45/t3"));
  await assert.rejects(fs.access(path.join(paths.versions, oldVersion)), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(unknown, "unrecognized"), "utf8"), "Keep unowned files");
});

const LEGACY = ["orchestration:read", "orchestration:operate", "terminal:operate", "access:read", "access:write"];
const GRANULAR = [...LEGACY, "filesystem:read", "diagnostics:read", "settings:write", "providers:manage", "environment:maintain", "preview:operate", "source-control:write", "filesystem:write", "terminal:read"];
test("restricted granular grants cannot gain broad older-release permissions", () => {
  assert.deepEqual(projectScopes(["orchestration:operate"], GRANULAR, LEGACY), []);
  assert.deepEqual(projectScopes(["orchestration:read", "filesystem:read"], GRANULAR, LEGACY), []);
  assert.deepEqual(projectScopes(GRANULAR, GRANULAR, LEGACY), LEGACY);
});

test("new nightly devices remain readable on Stable and regain only their prior grants on return", async (t) => {
  const { paths } = await world(t);
  const { DatabaseSync } = await import("node:sqlite");
  for (const file of ["state.sqlite", "statev2.sqlite"]) {
    const db = new DatabaseSync(path.join(paths.home, "userdata", file));
    db.exec("CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY, subject TEXT, issued_at TEXT, method TEXT, scopes TEXT, revoked_at TEXT); CREATE TABLE auth_pairing_links (id TEXT PRIMARY KEY, credential TEXT, subject TEXT, created_at TEXT, method TEXT, scopes TEXT, consumed_at TEXT, revoked_at TEXT)");
    db.close();
  }
  const nightly = new DatabaseSync(path.join(paths.home, "userdata/statev2.sqlite"));
  const insert = nightly.prepare("INSERT INTO auth_sessions VALUES (?, 'device', 'issued', 'bearer-access-token', ?, NULL)");
  insert.run("admin", JSON.stringify(GRANULAR));
  insert.run("restricted", JSON.stringify(["orchestration:operate", "settings:write"]));
  insert.run("changed", JSON.stringify(GRANULAR));
  nightly.prepare("INSERT INTO auth_pairing_links VALUES ('link', 'credential', 'device', 'created', 'one-time-token', ?, 'consumed', NULL)").run(JSON.stringify(GRANULAR));
  nightly.close();
  await syncAuthentication(paths, { fromDatabase: "statev2.sqlite", targetDatabase: "state.sqlite", fromScopes: GRANULAR, targetScopes: LEGACY });
  const stable = new DatabaseSync(path.join(paths.home, "userdata/state.sqlite"));
  assert.deepEqual(JSON.parse(stable.prepare("SELECT scopes FROM auth_sessions WHERE session_id='admin'").get().scopes), LEGACY);
  assert.deepEqual(JSON.parse(stable.prepare("SELECT scopes FROM auth_sessions WHERE session_id='restricted'").get().scopes), []);
  stable.exec("UPDATE auth_sessions SET revoked_at='revoked' WHERE session_id='admin'");
  stable.prepare("UPDATE auth_sessions SET scopes=? WHERE session_id='changed'").run(JSON.stringify(["orchestration:read"]));
  stable.close();
  await syncAuthentication(paths, { fromDatabase: "state.sqlite", targetDatabase: "statev2.sqlite", fromScopes: LEGACY, targetScopes: GRANULAR });
  const reread = new DatabaseSync(path.join(paths.home, "userdata/statev2.sqlite"));
  const admin = reread.prepare("SELECT scopes,revoked_at FROM auth_sessions WHERE session_id='admin'").get();
  assert.deepEqual(JSON.parse(admin.scopes), GRANULAR);
  assert.equal(admin.revoked_at, "revoked");
  assert.deepEqual(JSON.parse(reread.prepare("SELECT scopes FROM auth_sessions WHERE session_id='restricted'").get().scopes), ["orchestration:operate", "settings:write"]);
  assert.deepEqual(JSON.parse(reread.prepare("SELECT scopes FROM auth_sessions WHERE session_id='changed'").get().scopes), ["orchestration:read"]);
  assert.equal(reread.prepare("SELECT consumed_at FROM auth_pairing_links").get().consumed_at, "consumed");
  reread.close();
  const restricted = new DatabaseSync(path.join(paths.home, "userdata/statev2.sqlite"));
  restricted.prepare("INSERT INTO auth_sessions VALUES ('unsafe-old-parent', 'device', 'issued', 'bearer-access-token', ?, NULL)").run(JSON.stringify(["orchestration:operate"]));
  restricted.close();
  await assert.rejects(syncAuthentication(paths, { fromDatabase: "statev2.sqlite", targetDatabase: "state.sqlite", fromScopes: GRANULAR, targetScopes: LEGACY }), /Revoke it before switching/);
});
