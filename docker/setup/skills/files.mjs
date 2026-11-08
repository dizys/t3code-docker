// Explicit local file operations. Native settings and package installations are separate.
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";

const writableProviders = new Set(["claude", "codex", "opencode", "cursor", "grok", "muse", "antigravity", "pi"]);
const fail = (code, message) => Object.assign(new Error(message), { code });
const inside = (parent, file) => { const relative = path.relative(parent, file); return relative !== "" && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative); };
const stamp = (stat) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs].join(":");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const queues = new Map();
export async function serialized(key, work) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(work); queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
export const skillRevision = (row, file) => digest([row.path, row.resolvedPath, file.mode, file.stamp, file.content].join("\0"));

async function packageNames(io, home, env) {
  const lock = env.XDG_STATE_HOME ? path.join(path.resolve(home, env.XDG_STATE_HOME), "skills/.skill-lock.json") : path.join(home, ".agents/.skill-lock.json");
  let handle;
  try {
    const initial = await io.stat(lock);
    if (!initial.isFile() || initial.size > 65536) return null;
    handle = await io.open(await io.realpath(lock), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > 65536) return null;
    const buffer = Buffer.alloc(65537); let bytes = 0;
    while (bytes < buffer.length) { const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes); if (!read.bytesRead) break; bytes += read.bytesRead; }
    if (bytes > 65536) return null;
    const value = JSON.parse(buffer.toString("utf8", 0, bytes));
    if (!value.skills || typeof value.skills !== "object" || Array.isArray(value.skills)) return null;
    return new Map(Object.entries(value.skills).map(([name, entry]) => [name,
      typeof entry?.source === "string" && /^[\w.-]+\/[\w.-]+$/.test(entry.source) ? entry.source : null]));
  } catch (error) { return error.code === "ENOENT" ? new Map() : null; }
  finally { await handle?.close(); }
}

export async function localSkillPolicy({ provider, roots, home, env, io }) {
  const root = roots[0], packages = await packageNames(io, home, env);
  const sharedRoot = roots.find((entry) => entry.source === "Shared .agents");
  const editableRoots = [root, ...(sharedRoot ? [sharedRoot] : [])];
  const pluginRoots = await Promise.all([
    path.join(path.resolve(home, env.CLAUDE_CONFIG_DIR || ".claude"), "plugins"),
    path.join(path.resolve(home, env.CODEX_HOME || ".codex"), "plugins"),
    path.join(path.resolve(home, env.GROK_HOME || ".grok"), "plugins"),
    path.join(home, ".gemini/antigravity-cli/plugins"),
    "/etc/codex/skills",
  ].map((file) => io.realpath(file).catch(() => path.resolve(file))));
  const supported = writableProviders.has(provider);
  const protectedTarget = (file) => file.split(path.sep).includes(".system") || pluginRoots.some((directory) => file === directory || inside(directory, file));
  const creationTargets = [];
  for (const entry of editableRoots) {
    const resolved = await io.realpath(entry.path).catch((error) => error.code === "ENOENT" ? entry.path : null);
    if (supported && packages !== null && resolved && !protectedTarget(resolved)) creationTargets.push({
      id: entry === root ? "provider" : "shared", name: entry === root ? "Provider folder" : "Shared .agents folder", path: entry.path,
    });
  }
  const rootFor = (row) => editableRoots.filter((entry) => inside(entry.path, row.path)).sort((a, b) => b.path.length - a.path.length)[0];
  const capabilities = (row) => {
    let reason = null;
    if (!supported) reason = "Local file management is unavailable for this provider.";
    else if (row.scope !== "user" || row.source === "Plugin" || !rootFor(row)) reason = "Manage this installation through its source provider or package manager.";
    else if (!row.resolvedPath) reason = "The skill's linked target is unavailable.";
    else if (protectedTarget(row.resolvedPath)) reason = "System and plugin skill files are read-only.";
    else if (!packages) reason = "The skills package lock could not be checked; local changes are unavailable.";
    else if (packages.has(row.name) || packages.has(path.basename(path.dirname(row.path)))) reason = "This skill is tracked by the skills package manager.";
    const packageName = [row.name, path.basename(path.dirname(row.path))].find(name => packages?.has(name));
    return { canEdit: !reason && !row.error, canRemove: !reason && !row.error, readOnlyReason: reason || row.error || null,
      packageManaged: Boolean(packageName), packageSource: packageName ? packages.get(packageName) : null };
  };
  return { root, rootFor, creationTargets, canCreate: creationTargets.length > 0, capabilities };
}

function validate(content, metadata, slug) {
  if (typeof content !== "string" || !content.trim()) throw fail("invalid", "Skill Markdown is empty.");
  if (Buffer.byteLength(content) > 65536) throw fail("too_large", "Skill Markdown exceeds the 64 KiB limit.");
  const parsed = metadata(content, slug || "skill");
  if (parsed.metadataError) throw fail("invalid", parsed.metadataError);
  if (slug && parsed.name !== slug) throw fail("invalid", "The frontmatter name must match the folder name.");
}

async function publish(io, file, content, mode, exclusive = false) {
  const temp = path.join(path.dirname(file), ".t3-skill-write-" + randomBytes(12).toString("hex"));
  let handle, created = false;
  try {
    handle = await io.open(temp, "wx", mode); created = true;
    await handle.writeFile(content, "utf8"); await handle.chmod(mode); await handle.close(); handle = null;
    if (exclusive) await io.link(temp, file);
    else await io.rename(temp, file);
  } finally { await handle?.close(); if (created) await io.rm(temp, { force: true }); }
}

// Fingerprint supporting files without following their links or reading their bodies.
export async function removalPlan(io, row, root) {
  const parent = path.dirname(row.path);
  const fileEntry = await io.lstat(row.path), parentEntry = await io.lstat(parent);
  const kind = fileEntry.isSymbolicLink() || parent === root.path || path.basename(row.path) !== "SKILL.md" ? "file"
    : parentEntry.isSymbolicLink() ? "link" : "directory";
  const entry = kind === "file" ? row.path : parent;
  const actual = path.join(await io.realpath(path.dirname(entry)), path.basename(entry));
  const parts = [], fileList = [];
  let count = 0;
  const walk = async (file, relative, depth) => {
    if (++count > 1024 || depth > 12) throw fail("unsupported", "This skill contains too many files to remove through the console.");
    const stat = await io.lstat(file);
    // Moving the root changes its ctime; descendant ctimes stay stable and
    // catch in-place edits even when another tool restores the old mtime.
    parts.push([relative, stamp(stat) + (relative ? ":" + stat.ctimeMs : ""), stat.isSymbolicLink() ? await io.readlink(file) : ""]);
    if (!stat.isDirectory()) fileList.push({ name: relative || path.basename(row.path), bytes: stat.size,
      executable: stat.isFile() && Boolean(stat.mode & 0o111), linked: stat.isSymbolicLink() });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for await (const child of await io.opendir(file)) {
      if (child.name === "SKILL.md" && relative !== "") throw fail("unsupported", "This folder contains another skill. Remove it directly to preserve the nested installation.");
      await walk(path.join(file, child.name), path.join(relative, child.name), depth + 1);
    }
  };
  await walk(actual, "", 0);
  parts.sort((a, b) => a[0].localeCompare(b[0]));
  fileList.sort((a, b) => a.name.localeCompare(b.name));
  return { kind, linked: kind === "link" || fileEntry.isSymbolicLink(), path: entry, actual, revision: digest(JSON.stringify(parts)), files: count, fileList };
}

export function createSkillFileManager({ home, env, io, rootsFor, metadata, read, invalidate }) {
  const policyFor = (provider) => localSkillPolicy({ provider, roots: rootsFor(provider), home, env, io });
  const current = async (provider, id, revision) => {
    const row = await read(provider, id);
    const policy = await policyFor(provider), caps = policy.capabilities(row);
    if (!caps.canEdit) throw fail("unsupported", caps.readOnlyReason);
    if (!revision || row.revision !== revision) throw fail("conflict", "This skill changed since you opened it. Download your draft and reopen the file.");
    return { row, policy };
  };
  const create = async (provider, slug, content, target = "provider") => {
    if (!["provider", "shared"].includes(target)) throw fail("invalid", "Unknown skill destination.");
    if (typeof slug !== "string" || slug.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw fail("invalid", "Use a folder name of 1–64 lowercase letters, numbers and single hyphens.");
    validate(content, metadata, slug);
    const policy = await policyFor(provider);
    const destination = policy.creationTargets.find((entry) => entry.id === target);
    if (!destination) throw fail("unsupported", "This skill destination is not writable for the selected provider.");
    await io.mkdir(destination.path, { recursive: true });
    const root = await io.realpath(destination.path);
    const caps = policy.capabilities({ path: path.join(destination.path, slug, "SKILL.md"), resolvedPath: path.join(root, slug, "SKILL.md"), name: slug, scope: "user", source: "Provider" });
    if (!caps.canEdit) throw fail("unsupported", caps.readOnlyReason);
    return serialized(path.join(root, slug), async () => {
      const directory = path.join(root, slug);
      try { await io.mkdir(directory); }
      catch (error) { if (error.code === "EEXIST") throw fail("conflict", "A skill with that folder name already exists. Edit it or choose another name."); throw error; }
      try { await publish(io, path.join(directory, "SKILL.md"), content, 0o600, true); }
      catch (error) { await io.rmdir(directory).catch(() => {}); throw error; }
      invalidate(); return { ok: true, path: path.join(destination.path, slug, "SKILL.md") };
    });
  };
  const save = async (provider, id, revision, content) => {
    validate(content, metadata);
    const initial = await current(provider, id, revision);
    return serialized(initial.row.resolvedPath, async () => {
      const { row } = await current(provider, id, revision);
      // The resolved file is replaced; directory and file symlink chains stay intact.
      await publish(io, row.resolvedPath, content, row.mode);
      invalidate(); return { ok: true, path: row.path };
    });
  };
  const removal = async (provider, row) => {
    const policy = await policyFor(provider);
    const removable = policy.capabilities(row).canRemove;
    try {
      // Read-only installations get bounded metadata too. Resolve only the
      // already-approved Markdown location; never follow supporting-file links.
      const inspected = removable ? row : { ...row, path: row.resolvedPath };
      const root = removable ? policy.rootFor(row) : { path: path.dirname(path.dirname(inspected.path)) };
      const plan = await removalPlan(io, inspected, root);
      // Unlinking an installation only fingerprints its link. The inspector
      // still describes the approved target's files, without following any
      // links inside that folder or broadening removal authority.
      let metadata = plan;
      if (removable && plan.kind !== "directory" && row.path !== row.resolvedPath) {
        try { metadata = await removalPlan(io, { ...row, path: row.resolvedPath }, { path: path.dirname(path.dirname(row.resolvedPath)) }); }
        catch (error) { metadata = { fileList: null, error: error.message }; }
      }
      const files = metadata.fileList ? { files: metadata.fileList, fileCount: metadata.fileList.length } : { filesError: metadata.error };
      return removable ? { ...files, removalRevision: plan.revision, removalPath: plan.path, removalKind: plan.kind, removalFiles: plan.files, removalLinkedTarget: plan.linked } : files;
    } catch (error) { return { canRemove: false, removalError: removable ? error.message : null, filesError: error.message }; }
  };
  const remove = async (provider, id, revision, removalRevision) => {
    const initial = await current(provider, id, revision);
    return serialized(initial.row.resolvedPath, async () => {
      const { row, policy } = await current(provider, id, revision);
      const plan = await removalPlan(io, row, policy.rootFor(row));
      if (!removalRevision || removalRevision !== plan.revision) throw fail("conflict", "This skill or its supporting files changed. Reopen the skill before removing it.");
      const parked = path.join(path.dirname(plan.actual), ".t3-skill-remove-" + randomBytes(12).toString("hex"));
      await io.rename(plan.actual, parked);
      try {
        // Verify the moved entry too; a concurrent writer must not lose new files.
        const moved = { ...row, path: plan.kind === "directory" || plan.kind === "link" ? path.join(parked, "SKILL.md") : parked };
        let same;
        if (plan.kind === "file") {
          const stat = await io.lstat(parked);
          const parts = [["", stamp(stat), stat.isSymbolicLink() ? await io.readlink(parked) : ""]];
          same = digest(JSON.stringify(parts)) === plan.revision;
        } else same = (await removalPlan(io, moved, policy.rootFor(row))).revision === plan.revision;
        if (!same) throw fail("conflict", "This skill changed while it was being removed.");
      } catch (error) {
        const occupied = await io.lstat(plan.actual).then(() => true, (check) => check.code !== "ENOENT");
        if (!occupied) await io.rename(parked, plan.actual);
        else throw fail("conflict", "The installation changed. Its preserved entry is at " + parked);
        invalidate(); throw error;
      }
      try { await io.rm(parked, { recursive: plan.kind === "directory" }); }
      catch { invalidate(); throw fail("unavailable", "Removal could not complete. Remaining files are preserved at " + parked); }
      invalidate(); return { ok: true, removed: plan.path, keptLinkedTarget: plan.kind === "link" || (await io.lstat(row.resolvedPath).then(() => true, () => false)) };
    });
  };
  return { create, save, remove, removal, policyFor };
}
