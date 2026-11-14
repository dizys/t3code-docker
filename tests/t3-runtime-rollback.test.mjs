import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runtimePaths, writeJson, readJson, readSelection, selectedRuntime, releaseDirectory } from "../docker/runtime/state.mjs";
import { recoverUpdate, restoreDatabase, snapshotDatabase } from "../docker/runtime/supervisor.mjs";

const NIGHTLY = "0.0.46-nightly.20261011.2980";
const cleanups = new WeakMap();
async function world(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-runtime-rollback-test-"));
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

async function fakeRuntime(paths, version, mode = "ready", bundled = false) {
  const dir = bundled ? path.dirname(paths.binary) : releaseDirectory(paths, { version });
  await fs.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, "package.json"), { version });
  await writeJson(path.join(dir, ".installed.json"), { version });
  const code = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const version = ${JSON.stringify(version)}, mode = ${JSON.stringify(mode)};
const home = process.env.T3CODE_HOME;
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT || '{}');
if (context.protocol !== 3) process.exit(8);
fs.appendFileSync(path.join(home, 'starts'), version + ' ' + process.pid + '\\n');
if (context.update) {
  const {DatabaseSync} = require('node:sqlite');
  const db = new DatabaseSync(path.join(home, 'userdata/statev2.sqlite'));
  db.exec("UPDATE content SET body='trial migration'");
  db.close();
  if (mode === 'crash-after-commit') process.send({type:'prepared',updateId:context.update.id});
  else process.exit(9);
}
process.on('message', msg => {
  if (msg.type === 'committed') {
    fs.writeFileSync(path.join(home, 'activated'), version);
    if (mode === 'crash-after-commit') setTimeout(() => process.exit(9), 300);
  }
});
process.on('SIGTERM', () => process.exit(143));
setInterval(() => {}, 1000);
`;
  await fs.writeFile(path.join(dir, "t3"), code, { mode: 0o755 });
  await fs.mkdir(path.join(dir, "client"), { recursive: true });
  await fs.writeFile(path.join(dir, "client/index.html"), "<body>Fixture native client</body>");
}

async function supervisor(t, env, timeout = 2000, commitHealthMs = 100) {
  const options = { preparedTimeoutMs: timeout, commitHealthMs };
  const driver = `import {runSupervisor} from ${JSON.stringify(new URL("../docker/runtime/supervisor.mjs", import.meta.url).href)}; process.exitCode = await runSupervisor(['serve'], ${JSON.stringify(options)});`;
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
  return request;
}

test("a release that crashes after commit is rolled back instead of rebooted", async (t) => {
  const { paths, env } = await world(t);
  await seedDatabase(path.join(paths.home, "userdata/statev2.sqlite"), "original data");
  await fakeRuntime(paths, "0.0.45", "ready", true);
  await fakeRuntime(paths, NIGHTLY, "crash-after-commit");
  const sup = await supervisor(t, env, 2000, 8000);
  const starts = () => fs.readFile(path.join(paths.home, "starts"), "utf8").catch(() => "");
  await waitFor(async () => (await starts()).includes("0.0.45"));
  await requestTrial(paths, NIGHTLY);
  await waitFor(async () => (await readJson(paths.operation))?.phase === "rolled-back", 10_000);
  assert.match((await readJson(paths.operation)).error, /exited before it stayed up/);
  assert.equal((await selectedRuntime(paths)).version, "0.0.45");
  assert.equal(await databaseContent(path.join(paths.home, "userdata/statev2.sqlite")), "original data");
  assert.equal(await readJson(paths.request), null);
  // The supervisor relaunches the previous release instead of exiting, so a
  // container restart would boot the good binary rather than crash-loop.
  await waitFor(async () => (await starts()).split("\n").filter((line) => line.startsWith("0.0.45 ")).length === 2, 10_000);
  assert.doesNotThrow(() => process.kill(sup.child.pid, 0));
});

test("a stale upgrade request boots the saved selection instead of throwing", async (t) => {
  const { paths, env } = await world(t);
  await fakeRuntime(paths, "0.0.45");
  await writeJson(paths.selection, { schema: 1, channel: "stable", version: "0.0.45" });
  await writeJson(paths.request, { id: randomUUID(), version: NIGHTLY, channel: "nightly", fromVersion: "0.0.45", phase: "stopping", previous: { schema: 1, channel: "stable", version: "0.0.44" } });
  // The image was downgraded (or the selection hand-fixed) after the request
  // was written, so it can never match. Booting must discard it and serve.
  await supervisor(t, env);
  await waitFor(async () => (await fs.readFile(path.join(paths.home, "starts"), "utf8").catch(() => "")).includes("0.0.45"));
  assert.equal((await readSelection(paths)).version, "0.0.45");
  assert.equal((await readJson(paths.operation)).phase, "interrupted");
  assert.match((await readJson(paths.operation)).error, /stale upgrade request/);
  assert.equal(await readJson(paths.request), null);
});

test("a committed selection naming the request still refuses a mismatched patch", async (t) => {
  const { paths } = await world(t);
  const request = { id: randomUUID(), version: "0.0.45", channel: "stable", fromVersion: "0.0.45", phase: "starting", previous: { schema: 1, channel: "stable", version: "0.0.45" } };
  await writeJson(paths.request, request);
  await writeJson(paths.selection, { schema: 1, version: request.version, channel: "stable", updateId: request.id, patchRevision: "a".repeat(64) });
  await assert.rejects(recoverUpdate(paths), /does not match/);
  assert.equal((await readJson(paths.request)).id, request.id);
});

test("snapshots cover only the migrating stores, not thread histories", async (t) => {
  const { paths } = await world(t);
  const userdata = path.join(paths.home, "userdata");
  await seedDatabase(path.join(userdata, "statev2.sqlite"), "migrating data");
  await seedDatabase(path.join(userdata, "threads.sqlite"), "thread history");
  await fs.mkdir(path.join(userdata, "cache"), { recursive: true });
  await seedDatabase(path.join(userdata, "cache/history.db"), "nested history");
  await snapshotDatabase(paths, "migrating-only", { fromDatabase: "statev2.sqlite", targetDatabase: "statev2.sqlite" });
  const backup = await readJson(path.join(paths.backup, "complete.json"));
  assert.deepEqual(backup.files, ["statev2.sqlite"]);
  assert.equal(await fs.readFile(path.join(paths.backup, "files/cache/history.db")).catch(() => null), null);
  assert.equal(await databaseContent(path.join(userdata, "threads.sqlite")), "thread history");
  await fs.writeFile(path.join(userdata, "statev2.sqlite"), "trial data");
  await restoreDatabase(paths, "migrating-only");
  assert.equal(await databaseContent(path.join(userdata, "statev2.sqlite")), "migrating data");
  assert.equal(await databaseContent(path.join(userdata, "threads.sqlite")), "thread history");
  assert.equal(await databaseContent(path.join(userdata, "cache/history.db")), "nested history");
});

test("snapshots default to the legacy and current stores without histories", async (t) => {
  const { paths } = await world(t);
  const userdata = path.join(paths.home, "userdata");
  for (const name of ["state.sqlite", "statev2.sqlite"]) await seedDatabase(path.join(userdata, name), "migrating " + name);
  await seedDatabase(path.join(userdata, "threads.sqlite"), "thread history");
  await snapshotDatabase(paths, "defaults");
  const backup = await readJson(path.join(paths.backup, "complete.json"));
  assert.deepEqual([...backup.files].sort(), ["state.sqlite", "statev2.sqlite"]);
});
