// Import provenance travels atomically with the installed folder. Inventory never fetches sources.
import path from "node:path";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { parseSkillSource } from "./sources.mjs";

export const ORIGIN_FILE = ".t3-skill-source.json";
export const fingerprintEntries = entries => {
  const files = [...entries];
  files.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
};
export const skillFingerprint = skill => fingerprintEntries(skill.files.map(file => [file.name, Boolean(file.mode & 0o100), createHash("sha256").update(file.data).digest("hex")]));
export async function readSkillOrigin(io, row, home) {
  if (!row.resolvedPath || row.scope !== "user" || row.source === "Plugin" || path.basename(row.path) !== "SKILL.md") return null;
  let handle;
  try {
    // Refuse a retargeted skill before reading its adjacent metadata.
    if (await io.realpath(row.path) !== row.resolvedPath) return null;
    handle = await io.open(path.join(path.dirname(row.resolvedPath), ORIGIN_FILE), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8192) return null;
    const buffer = Buffer.alloc(8193), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) return null;
    const value = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    if (value.version !== 1 || typeof value.source !== "string" || typeof value.name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value.name) || value.name.length > 64 || !/^[a-f0-9]{64}$/.test(value.fingerprint)) return null;
    let parsed;
    try { parsed = parseSkillSource(value.source, home); }
    catch { return null; }
    if (!["git", "url"].includes(parsed.type)) return null;
    return { source: value.source, name: value.name, fingerprint: value.fingerprint,
      autoUpdate: value.autoUpdate === true, linkedAt: Number.isFinite(value.linkedAt) ? value.linkedAt : null,
      manual: value.manual === true };
  } catch { return null; }
  finally { await handle?.close(); }
}

// Fingerprint the current files on disk so a manual link can track future
// upstream changes without claiming to be up to date on day one. Excludes the
// provenance file itself; bounded like the update review.
export async function fingerprintInstalledDir(io, directory, { fileLimit = 4 * 1024 * 1024, totalLimit = 25 * 1024 * 1024, countLimit = 1024 } = {}) {
  const entries = [];
  let total = 0;
  const walk = async (dir, relative = "") => {
    const handle = await io.opendir(dir);
    for await (const entry of handle) {
      if (entry.name === ORIGIN_FILE && !relative) continue;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const rel = relative ? relative + "/" + entry.name : entry.name;
      if (entries.length >= countLimit) throw Object.assign(new Error("This skill has too many files to link for updates."), { code: "too_large" });
      let stat;
      try { stat = await io.lstat(full); }
      catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { await walk(full, rel); continue; }
      if (!stat.isFile()) continue;
      if (stat.size > fileLimit) throw Object.assign(new Error("A skill file exceeds the link limit."), { code: "too_large" });
      if (total + stat.size > totalLimit) throw Object.assign(new Error("This skill exceeds the link size limit."), { code: "too_large" });
      total += stat.size;
      const fileHandle = await io.open(full, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const buffer = Buffer.alloc(stat.size);
        let bytes = 0;
        while (bytes < buffer.length) {
          const read = await fileHandle.read(buffer, bytes, buffer.length - bytes, bytes);
          if (!read.bytesRead) break;
          bytes += read.bytesRead;
        }
        entries.push([rel, Boolean(stat.mode & 0o100), createHash("sha256").update(buffer.subarray(0, bytes)).digest("hex")]);
      } finally { await fileHandle.close(); }
    }
  };
  await walk(directory);
  return fingerprintEntries(entries);
}

export async function writeSkillOrigin(io, directory, { source, name, fingerprint, autoUpdate = true, manual = true, linkedAt = Date.now() }) {
  const payload = JSON.stringify({ version: 1, source, name, fingerprint, autoUpdate: autoUpdate === true, manual: manual === true, linkedAt }) + "\n";
  if (Buffer.byteLength(payload, "utf8") > 8192) throw Object.assign(new Error("The skill source record is too large."), { code: "invalid" });
  await io.writeFile(path.join(directory, ORIGIN_FILE), payload, { encoding: "utf8", mode: 0o600 });
}

export async function removeSkillOrigin(io, directory) {
  await io.rm(path.join(directory, ORIGIN_FILE), { force: true });
}
