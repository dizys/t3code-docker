// Only context resources cross into T3 profiles. Authentication, hooks and
// native settings remain private to each Antigravity instance.
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

const pending = new Map<string, Promise<void>>();
export async function linkAntigravityUserResources(profile: string, userHome: string) {
  const key = path.resolve(profile), previous = pending.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => syncUserResources(key, userHome));
  pending.set(key, next);
  try { await next; } finally { if (pending.get(key) === next) pending.delete(key); }
}
const conflict = (file: string) => new Error(`Antigravity has private settings at ${file}. Move or merge that file before using global resources in this T3 profile.`);
async function syncUserResources(profile: string, userHome: string) {
  const origin = path.join(userHome, ".gemini");
  for (const relative of ["AGENTS.md", "GEMINI.md", "config/AGENTS.md", "config/GEMINI.md", "config/rules"]) {
    const target = path.join(origin, relative), link = path.join(profile, relative);
    if (target === link) continue;
    const source = await fs.stat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
    const existing = await fs.lstat(link).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
    if (existing?.isSymbolicLink()) {
      const current = path.resolve(path.dirname(link), await fs.readlink(link));
      // Preserve foreign links. Only this bridge's exact target is ours.
      if (current !== target) { if (source) throw conflict(link); continue; }
      if (source) continue;
      await fs.unlink(link);
    } else if (existing) {
      // Empty native placeholders may be removed; never replace user content.
      if (!source) continue;
      if (!existing.isDirectory() || !source.isDirectory()) throw conflict(link);
      try { await fs.rmdir(link); } catch (error) {
        if (["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code || "")) throw conflict(link);
        throw error;
      }
    }
    if (!source) continue;
    await fs.mkdir(path.dirname(link), { recursive: true });
    try { await fs.symlink(target, link, source.isDirectory() ? "dir" : "file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw conflict(link); throw error; }
  }
  await syncAntigravityUserMcp(profile, userHome);
}

const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
async function syncAntigravityUserMcp(profile: string, userHome: string) {
  const source = path.join(userHome, ".gemini/config/mcp_config.json"), file = path.join(profile, "config/mcp_config.json");
  if (source === file) return;
  const stat = await fs.stat(source).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
  const existing = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
  let owned: string | null = null, priorLink: string | null = null;
  if (existing) {
    // A content-addressed snapshot identifies bridge ownership without a
    // separate marker that could go stale after an interrupted write.
    if (existing.isSymbolicLink()) {
      priorLink = await fs.readlink(file);
      const match = /^\.t3-user-mcp-([a-f0-9]{64})\.json$/.exec(priorLink);
      if (match) {
        const snapshot = path.join(path.dirname(file), priorLink);
        const info = await fs.lstat(snapshot).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
        if (info?.isFile() && info.size <= 1024 * 1024 && fingerprint(await fs.readFile(snapshot, "utf8")) === match[1]) owned = snapshot;
      }
    }
    if (!owned) { if (stat) throw conflict(file); return; }
  }
  const unchanged = async () => {
    const current = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
    if (!existing) { if (current) throw conflict(file); return; }
    if (!current?.isSymbolicLink() || current.ino !== existing.ino || current.dev !== existing.dev || await fs.readlink(file) !== priorLink) throw conflict(file);
    if (owned && fingerprint(await fs.readFile(owned, "utf8")) !== path.basename(owned).slice(13, -5)) throw conflict(file);
  };
  if (!stat) {
    await unchanged();
    if (owned) { await fs.unlink(file); await fs.unlink(owned); }
    return;
  }
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Antigravity MCP configuration must be a regular file within 1 MiB.");
  const handle = await fs.open(source, "r");
  let text: string;
  try {
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > 1024 * 1024) throw new Error("Antigravity MCP configuration exceeds 1 MiB.");
    text = buffer.toString("utf8", 0, bytes);
  } finally { await handle.close(); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Antigravity global MCP configuration is invalid JSON."); }
  if (!object(value)) throw new Error("Antigravity global MCP configuration must be an object.");
  const entries = value.mcpServers ?? value;
  if (!object(entries)) throw new Error("Antigravity mcpServers must be an object.");
  if (Object.values(entries).some(entry => !object(entry))) throw new Error("Antigravity MCP server entries must be objects.");
  const servers = Object.fromEntries(Object.entries(entries).filter(([, entry]) => (entry as Record<string, unknown>).disabled !== true).map(([name, entry]) => {
    const native = entry as Record<string, unknown>;
    // Older ACP releases only recognize url and do not implement disabled.
    return [name, { ...native, ...(typeof native.serverUrl === "string" ? { url: native.serverUrl } : {}) }];
  }));
  const next = JSON.stringify({ mcpServers: servers }, null, 2) + "\n";
  await fs.mkdir(path.dirname(file), { recursive: true });
  const snapshot = path.join(path.dirname(file), `.t3-user-mcp-${fingerprint(next)}.json`);
  if (owned === snapshot) return;
  let created = false;
  try { await fs.writeFile(snapshot, next, { mode: 0o600, flag: "wx" }); created = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await fs.lstat(snapshot);
    if (!info.isFile() || info.size > 1024 * 1024 || await fs.readFile(snapshot, "utf8") !== next) throw conflict(snapshot);
  }
  const temporary = file + ".tmp." + randomBytes(8).toString("hex");
  let published = false;
  try {
    await fs.symlink(path.basename(snapshot), temporary);
    await unchanged();
    if (existing) await fs.rename(temporary, file);
    else await fs.link(temporary, file);
    published = true;
    if (owned) await fs.unlink(owned);
  } finally {
    await fs.rm(temporary, { force: true });
    if (created && !published) await fs.rm(snapshot, { force: true });
  }
}
