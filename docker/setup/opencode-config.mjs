// OpenCode 2 needs real config and discovery directories for its watcher.
// Keep migration here so the entrypoint and regression tests use the same code.
import path from "node:path";
import * as defaultFs from "node:fs/promises";
import { parseTree, createScanner, SyntaxKind, applyEdits } from "./vendor/jsonc.mjs";

const fail = (code, message) => Object.assign(new Error(message), { code });

export function opencodeConfigRoot(home = "/home/t3", env = {}) {
  const base = path.resolve(home);
  const trim = (value) => String(value ?? "").trim();
  const configHome = path.resolve(base, trim(env.XDG_CONFIG_HOME) || ".config");
  const root = path.resolve(base, trim(env.OPENCODE_CONFIG_DIR) || path.join(configHome, "opencode"));
  return root;
}

async function lstatOrNull(io, file) {
  try {
    return await io.lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function copyDirectory(io, source, destination, finalDestination = destination) {
  await io.cp(source, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  // Keep internal links inside the copied tree, and external relative links
  // pointing at their original targets after moving to a different parent.
  const visit = async (relative = "") => {
    for (const entry of await io.readdir(path.join(source, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name), file = path.join(destination, child);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isSymbolicLink()) {
        const link = await io.readlink(file);
        const target = path.resolve(path.dirname(path.join(source, child)), link);
        const inside = target === source || target.startsWith(source + path.sep);
        const mapped = inside ? path.join(finalDestination, path.relative(source, target)) : target;
        const next = path.isAbsolute(link) ? mapped : path.relative(path.dirname(path.join(finalDestination, child)), mapped) || ".";
        if (next !== link) { await io.unlink(file); await io.symlink(next, file); }
      }
    }
  };
  await visit();
}

// Stage a complete copy before removing a directory link. Its target is never
// removed. Copy all user files, including agents, plugins and instruction backups.
async function ensureRealDir(io, dir, sharedSkills = []) {
  const entry = await lstatOrNull(io, dir);
  if (!entry) {
    await io.mkdir(dir, { recursive: true });
    return "created";
  }
  if (entry.isDirectory()) return "exists";
  if (!entry.isSymbolicLink()) throw fail("not_directory", `OpenCode path is not a directory: ${dir}`);
  const link = await io.readlink(dir);
  const target = await io.realpath(dir).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const shared = await Promise.all(sharedSkills.map((file) => io.realpath(file).catch(() => path.resolve(file))));
  const stage = await io.mkdtemp(`${dir}.t3-migrate-`);
  try {
    // Shared skill folders already have native discovery. Do not duplicate
    // those installs; arbitrary skill links and every agent link keep contents.
    if (target && !shared.includes(target)) await copyDirectory(io, target, stage, dir);
    await io.unlink(dir);
    try { await io.rename(stage, dir); }
    catch (error) { await io.symlink(link, dir); throw error; }
  } finally {
    await io.rm(stage, { recursive: true, force: true });
  }
  return "replaced-symlink";
}

export async function ensureOpencodeLayout({ home = "/home/t3", env = {}, io = defaultFs, legacyRoot } = {}) {
  const root = opencodeConfigRoot(home, env);
  const fixed = [];
  const warnings = [];
  const rootAction = await ensureRealDir(io, root);
  if (rootAction !== "exists") fixed.push({ path: root, action: rootAction });
  // The entrypoint passes this only for an unmounted legacy home directory,
  // when the effective root is the default on the state volume. Host config
  // mounts and explicit config overrides never get moved here.
  let legacy = null;
  if (legacyRoot && path.resolve(legacyRoot) !== root) {
    const entry = await lstatOrNull(io, legacyRoot);
    if (entry) {
      const target = await io.realpath(legacyRoot).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (target === await io.realpath(root)) legacy = { entry, path: legacyRoot };
      else if (target) {
        if (root.startsWith(target + path.sep)) throw fail("invalid", "OpenCode config cannot be migrated into itself.");
        // Preserve the original directory as a backup until the container is
        // recreated. Never overwrite an earlier backup or remove mount contents.
        const backup = `${legacyRoot}.t3-migrated`;
        if (await lstatOrNull(io, backup)) throw fail("conflict", `OpenCode migration backup already exists: ${backup}`);
        await copyDirectory(io, target, root);
        legacy = { entry, path: legacyRoot, backup };
      }
    }
  }
  const sharedSkills = [path.join(home, ".agents/skills"), path.resolve(home, env.CLAUDE_CONFIG_DIR || ".claude", "skills")];
  for (const sub of ["skills", "agents", "skill", "agent"]) {
    const dir = path.join(root, sub);
    if (["skill", "agent"].includes(sub) && !(await lstatOrNull(io, dir))) continue;
    const action = await ensureRealDir(io, dir, sub === "skills" || sub === "skill" ? sharedSkills : []);
    if (action !== "exists") fixed.push({ path: dir, action });
  }
  if (legacy) {
    if (legacy.backup) await io.rename(legacy.path, legacy.backup);
    else if (legacy.entry.isSymbolicLink()) await io.unlink(legacy.path);
    fixed.push({ path: legacy.path, action: legacy.backup ? "migrated" : "removed-redundant-symlink" });
  }
  return { root, fixed, warnings };
}

// Only the legacy array is invalid in both supported majors. OpenCode 1 has a
// valid skills object (paths/urls); never remove it when saving unrelated MCPs.
export function stripLegacySkills(content) {
  const errors = [];
  const tree = parseTree(content, errors, { allowTrailingComma: true });
  if (errors.length || tree?.type !== "object") return content;
  const entries = (tree.children || []).filter((prop) => prop?.children?.[0]?.value === "skills");
  if (entries.length !== 1 || entries[0].children?.[1]?.type !== "array") return content;
  const property = entries[0];
  const edits = [{ offset: property.offset, length: property.length, content: "" }];
  // Remove the separator token, preserving surrounding comments/whitespace.
  // jsonc modify() also removes comments preceding a deleted property.
  const scanner = createScanner(content, true);
  scanner.setPosition(property.offset + property.length);
  if (scanner.scan() !== SyntaxKind.CommaToken) {
    const previous = tree.children[tree.children.indexOf(property) - 1];
    if (previous) scanner.setPosition(previous.offset + previous.length);
    else return applyEdits(content, edits);
    scanner.scan();
  }
  if (scanner.getToken() === SyntaxKind.CommaToken) edits.push({ offset: scanner.getTokenOffset(), length: 1, content: "" });
  return applyEdits(content, edits);
}

async function stripSkillsKey(io, file) {
  const entry = await lstatOrNull(io, file);
  if (!entry) return { fixed: false };
  let stat;
  try {
    stat = await io.stat(file);
  } catch {
    return { fixed: false };
  }
  if (!stat.isFile() || stat.size > 1024 * 1024) return { fixed: false };
  // Preserve file symlinks (parent stays real for inotify): write through to
  // the resolved target instead of replacing the symlink itself.
  const resolved = await io.realpath(file).catch(() => file);
  let content;
  try {
    content = await io.readFile(resolved, "utf8");
  } catch {
    return { fixed: false };
  }
  const next = stripLegacySkills(content);
  if (next === content) return { fixed: false, file };
  if (Buffer.byteLength(next, "utf8") > 1024 * 1024) throw fail("too_large", "Native settings would exceed the 1 MiB limit.");
  const mode = stat.mode & 0o777;
  const tmp = `${resolved}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  try {
    await io.writeFile(tmp, next, { encoding: "utf8", mode });
    try {
      await io.chmod(tmp, mode);
    } catch {}
    await io.rename(tmp, resolved);
  } finally {
    await io.rm(tmp, { force: true }).catch(() => {});
  }
  return { fixed: true, file };
}

export async function normalizeOpencodeConfig({ home = "/home/t3", env = {}, io = defaultFs } = {}) {
  const root = opencodeConfigRoot(home, env);
  const fixed = [];
  const warnings = [];
  for (const file of [path.join(root, "opencode.json"), path.join(root, "opencode.jsonc")]) {
    try {
      const result = await stripSkillsKey(io, file);
      if (result.fixed) fixed.push(file);
    } catch (error) {
      warnings.push(`Could not normalize ${file}: ${String(error?.message || error).slice(0, 160)}`);
    }
  }
  return { root, fixed, warnings };
}

export async function ensureOpencodeConfig({ home = "/home/t3", env = {}, io = defaultFs, legacyRoot } = {}) {
  const layout = await ensureOpencodeLayout({ home, env, io, legacyRoot });
  const normalized = await normalizeOpencodeConfig({ home, env, io });
  return { root: layout.root, fixedDirs: layout.fixed, dirWarnings: layout.warnings, fixedFiles: normalized.fixed, fileWarnings: normalized.warnings };
}

// CLI for docker/entrypoint.sh: `node opencode-config.mjs --fix --home /home/t3`
// Honors OPENCODE_CONFIG_DIR and XDG_CONFIG_HOME from the environment.
const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invoked) {
  const fix = process.argv.includes("--fix");
  const homeIndex = process.argv.indexOf("--home");
  const home = homeIndex >= 0 && process.argv[homeIndex + 1] ? process.argv[homeIndex + 1] : process.env.HOME || "/home/t3";
  const env = process.env;
  const legacyIndex = process.argv.indexOf("--legacy-root");
  const legacyRoot = legacyIndex >= 0 ? process.argv[legacyIndex + 1] : undefined;
  if (fix) {
    ensureOpencodeConfig({ home, env, legacyRoot })
      .then((result) => {
        const ok = !result.dirWarnings.length && !result.fileWarnings.length;
        console.log(JSON.stringify({ ok, ...result }));
        if (!ok) process.exitCode = 1;
      })
      .catch((error) => {
        console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }));
        process.exitCode = 1;
      });
  } else {
    console.log(opencodeConfigRoot(home, env));
  }
}
