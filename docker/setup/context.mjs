// Shared global instructions for the setup console. All filesystem operations
// take explicit paths so tests can use disposable homes. Provider-owned files
// and links are preserved; existing files change only on an explicit save.
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { agentResourcePaths } from "./agent-resources.mjs";

export function contextDirFor(baseDir) {
  return path.join(baseDir, "setup", "context");
}

export function agentsMdPathFor(baseDir) {
  return path.join(contextDirFor(baseDir), "AGENTS.md");
}

/** Cursor's dedicated rule workspace is loaded by the T3 SDK bridge. */
export function agentsMdTargets(env = {}, home = "/home/t3") {
  const roots = agentResourcePaths(home, env);
  return Object.entries({
    claude: "CLAUDE.md", codex: "AGENTS.md", opencode: "AGENTS.md",
    cursor: "t3-instructions/AGENTS.md", grok: "rules/t3-instructions.md",
    muse: "AGENTS.md", antigravity: "AGENTS.md", pi: "AGENTS.md",
  }).map(([provider, name]) => ({ provider, path: path.join(roots[provider], name) }));
}

// Pi and Codex choose one context file by precedence. Edit the file they
// actually load, preserving an existing override instead of shadowing it.
const instructionCandidates = target => {
  const names = target.provider === "pi" ? ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]
    : target.provider === "codex" ? ["AGENTS.override.md", "AGENTS.md"] : null;
  return names ? names.map(name => path.join(path.dirname(target.path), name)) : [target.path];
};
async function instructionEntry(fs, file) {
  try {
    const stat = await fs.lstat(file);
    return { file, stat, link: stat.isSymbolicLink() ? await fs.readlink(file) : null };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function instructionEntries(fs, target) {
  const rows = await Promise.all(instructionCandidates(target).map(async file => ({ file,
    entry: await instructionEntry(fs, file), backup: await instructionEntry(fs, file + ".t3-context-backup") })));
  const stamp = entry => entry && [entry.stat.dev, entry.stat.ino, entry.stat.mode, entry.stat.size, entry.stat.mtimeMs, entry.stat.ctimeMs, entry.link];
  return { rows, fingerprint: JSON.stringify(rows.map(row => [row.file, stamp(row.entry), stamp(row.backup)])) };
}
async function instructionTargets(fs, env = {}, home = "/home/t3") {
  return Promise.all(agentsMdTargets(env, home).map(async target => {
    try {
      const candidates = instructionCandidates(target);
      for (const file of candidates) {
        try { await fs.lstat(file); return { ...target, path: file }; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      // After disconnecting an override, its backup remembers the native path.
      for (const file of candidates) {
        if (await instructionEntry(fs, file + ".t3-context-backup")) return { ...target, path: file };
      }
      return target;
    } catch (error) { return { ...target, error: String(error?.message ?? error) }; }
  }));
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
    await fs.writeFile(tmp, text, { encoding: "utf8", mode, flag: "wx" });
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
const instructionModeWrites = new Map();
async function withInstructionWrite(file, work, queues = instructionWrites) {
  const key = path.resolve(file);
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  queues.set(key, current);
  try { return await current; }
  finally { if (queues.get(key) === current) queues.delete(key); }
}

// Link exclusively before removing an entry, including a relative symlink.
// Backups and restoration must never replace an occupied destination.
async function moveInstructionEntry(fs, source, destination) {
  const before = await fs.lstat(source);
  try { await fs.link(source, destination); }
  catch (error) {
    if (error.code === "EEXIST") throw Object.assign(new Error("The instruction destination already exists: " + destination + ". Refresh before trying again."), { code: "conflict" });
    throw error;
  }
  try {
    const current = await fs.lstat(source);
    if (current.ino !== before.ino || current.dev !== before.dev) throw new Error("The instruction entry changed before it could be moved.");
    await fs.unlink(source);
  } catch (error) {
    const created = await fs.lstat(destination).catch(() => null);
    if (created?.ino === before.ino && created.dev === before.dev) await fs.unlink(destination);
    throw error;
  }
}
async function moveInstructionEntries(fs, moves, temporary) {
  const completed = [];
  try {
    for (const move of moves) { await moveInstructionEntry(fs, ...move); completed.push(move); }
  } catch (error) {
    const failed = [];
    for (const [source, destination] of completed.reverse()) {
      try { await moveInstructionEntry(fs, destination, source); }
      catch { failed.push(destination); }
    }
    if (failed.length) throw new Error("Instruction changes could not be rolled back. Preserved files: " + failed.join(", ") + ". " + error.message);
    throw error;
  }
  for (const file of temporary) await fs.rm(file, { force: true });
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
    for (const target of await instructionTargets(fs, env, home)) {
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
  for (const target of await instructionTargets(fs, env, home)) {
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
  const target = (await instructionTargets(fs, env, home)).find((entry) => entry.provider === provider);
  if (!target) return { ok: false, code: "invalid", error: "Unknown instruction provider" };
  if (target.error) return { ok: false, ...target, code: "unavailable" };
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
  const target = (await instructionTargets(fs, options.env, options.home)).find((entry) => entry.provider === provider);
  if (!target) return { ok: false, code: "invalid", error: "Unknown instruction provider" };
  if (target.error) return { ok: false, ...target, mode: null };
  let entries;
  try { entries = await instructionEntries(fs, target); }
  catch (error) { return { ok: false, ...target, mode: null, error: String(error?.message ?? error) }; }
  const fallbackPaths = entries.rows.filter(row => row.entry && row.file !== target.path).map(row => row.file);
  let entry;
  try { entry = await fs.lstat(target.path); }
  catch (error) {
    if (error?.code === "ENOENT") return { ok: true, ...target, mode: null, fallbackPaths, sourceRevision: revisionFor(target.path, "missing\0" + entries.fingerprint), error: null };
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
    sourceRevision: revisionFor(target.path, link + "\0" + read.revision + "\0" + entries.fingerprint), fallbackPaths,
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
  const sourceLock = path.join(path.dirname(initial.path), ".t3-instruction-source");
  return withInstructionWrite(sourceLock, () => withInstructionWrite(initial.resolvedPath || initial.path, async () => {
    const state = await providerInstructionState(fs, baseDir, provider, options);
    if (!state.ok) return state;
    if (!sourceRevision || state.sourceRevision !== sourceRevision) return changedInstructions();
    if (state.mode === mode || (state.mode === null && mode === "none" && !state.error)) return { ok: true, provider, mode: mode === "none" ? null : mode };
    const shared = await readAgentsMd(fs, baseDir);
    if (shared.error) return { ok: false, error: shared.error };
    const backup = state.path + ".t3-context-backup";
    const temporary = state.path + ".tmp." + randomBytes(6).toString("hex");
    if (mode === "none") {
      const snapshot = await instructionEntries(fs, state), moves = [], cleanup = [];
      const sharedPath = await fs.realpath(shared.path).catch(() => path.resolve(shared.path));
      // Preflight every native fallback before moving anything. Otherwise
      // removing an override silently activates a lower-priority file.
      for (const row of snapshot.rows.filter(row => row.entry)) {
        await readInstructionFile(fs, row.file);
        const isShared = row.entry.stat.isSymbolicLink() && await fs.realpath(row.file) === sharedPath;
        if (!isShared && row.backup) return { ok: false, code: "conflict", error: "A previous instruction backup already exists: " + row.file + ".t3-context-backup" };
        const destination = row.file + (isShared ? ".tmp." + randomBytes(6).toString("hex") : ".t3-context-backup");
        moves.push([row.file, destination]);
        if (isShared) cleanup.push(destination);
      }
      if ((await providerInstructionState(fs, baseDir, provider, options)).sourceRevision !== sourceRevision) return changedInstructions();
      await moveInstructionEntries(fs, moves, cleanup);
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
          await moveInstructionEntry(fs, state.path, backup);
          backedUp = true;
        }
        try { await fs.link(temporary, state.path); }
        catch (error) {
          if (backedUp) await moveInstructionEntry(fs, backup, state.path);
          throw error;
        }
      } finally { await fs.rm(temporary, { force: true }); }
    } else {
      const snapshot = await instructionEntries(fs, state);
      const restore = snapshot.rows.filter(row => row.backup && (!row.entry || row.file === state.path));
      if (restore.length) {
        const moves = [], cleanup = [];
        if (state.mode === "shared") { moves.push([state.path, temporary]); cleanup.push(temporary); }
        for (const row of restore) moves.push([row.file + ".t3-context-backup", row.file]);
        await moveInstructionEntries(fs, moves, cleanup);
      } else {
        const content = shared.content || "# " + provider + " instructions\n";
        await writeFileAtomic(fs, state.path, content);
      }
    }
    return { ok: true, provider, mode };
  }), instructionModeWrites);
}

/** Return metadata only; instruction text stays server-side until the editor opens. */
export async function contextStatus(fs, { baseDir, home = "/home/t3", env = {} } = {}) {
  // Shared provider links resolve to the same file; read it once per poll.
  const snapshotFs = { ...fs, [instructionReads]: new Map() };
  const read = await readAgentsMd(snapshotFs, baseDir);
  const providers = [];
  for (const target of await instructionTargets(fs, env, home)) {
    const state = await providerInstructionState(snapshotFs, baseDir, target.provider, { home, env });
    providers.push({ ...target, mode: state.mode, fallbackPaths: state.fallbackPaths, sourceRevision: state.sourceRevision, bytes: state.bytes, modifiedAt: state.modifiedAt, error: state.error ?? null });
  }
  return { agentsMd: { present: read.present, path: read.path, bytes: read.bytes, revision: read.revision, modifiedAt: read.modifiedAt, error: read.error }, providers };
}
