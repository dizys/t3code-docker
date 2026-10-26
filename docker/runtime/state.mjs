// Container-owned T3 selection. Upstream's service runtime uses a different
// directory; a project, npm global install or mise shim never selects T3 here.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const CHANNELS = ["stable", "nightly"];
export const exactVersion = (value) => typeof value === "string" && /^\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/.test(value);
export const channelOf = (version) => version?.includes("-nightly.") ? "nightly" : "stable";
export const databaseName = (value) => typeof value === "string" && /^state(?:v[1-9]\d*)?\.sqlite$/.test(value);
export const validScopes = (value) => Array.isArray(value) && value.length <= 64 && value.every((scope) => typeof scope === "string" && /^[a-z][a-z-]*:[a-z][a-z-]*$/.test(scope));
export const validPatchRevision = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const releaseDirectory = (paths, { version, patchRevision }) => {
  if (!exactVersion(version) || (patchRevision !== undefined && !validPatchRevision(patchRevision))) throw new Error("Invalid runtime release or integration patch.");
  return patchRevision ? path.join(paths.versions, version, "patches", patchRevision) : path.join(paths.versions, version);
};
export const runtimePaths = (env = process.env) => {
  const home = env.T3CODE_HOME || `${env.HOME || "/home/t3"}/.t3`;
  const root = path.join(home, "container-runtime");
  return { home, root, selection: path.join(root, "selection.json"), operation: path.join(root, "operation.json"), request: path.join(root, "request.json"),
    versions: path.join(root, "versions"), releases: path.join(root, "releases.json"), backup: path.join(root, "database-backup"),
    binary: env.T3_INFRA_BINARY || "/opt/t3/t3", run: env.T3_RUN_DIR || "/tmp/t3code" };
};

export async function readJson(file, missing = null) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return missing; throw error; }
}

/** Replace durably. Recovery must never boot from a half-written selection. */
export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tmp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(tmp, file);
    const directory = await fs.open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(tmp, { force: true }); }
}

export async function readSelection(paths) {
  const value = await readJson(paths.selection, { schema: 1, channel: "stable", version: null });
  if (value.schema !== 1 || !CHANNELS.includes(value.channel) || (value.version !== null && !exactVersion(value.version)) || (value.patchRevision !== undefined && !validPatchRevision(value.patchRevision))) {
    throw new Error("T3 Code's saved selection is invalid; refusing to guess which version to run.");
  }
  return value;
}

export async function selectedRuntime(paths, selection = null) {
  selection ??= await readSelection(paths);
  if (!selection.version) {
    const manifest = await readJson(path.join(path.dirname(paths.binary), "package.json"));
    return { binary: paths.binary, version: manifest?.version, patchRevision: manifest?.containerPatch?.revision ?? null, bundled: true };
  }
  const dir = releaseDirectory(paths, selection);
  const installed = await readJson(path.join(dir, ".installed.json"));
  if (installed?.version !== selection.version) throw new Error(`T3 Code ${selection.version} is missing or incomplete.`);
  if (selection.patchRevision && installed.patchRevision !== selection.patchRevision) throw new Error("The selected T3 Code integration patch is missing or incomplete.");
  await fs.access(path.join(dir, "t3"), 1);
  if (installed.database !== undefined && !databaseName(installed.database)) throw new Error("The selected runtime has an invalid data path.");
  if (installed.scopes !== undefined && !validScopes(installed.scopes)) throw new Error("The selected runtime has invalid authentication capabilities.");
  return { binary: path.join(dir, "t3"), version: selection.version, patchRevision: installed.patchRevision ?? null, database: installed.database ?? null, scopes: installed.scopes ?? null, bundled: false };
}

export const operationBusy = (op) => Boolean(op && !["succeeded", "failed", "rolled-back", "interrupted"].includes(op.phase));
export const databaseBusy = (op) => Boolean(op && ["stopping", "snapshot", "starting", "restoring"].includes(op.phase));
