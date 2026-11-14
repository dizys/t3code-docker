// Conflict tokens for native settings; settings contents never leave this module.
import path from "node:path";
import { createHash } from "node:crypto";
import { READ_FLAGS, readHandleCapped } from "../bounded-read.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const stamp = (stat) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
export const codexConfigPath = (home, env) => path.join(path.resolve(home, env.CODEX_HOME || ".codex"), "config.toml");

export async function configSnapshot(file, io, includeContent = false) {
  let handle;
  const limit = 1024 * 1024;
  const check = (stat) => {
    if (!stat.isFile() || stat.size > limit) throw new Error("Native settings are not a regular file within the 1 MiB limit.");
  };
  try {
    check(await io.stat(file));
    const resolved = await io.realpath(file);
    handle = await io.open(resolved, READ_FLAGS);
    const before = await handle.stat(); check(before);
    const { content, bytes, raw } = await readHandleCapped(handle, limit);
    if (bytes > limit || stamp(before) !== stamp(await handle.stat()) || stamp(before) !== stamp(await io.stat(file)) || resolved !== await io.realpath(file)) {
      throw Object.assign(new Error("Native settings changed while being read. Refresh the list."), { code: "conflict" });
    }
    const revision = digest(JSON.stringify([file, resolved, stamp(before), digest(raw)]));
    return includeContent ? { revision, content, resolvedPath: resolved, mode: before.mode & 0o777, exists: true } : revision;
  } catch (error) {
    if (error.code === "conflict") throw error;
    if (error.code === "ENOENT" && !handle) {
      // A dangling settings link must not be mistaken for an absent file.
      try { await io.lstat(file); } catch (missing) { if (missing.code === "ENOENT") {
        const revision = digest(file + "\0missing");
        return includeContent ? { revision, content: "{}\n", resolvedPath: file, mode: 0o600, exists: false } : revision;
      } }
    }
    throw new Error("Native settings could not be checked. " + (error.code ? "Refresh after checking file access." : error.message));
  } finally { await handle?.close(); }
}

export const stateRevision = (config, row) => digest(JSON.stringify([config, row.path, row.resolvedPath, row.scope, row.source, row.name, row.state, row.policyKey, row.nativePolicyVersion]));

// All skills share one provider settings file, including across service instances.
//
// Single-writer contract, same as the MCP store: the setup server is the only
// in-repo writer taking this queue, so it serializes its concurrent requests
// per settings file. The native writer itself (the provider CLI) and hand
// edits run outside it, which is why every toggle re-checks its revision
// inside the queue, re-checks immediately before the native write, and
// verifies the result afterwards instead of assuming the write won. No
// cross-process lock is taken: the harness lock guards mise state, not these
// files, and an advisory lock no external writer honors would only add
// blocking without adding safety.
const queues = new Map();
export async function serializeState(key, work) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(work); queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
