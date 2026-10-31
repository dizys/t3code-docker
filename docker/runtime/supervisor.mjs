// Only this supervisor commits a downloaded runtime. The target reports
// prepared over T3's launcher protocol before it may accept commands.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refreshSetupBridge } from "./client-shell.mjs";
import { CHANNELS, exactVersion, databaseName, validScopes, validPatchRevision, runtimePaths, readJson, writeJson, readSelection, selectedRuntime } from "./state.mjs";

const sqlite = /\.(?:sqlite3?|db)(?:-wal|-shm|-journal)?$/;
const exists = async (file) => { try { await fs.access(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };

export async function waitForFilesHold(file,{timeoutMs=10*60_000,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now,stopping=()=>false}={}) {
  const deadline=now()+timeoutMs;
  while(!stopping()&&await exists(file)&&now()<deadline)await sleep(500);
  if(await exists(file))await fs.rm(file,{force:true});
}

async function databaseFiles(root, relative = "") {
  let entries;
  try { entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await databaseFiles(root, name));
    else if (sqlite.test(entry.name)) {
      if (!entry.isFile()) throw new Error("Cannot snapshot a database through a symbolic link.");
      files.push(name);
    }
  }
  return files;
}

async function syncFile(target) {
  await fs.chmod(target, 0o600);
  const file = await fs.open(target, "r");
  try { await file.sync(); } finally { await file.close(); }
  const directory = await fs.open(path.dirname(target), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function syncedCopy(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.copyFile(source, target);
  await syncFile(target);
}

export async function snapshotDatabase(paths, id) {
  const existing = await readJson(path.join(paths.backup, "complete.json"));
  if (existing?.id === id) return;
  const stage = `${paths.backup}.staging`;
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true, mode: 0o700 });
  const userdata = path.join(paths.home, "userdata");
  // SQLite's backup API includes committed WAL records in a consistent main
  // database. Sidecars can disappear when a last reader closes, and copying
  // the main file and WAL separately can capture different checkpoints.
  const files = (await databaseFiles(userdata)).filter((file) => /\.(?:sqlite3?|db)$/.test(file));
  const { DatabaseSync, backup } = await import("node:sqlite");
  for (const file of files) {
    const target = path.join(stage, "files", file);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const source = new DatabaseSync(path.join(userdata, file), { readOnly: true });
    try { await backup(source, target); } finally { source.close(); }
    await syncFile(target);
  }
  await writeJson(path.join(stage, "complete.json"), { id, files });
  await fs.rm(paths.backup, { recursive: true, force: true });
  await fs.rename(stage, paths.backup);
  const directory = await fs.open(paths.root, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function restoreDatabase(paths, id) {
  const backup = await readJson(path.join(paths.backup, "complete.json"));
  if (backup?.id !== id || !Array.isArray(backup.files) || backup.files.some((file) => typeof file !== "string" || path.isAbsolute(file) || file.split(path.sep).includes("..") || !sqlite.test(file))) {
    throw new Error("The upgrade's database snapshot is incomplete. Refusing to start against partially restored data.");
  }
  const userdata = path.join(paths.home, "userdata");
  // Also remove databases introduced by the trial, and all of their sidecars.
  for (const file of await databaseFiles(userdata)) await fs.rm(path.join(userdata, file), { force: true });
  for (const file of backup.files) await syncedCopy(path.join(paths.backup, "files", file), path.join(userdata, file));
}

export function validateRequest(request) {
  if (!request || typeof request.id !== "string" || !/^[0-9a-f-]{36}$/.test(request.id) || !exactVersion(request.version) || !exactVersion(request.fromVersion) || !CHANNELS.includes(request.channel)
    || request.previous?.schema !== 1 || !CHANNELS.includes(request.previous.channel) || (request.previous.version !== null && !exactVersion(request.previous.version))) {
    throw new Error("Invalid T3 Code upgrade request. Refusing to change the selected runtime.");
  }
  if ((request.fromDatabase !== undefined && !databaseName(request.fromDatabase)) || (request.targetDatabase !== undefined && !databaseName(request.targetDatabase))) throw new Error("Invalid upgrade database path.");
  if ((request.fromScopes !== undefined && !validScopes(request.fromScopes)) || (request.targetScopes !== undefined && !validScopes(request.targetScopes))) throw new Error("Invalid upgrade authentication capabilities.");
  if ((request.patchRevision !== undefined && !validPatchRevision(request.patchRevision)) || (request.previous.patchRevision !== undefined && !validPatchRevision(request.previous.patchRevision))) throw new Error("Invalid runtime integration patch.");
  return request;
}

// Upstream split these former broad permissions into explicit child grants.
// A new restricted credential must not gain its absent child permissions by
// being projected onto an older server's broad parent scope.
const legacyChildren = {
  "orchestration:read": ["filesystem:read", "diagnostics:read"],
  "orchestration:operate": ["settings:write", "providers:manage", "environment:maintain", "preview:operate", "source-control:write", "filesystem:write"],
  "terminal:operate": ["terminal:read"],
};
export function projectScopes(scopes, sourceScopes, targetScopes) {
  return scopes.filter((scope) => targetScopes.includes(scope) && !(legacyChildren[scope] || []).some((child) => sourceScopes.includes(child) && !targetScopes.includes(child) && !scopes.includes(child)));
}

/** Keep devices paired, and revocations effective, when upstream changes stores.
 * Only the two native auth tables are transferred; thread histories stay owned
 * by their release. A schema mismatch fails before the trial can start.
 */
export async function syncAuthentication(paths, request) {
  if (!request.fromDatabase || !request.targetDatabase || request.fromDatabase === request.targetDatabase) return;
  if (!databaseName(request.fromDatabase) || !databaseName(request.targetDatabase)) throw new Error("Invalid authentication database path.");
  const sourcePath = path.join(paths.home, "userdata", request.fromDatabase);
  const targetPath = path.join(paths.home, "userdata", request.targetDatabase);
  if (!await exists(targetPath)) return; // Upstream seeds a new store from the legacy database itself.
  const { DatabaseSync } = await import("node:sqlite");
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const target = new DatabaseSync(targetPath);
  try {
    target.exec("BEGIN IMMEDIATE");
    for (const table of ["auth_sessions", "auth_pairing_links"]) {
      const schema = (db) => db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
      if (!schema(source) || schema(source) !== schema(target)) throw new Error("These releases use incompatible device authentication formats. The previous version was kept.");
      const columns = source.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      const quoted = columns.map((name) => '"' + name.replaceAll('"', '""') + '"').join(",");
      const rows = source.prepare(`SELECT ${quoted} FROM ${table}`).all();
      const identity = table === "auth_sessions" ? ["session_id", "subject", "issued_at", "method"] : ["id", "credential", "subject", "created_at", "method"];
      const key = identity[0];
      const existing = columns.includes("scopes") && columns.includes(key)
        ? new Map(target.prepare(`SELECT ${quoted} FROM ${table}`).all().map((row) => [row[key], row])) : new Map();
      target.exec(`DELETE FROM ${table}`);
      const insert = target.prepare(`INSERT INTO ${table} (${quoted}) VALUES (${columns.map(() => "?").join(",")})`);
      for (const row of rows) {
        if (columns.includes("scopes") && request.targetScopes && request.fromScopes) {
          let scopes = JSON.parse(row.scopes);
          let restoredGrant = false;
          if (!validScopes(scopes)) throw new Error("A device has invalid permissions. The channel switch was stopped.");
          const prior = existing.get(row[key]);
          if (prior && identity.every((field) => prior[field] === row[field])) {
            const original = JSON.parse(prior.scopes);
            if (!validScopes(original)) throw new Error("A retained device has invalid permissions.");
            const projected = projectScopes(original, request.targetScopes, request.fromScopes);
            // Restore only this identical credential's previously granted
            // target permissions after a round trip through an older release.
            // Source revocations/expiry still win; changed grants never expand.
            if (projected.length === scopes.length && projected.every((scope) => scopes.includes(scope))) { scopes = original; restoredGrant = true; }
          }
          let compatible = scopes.filter((scope) => request.targetScopes.includes(scope));
          if (!restoredGrant) {
            compatible = projectScopes(scopes, request.fromScopes, request.targetScopes);
            // Native signed credentials authorize their immutable claims, not
            // edited SQLite grants. If an older release can decode every claim
            // but would broaden a parent permission, refuse the switch.
            if (!row.revoked_at && scopes.every((scope) => request.targetScopes.includes(scope)) && compatible.length !== scopes.length) {
              throw new Error("A restricted device credential would gain broader permissions in this release. Revoke it before switching channels.");
            }
          }
          row.scopes = JSON.stringify(compatible);
        }
        insert.run(...columns.map((name) => row[name]));
      }
    }
    target.exec("COMMIT");
  } catch (error) { target.exec("ROLLBACK"); throw error; }
  finally { source.close(); target.close(); }
}

/** Bound nightly disk use, keeping the active and previous release plus each
 * channel's latest cached target. Never touch staging or unrecognized trees. */
export async function pruneRuntimes(paths, request) {
  const releases = await readJson(paths.releases);
  const keep = new Set([request.version, request.previous?.version, ...CHANNELS.map((channel) => releases?.channels?.[channel]?.version)]);
  for (const entry of await fs.readdir(paths.versions, { withFileTypes: true })) {
    if (!entry.isDirectory() || !exactVersion(entry.name)) continue;
    const dir = path.join(paths.versions, entry.name);
    const patches = await fs.readdir(path.join(dir, "patches"), { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    const recognized = (await readJson(path.join(dir, ".installed.json")))?.version === entry.name;
    let patched = false;
    for (const patch of patches) {
      if (!patch.isDirectory() || !validPatchRevision(patch.name)) continue;
      const target = path.join(dir, "patches", patch.name), installed = await readJson(path.join(target, ".installed.json"));
      if (installed?.version !== entry.name || installed.patchRevision !== patch.name) continue;
      patched = true;
      const retained = [request, request.previous, ...CHANNELS.map((channel) => releases?.channels?.[channel])].some((release) => release?.version === entry.name && release.patchRevision === patch.name);
      if (keep.has(entry.name) && !retained) await fs.rm(target, { recursive: true, force: true });
    }
    if (!keep.has(entry.name) && (recognized || patched)) await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function recoverUpdate(paths) {
  const pending = await readJson(paths.request);
  if (!pending) return;
  const request = validateRequest(pending);
  const selection = await readSelection(paths);
  if (selection.updateId === request.id && selection.version === request.version && selection.patchRevision === request.patchRevision) {
    await writeJson(paths.operation, { ...request, previous: undefined, phase: "succeeded", finishedAt: Date.now() });
  } else {
    if (selection.version !== request.previous.version || selection.channel !== request.previous.channel || selection.patchRevision !== request.previous.patchRevision) throw new Error("The pending upgrade does not match T3 Code's saved selection.");
    if (["starting", "restoring"].includes(request.phase)) {
      await writeJson(paths.request, { ...request, phase: "restoring" });
      await restoreDatabase(paths, request.id);
    }
    await writeJson(paths.operation, { ...request, previous: undefined, phase: "interrupted", error: "An interrupted upgrade was recovered. The previous T3 Code version and data were kept.", finishedAt: Date.now() });
  }
  await fs.rm(paths.request, { force: true });
  await fs.rm(paths.backup, { recursive: true, force: true });
}

export async function runSupervisor(args, { env = process.env, preparedTimeoutMs = 120_000, authenticationTimeoutMs = 120_000 } = {}) {
  const paths = runtimePaths(env);
  await fs.mkdir(paths.run, { recursive: true, mode: 0o700 });
  const pidFile = path.join(paths.run, "t3.pid");
  const restartFile = path.join(paths.run, "restart");
  await fs.rm(restartFile, { force: true });
  await fs.rm(path.join(paths.run, "hold"), { force: true });
  await recoverUpdate(paths);
  await writeJson(path.join(paths.run, "supervisor.json"), { pid: process.pid, protocol: 3 });
  let child = null;
  let launching = null;
  let stopping = false;
  const stop = () => { stopping = true; (child || launching)?.process.kill("SIGTERM"); };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);

  const launch = async (runtime, update = null) => {
    if (stopping) throw new Error("The container is stopping.");
    const bridge = env.T3_SETUP_BRIDGE || (await exists('/usr/local/share/t3-client/setup-bridge.js') ? '/usr/local/share/t3-client/setup-bridge.js' : null);
    await refreshSetupBridge(runtime, bridge);
    if (stopping) throw new Error("The container is stopping.");
    const process_ = spawn(runtime.binary, args, {
      env: { ...env,
        ...(env.T3_WORKSPACE && !env.T3CODE_PROJECTS_DIR?.trim() ? { T3CODE_PROJECTS_DIR: env.T3_WORKSPACE } : {}),
        T3_SERVICE_LAUNCHER_CONTEXT: JSON.stringify({ protocol: 3, childVersion: runtime.version, ...(update ? { update } : {}) }) },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    const done = new Promise((resolve) => {
      process_.once("error", (error) => resolve({ code: 1, error }));
      process_.once("exit", (code, signal) => resolve({ code: code ?? (signal === "SIGTERM" ? 143 : 1), signal }));
    });
    // Attach the readiness listener before spawn can report prepared.
    let timer;
    const prepared = update ? new Promise((resolve, reject) => {
      process_.on("message", (message) => {
        if (message?.type !== "prepared") return;
        clearTimeout(timer);
        if (message.updateId !== update.id) reject(new Error("The new version acknowledged a different upgrade."));
        else resolve();
      });
      done.then(({ error }) => reject(error || new Error("The new T3 Code version exited before startup completed.")));
      timer = setTimeout(() => reject(new Error("The new T3 Code version did not become ready in time.")), preparedTimeoutMs);
    }).finally(() => clearTimeout(timer)) : null;
    prepared?.catch(() => {}); // A failed spawn may reject before launch returns.
    // A foreground/container install must be changed through Setup, never by
    // the upstream systemd installer writing an unrelated service selection.
    process_.on("message", (message) => {
      if (message?.type === "request-update" && process_.connected) process_.send({ type: "update-rejected", reason: "Update this container's T3 Code from Setup → Environment." }, () => {});
    });
    const target = { process: process_, done, prepared };
    launching = target;
    try {
      await new Promise((resolve, reject) => { process_.once("spawn", resolve); process_.once("error", reject); });
      await fs.writeFile(pidFile, `${process_.pid}\n`, { mode: 0o600 });
      if (stopping) await terminate(target);
    } catch (error) {
      // A PID-file failure is still a live trial: stop it before callers may
      // restore SQLite. Never lose the child just because launch cannot finish.
      await terminate(target);
      throw error;
    } finally { launching = null; }
    return target;
  };
  const terminate = async (target) => {
    if (!target) return;
    target.process.kill("SIGTERM");
    const timer = setTimeout(() => target.process.kill("SIGKILL"), 5000);
    try { await target.done; } finally { clearTimeout(timer); }
  };
  const trial = async () => {
    let request = validateRequest(await readJson(paths.request));
    let committed = false;
    let snapshot = false;
    const phase = async (name) => {
      request = { ...request, phase: name };
      await writeJson(paths.request, request);
      await writeJson(paths.operation, { ...request, previous: undefined });
    };
    try {
      await phase("snapshot");
      await snapshotDatabase(paths, request.id);
      snapshot = true;
      await phase("starting");
      await syncAuthentication(paths, request);
      const runtime = await selectedRuntime(paths, { version: request.version, patchRevision: request.patchRevision });
      if (request.targetDatabase) {
        // DDL equality does not guarantee that the release can decode its
        // scopes or client metadata. Its own CLI validates both copied tables
        // before a trial is allowed to activate. The first command may also
        // import the complete legacy history into the release's new database.
        for (const kind of ["session", "pairing"]) {
          try { await promisify(execFile)(runtime.binary, ["auth", kind, "list", "--json"], { env, timeout: authenticationTimeoutMs, maxBuffer: 8 * 1024 * 1024 }); }
          catch (error) {
            if (error.killed && error.code === null && error.signal === "SIGTERM") {
              throw new Error(`Preparing this release's database and validating device access timed out after ${Math.ceil(authenticationTimeoutMs / 1000)} seconds. The channel switch was stopped.`);
            }
            throw new Error("This release cannot read the paired devices or pairing links safely. The channel switch was stopped.");
          }
        }
      }
      child = await launch(runtime, { id: request.id, fromVersion: request.fromVersion, targetVersion: request.version, dbPath: path.join(paths.home, "userdata", request.targetDatabase || "statev2.sqlite"), status: "pending" });
      await child.prepared;
      if (stopping) return;
      await writeJson(paths.selection, { schema: 1, channel: request.channel, version: request.version, ...(request.patchRevision ? { patchRevision: request.patchRevision } : {}), updateId: request.id });
      committed = true;
      await new Promise((resolve, reject) => child.process.send({ type: "committed", updateId: request.id }, (error) => error ? reject(error) : resolve()));
      await fs.rm(paths.backup, { recursive: true, force: true });
      await pruneRuntimes(paths, request).catch((error) => console.error(`[t3code] could not trim cached releases: ${error.message}`));
      await writeJson(paths.operation, { ...request, previous: undefined, phase: "succeeded", finishedAt: Date.now() });
      // Keep the request as the cross-process mutex until every cleanup and
      // terminal write finishes. A second operator cannot overwrite it early.
      await fs.rm(paths.request, { force: true });
      console.error(`[t3code] upgraded to ${request.version} (${request.channel})`);
    } catch (error) {
      if (stopping) return;
      if (committed) throw error; // After activation, ordinary container crash policy applies.
      await terminate(child);
      child = null;
      if (snapshot) { await phase("restoring"); await restoreDatabase(paths, request.id); }
      await fs.rm(paths.request, { force: true });
      await fs.rm(paths.backup, { recursive: true, force: true });
      await writeJson(paths.operation, { ...request, previous: undefined, phase: "rolled-back", error: `${error.message} The previous version and database were restored.`, finishedAt: Date.now() });
      console.error(`[t3code] upgrade rolled back: ${error.message}`);
    }
  };
  try {
    while (!stopping) {
      child ??= await launch(await selectedRuntime(paths));
      const result = await child.done;
      child = null;
      if (stopping) return result.code;
      if (!await exists(restartFile)) return result.code;
      await fs.rm(restartFile, { force: true });
      await waitForFilesHold(path.join(paths.run,"hold"),{stopping:()=>stopping});
      if(stopping)return 143;
      if (await readJson(paths.request)) await trial();
      else console.error("[t3code] restarting T3 Code, as asked on the setup page");
    }
    return 143;
  } finally {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.off(signal, stop);
    await terminate(child);
    await fs.rm(pidFile, { force: true });
    await fs.rm(path.join(paths.run, "supervisor.json"), { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSupervisor(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(`[t3code] ${error.message}`); process.exitCode = 1; });
}
