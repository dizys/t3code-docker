// Shared global instructions for the setup console. All filesystem operations
// take explicit paths so tests can use disposable homes. Provider-owned files
// and links are preserved; existing files change only on an explicit save.
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export function contextDirFor(baseDir) {
  return path.join(baseDir, "setup", "context");
}

export function agentsMdPathFor(baseDir) {
  return path.join(contextDirFor(baseDir), "AGENTS.md");
}

/** Native global instruction paths; other providers are deferred. */
export function agentsMdTargets(env = {}, home = "/home/t3") {
  const claudeDir = String(env.CLAUDE_CONFIG_DIR ?? "").trim() || path.join(home, ".claude");
  const codexHome = String(env.CODEX_HOME ?? "").trim() || path.join(home, ".codex");
  const configHome = String(env.XDG_CONFIG_HOME ?? "").trim() || path.join(home, ".config");
  // OpenCode reads its config dir through OPENCODE_CONFIG_DIR; the entrypoint
  // points it at a real folder on the state volume, so instructions belong
  // there rather than under a symlinked ~/.config/opencode.
  const openCodeHome = String(env.OPENCODE_CONFIG_DIR ?? "").trim() || path.join(configHome, "opencode");
  return [
    { provider: "claude", path: path.join(claudeDir, "CLAUDE.md") },
    { provider: "codex", path: path.join(codexHome, "AGENTS.md") },
    { provider: "opencode", path: path.join(openCodeHome, "AGENTS.md") },
  ];
}

const MAX_INSTRUCTION_BYTES = 64 * 1024;
const instructionReads = Symbol("instructionReads");
const tooLarge = (bytes) => Object.assign(new Error("Instructions are too large to edit (64 KiB maximum). Edit the file directly to reduce its size."), { code: "too_large", bytes });

export function validateAgentsMd(text, maxBytes = MAX_INSTRUCTION_BYTES) {
  const src = String(text ?? "");
  if (!src.trim()) return { ok: false, error: "AGENTS.md is empty" };
  if (Buffer.byteLength(src, "utf8") > maxBytes) {
    return { ok: false, error: `AGENTS.md exceeds ${maxBytes} bytes` };
  }
  return { ok: true, bytes: Buffer.byteLength(src, "utf8") };
}

async function readInstructionFile(fs, file) {
  const cache = fs[instructionReads];
  const key = path.resolve(file);
  if (cache?.has(key)) return cache.get(key);
  const read = (async () => {
    const check = (stat) => {
      if (!stat.isFile()) throw Object.assign(new Error("Instructions must be a regular file"), { code: "invalid" });
      if (stat.size > MAX_INSTRUCTION_BYTES) throw tooLarge(stat.size);
    };
    // Reject oversized targets before opening them, including through symlinks.
    check(await fs.stat(file));
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      check(stat);
      // A file may grow after stat. Read at most the limit plus one byte,
      // including across short reads, so status polling can never load it all.
      const buffer = Buffer.alloc(MAX_INSTRUCTION_BYTES + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
      }
      if (bytes > MAX_INSTRUCTION_BYTES) throw tooLarge(bytes);
      return { content: buffer.toString("utf8", 0, bytes), bytes, mode: stat.mode & 0o777, modifiedAt: stat.mtimeMs };
    } finally {
      await handle.close();
    }
  })();
  cache?.set(key, read);
  return read;
}

async function writeFileAtomic(fs, file, text, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tmp, text, { encoding: "utf8", mode });
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

const revisionFor = (file, content) => content === null ? null
  : createHash("sha256").update(path.resolve(file)).update("\0").update(content).digest("hex");
const changedInstructions = () => ({ ok: false, code: "conflict", error: "Instructions changed since you opened them. Download your draft, then reopen the editor to load the current file." });

// Shared and provider editors can point at the same file. Keep their revision
// checks and atomic writes in one queue per resolved target.
const instructionWrites = new Map();
async function withInstructionWrite(file, work) {
  const key = path.resolve(file);
  const previous = instructionWrites.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  instructionWrites.set(key, current);
  try { return await current; }
  finally { if (instructionWrites.get(key) === current) instructionWrites.delete(key); }
}

export async function readAgentsMd(fs, baseDir) {
  const file = agentsMdPathFor(baseDir);
  try {
    const { content, bytes, modifiedAt } = await readInstructionFile(fs, file);
    return { present: true, path: file, content, revision: revisionFor(file, content), bytes, modifiedAt, error: null };
  } catch (error) {
    return { present: error?.code === "too_large", path: file, content: null, revision: null,
      bytes: error?.bytes ?? 0, code: error?.code === "too_large" ? "too_large" : undefined,
      error: error?.code === "ENOENT" ? null : String(error?.message ?? error) };
  }
}

export async function writeAgentsMd(fs, baseDir, content, revision = null) {
  const v = validateAgentsMd(content);
  if (!v.ok) return { ok: false, error: v.error };
  const file = agentsMdPathFor(baseDir);
  return withInstructionWrite(file, async () => {
    const read = await readAgentsMd(fs, baseDir);
    if (read.error) return { ok: false, error: read.error };
    if (read.revision !== revision) return changedInstructions();
    try {
      if ((await fs.lstat(file)).isSymbolicLink()) return { ok: false, error: "Global AGENTS.md is a symlink; edit its target directly." };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await writeFileAtomic(fs, file, String(content));
    return { ok: true, path: file, created: !read.present, bytes: v.bytes, revision: revisionFor(file, String(content)) };
  });
}

/**
 * Delete the shared global file. Provider links pointing at it are unlinked
 * so they return to "no instructions" instead of dangling; their separate
 * backups are left for a later Separate. Blank saves stay rejected - removal
 * is explicit.
 */
export async function deleteAgentsMd(fs, baseDir, revision = null, { home = "/home/t3", env = {} } = {}) {
  const file = agentsMdPathFor(baseDir);
  return withInstructionWrite(file, async () => {
    const read = await readAgentsMd(fs, baseDir);
    if (read.error) return { ok: false, error: read.error };
    if (!read.present) return { ok: true, path: file, deleted: false };
    if (read.revision !== revision) return changedInstructions();
    try {
      if ((await fs.lstat(file)).isSymbolicLink()) return { ok: false, error: "Global AGENTS.md is a symlink; edit its target directly." };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const canonical = path.resolve(file);
    await fs.rm(file, { force: true });
    let unlinked = 0;
    for (const target of agentsMdTargets(env, home)) {
      try {
        const stat = await fs.lstat(target.path);
        if (!stat.isSymbolicLink()) continue;
        const resolved = path.resolve(path.dirname(target.path), await fs.readlink(target.path));
        if (resolved === canonical) {
          await fs.rm(target.path, { force: true });
          unlinked += 1;
        }
      } catch {
        // Missing or unreadable provider files need no cleanup.
      }
    }
    return { ok: true, path: file, deleted: true, unlinked };
  });
}

/** Link missing targets without replacing existing files or user symlinks. */
export async function reconcileAgentsMd(fs, baseDir, { home = "/home/t3", env = {}, only = null } = {}) {
  const canonical = agentsMdPathFor(baseDir);
  const read = await readAgentsMd(fs, baseDir);
  if (read.error || !read.present) return { ok: false, linked: [], skipped: [], error: read.error || "no global AGENTS.md yet" };
  const allowed = only ? new Set(only) : null;
  const linked = [];
  const skipped = [];
  for (const target of agentsMdTargets(env, home)) {
    if (allowed && !allowed.has(target.provider)) continue;
    try {
      try {
        const stat = await fs.lstat(target.path);
        if (stat.isSymbolicLink() && path.resolve(path.dirname(target.path), await fs.readlink(target.path)) === path.resolve(canonical)) {
          linked.push({ ...target, state: "exists" });
        } else {
          skipped.push({ ...target, reason: "Existing instructions left in place", preserved: true });
        }
        continue;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await fs.mkdir(path.dirname(target.path), { recursive: true });
      await fs.symlink(canonical, target.path);
      linked.push({ ...target, state: "linked" });
    } catch (error) {
      skipped.push({ ...target, reason: String(error?.message ?? error) });
    }
  }
  return { ok: true, linked, skipped, error: null };
}

/** Read a known provider's existing file, following its symlinks. */
export async function readProviderAgentsMd(fs, provider, { home = "/home/t3", env = {} } = {}) {
  const target = agentsMdTargets(env, home).find((entry) => entry.provider === provider);
  if (!target) return { ok: false, code: "invalid", error: "Unknown instruction provider" };
  let resolvedPath;
  try {
    resolvedPath = await fs.realpath(target.path);
    const { content, bytes, mode, modifiedAt } = await readInstructionFile(fs, resolvedPath);
    const revision = revisionFor(resolvedPath, content);
    return { ok: true, ...target, resolvedPath, content, revision, bytes, mode, modifiedAt };
  } catch (error) {
    if (error?.code === "too_large") return { ok: false, ...target, resolvedPath, content: null, revision: null, bytes: error.bytes, code: "too_large", error: error.message };
    return { ok: false, ...target, code: error?.code === "ENOENT" ? "missing" : error?.code === "invalid" ? "invalid" : "unavailable", error: error?.code === "ENOENT" ? "The instruction file or its linked target no longer exists" : String(error?.message ?? error) };
  }
}

export async function writeProviderAgentsMd(fs, provider, content, revision, options = {}) {
  const validation = validateAgentsMd(content);
  if (!validation.ok) return validation;
  const initial = await readProviderAgentsMd(fs, provider, options);
  if (!initial.ok) return initial;
  return withInstructionWrite(initial.resolvedPath, async () => {
    const read = await readProviderAgentsMd(fs, provider, options);
    if (!read.ok) return read;
    if (!revision || read.revision !== revision) {
      return changedInstructions();
    }
    // Rename the resolved file, leaving the provider's symlink chain intact.
    await writeFileAtomic(fs, read.resolvedPath, String(content), read.mode);
    return { ok: true, provider, path: read.path, bytes: validation.bytes };
  });
}

/** The native file itself records whether a provider uses shared or separate instructions. */
export async function providerInstructionState(fs, baseDir, provider, options = {}) {
  const target = agentsMdTargets(options.env, options.home).find((entry) => entry.provider === provider);
  if (!target) return { ok: false, code: "invalid", error: "Unknown instruction provider" };
  let entry;
  try { entry = await fs.lstat(target.path); }
  catch (error) {
    if (error?.code === "ENOENT") return { ok: true, ...target, mode: null, sourceRevision: revisionFor(target.path, "missing"), error: null };
    return { ok: false, ...target, error: String(error?.message ?? error) };
  }
  const read = await readProviderAgentsMd(fs, provider, options);
  if (!read.ok && read.code !== "too_large") return { ...read, mode: null };
  const sharedPath = await fs.realpath(agentsMdPathFor(baseDir)).catch(() => path.resolve(agentsMdPathFor(baseDir)));
  const mode = read.resolvedPath === sharedPath ? "shared" : "separate";
  if (!read.ok) return { ...read, mode, sourceRevision: null };
  const link = entry.isSymbolicLink() ? await fs.readlink(target.path) : "regular";
  return {
    ok: true, ...target, mode,
    sourceRevision: revisionFor(target.path, link + "\0" + read.revision),
    resolvedPath: read.resolvedPath, bytes: read.bytes, modifiedAt: read.modifiedAt, error: null,
  };
}

/** Explicit mode changes preserve the separate file next to its native path. */
export async function setProviderInstructionMode(fs, baseDir, provider, mode, sourceRevision, options = {}) {
  if (!["shared", "separate", "none"].includes(mode)) return { ok: false, code: "invalid", error: "Choose shared, separate or no instructions" };
  const initial = await providerInstructionState(fs, baseDir, provider, options);
  if (!initial.ok) return initial;
  // Clearing an already-absent provider is a no-op, but still checks the
  // revision so a stale selector cannot hide a file created elsewhere.
  return withInstructionWrite(initial.resolvedPath || initial.path, async () => {
    const state = await providerInstructionState(fs, baseDir, provider, options);
    if (!state.ok) return state;
    if (!sourceRevision || state.sourceRevision !== sourceRevision) return changedInstructions();
    if (state.mode === mode || (state.mode === null && mode === "none" && !state.error)) return { ok: true, provider, mode: mode === "none" ? null : mode };
    const shared = await readAgentsMd(fs, baseDir);
    if (shared.error) return { ok: false, error: shared.error };
    const backup = state.path + ".t3-context-backup";
    const temporary = state.path + ".tmp." + randomBytes(6).toString("hex");
    if (mode === "none") {
      // Remove the provider file so no instructions apply. A separate file is
      // kept in the backup slot so Separate can restore it later; a shared
      // link is simply unlinked and any existing backup is left for Separate.
      if (state.mode === "separate") {
        try {
          await fs.lstat(backup);
          return { ok: false, code: "conflict", error: "A previous instruction backup already exists: " + backup };
        } catch (error) { if (error?.code !== "ENOENT") throw error; }
        await fs.rename(state.path, backup);
      } else {
        await fs.rm(state.path, { force: true });
      }
      return { ok: true, provider, mode: null };
    }
    if (mode === "shared") {
      if (!shared.present) return { ok: false, error: "Save shared global instructions first" };
      let backedUp = false;
      try {
        await fs.mkdir(path.dirname(state.path), { recursive: true });
        // Stage the new link before moving anything owned by the user.
        await fs.symlink(path.resolve(shared.path), temporary);
        if (state.mode === "separate") {
          try {
            await fs.lstat(backup);
            return { ok: false, code: "conflict", error: "A previous instruction backup already exists: " + backup };
          } catch (error) { if (error?.code !== "ENOENT") throw error; }
          await fs.rename(state.path, backup);
          backedUp = true;
        }
        try { await fs.rename(temporary, state.path); }
        catch (error) {
          if (backedUp) await fs.rename(backup, state.path);
          throw error;
        }
      } finally { await fs.rm(temporary, { force: true }); }
    } else {
      let restore = false;
      try { await fs.lstat(backup); restore = true; }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (restore) {
        // Renaming restores even relative symlinks verbatim at their original location.
        await fs.rename(backup, state.path);
      } else {
        const content = shared.content || "# " + provider + " instructions\n";
        await writeFileAtomic(fs, state.path, content);
      }
    }
    return { ok: true, provider, mode };
  });
}

/** Return metadata only; instruction text stays server-side until the editor opens. */
export async function contextStatus(fs, { baseDir, home = "/home/t3", env = {} } = {}) {
  // Shared provider links resolve to the same file; read it once per poll.
  const snapshotFs = { ...fs, [instructionReads]: new Map() };
  const read = await readAgentsMd(snapshotFs, baseDir);
  const providers = [];
  for (const target of agentsMdTargets(env, home)) {
    const state = await providerInstructionState(snapshotFs, baseDir, target.provider, { home, env });
    providers.push({ ...target, mode: state.mode, sourceRevision: state.sourceRevision, bytes: state.bytes, modifiedAt: state.modifiedAt, error: state.error ?? null });
  }
  return { agentsMd: { present: read.present, path: read.path, bytes: read.bytes, revision: read.revision, modifiedAt: read.modifiedAt, error: read.error }, providers };
}
