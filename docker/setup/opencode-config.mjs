// OpenCode global config layout: real directories, not symlinked ones.
//
// OpenCode 2.x watches its config directory with inotify and classifies
// symlinked `skills`/`agents` directories as files (node backend), so global
// skills/agents stay invisible. The config directory itself fails with
// `inotify_add_watch ... Not a directory` when it is a symlink.
//
// This module is the testable source of truth for the entrypoint fix:
//   - resolve the config root honoring OPENCODE_CONFIG_DIR/XDG_CONFIG_HOME
//   - replace symlinked config/skills/agents dirs with real dirs
//   - strip the invalid top-level `skills` key from opencode.json[c]
//     (discovery is fixed paths only; valid filtering is permission.skill)
//
// Shared skills stay available through native discovery
// (~/.agents/skills, ~/.claude/skills) without symlinking the provider folder.
import path from "node:path";
import * as defaultFs from "node:fs/promises";
import { parseTree, modify, applyEdits } from "./vendor/jsonc.mjs";

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

async function ensureRealDir(io, dir) {
  const entry = await lstatOrNull(io, dir);
  if (!entry) {
    await io.mkdir(dir, { recursive: true });
    return "created";
  }
  if (entry.isSymbolicLink()) {
    await io.rm(dir, { force: true });
    await io.mkdir(dir, { recursive: true });
    return "replaced-symlink";
  }
  if (entry.isDirectory()) return "exists";
  return "not-a-directory";
}

export async function ensureOpencodeLayout({ home = "/home/t3", env = {}, io = defaultFs } = {}) {
  const root = opencodeConfigRoot(home, env);
  const fixed = [];
  const warnings = [];
  // Config root first: replacing a symlinked root must preserve config files
  // but must not copy symlinked skills/agents contents (shared discovery covers them).
  const rootEntry = await lstatOrNull(io, root);
  if (!rootEntry) {
    await io.mkdir(root, { recursive: true });
    fixed.push({ path: root, action: "created" });
  } else if (rootEntry.isSymbolicLink()) {
    let target = null;
    try {
      const link = await io.readlink(root);
      target = path.resolve(path.dirname(root), link);
    } catch {
      target = null;
    }
    await io.rm(root, { force: true });
    await io.mkdir(root, { recursive: true });
    fixed.push({ path: root, action: "replaced-symlink" });
    if (target) {
      for (const file of ["opencode.json", "opencode.jsonc"]) {
        try {
          const src = path.join(target, file);
          const dst = path.join(root, file);
          const srcStat = await io.lstat(src).catch(() => null);
          const dstStat = await io.lstat(dst).catch(() => null);
          if (srcStat?.isFile() && !dstStat) {
            const content = await io.readFile(src, "utf8");
            const mode = srcStat.mode & 0o777;
            await io.writeFile(dst, content, { mode });
            try {
              await io.chmod(dst, mode);
            } catch {}
          }
        } catch (error) {
          warnings.push(`Could not preserve ${file} from previous config location: ${String(error?.message || error).slice(0, 120)}`);
        }
      }
    }
  } else if (!rootEntry.isDirectory()) {
    warnings.push(`OpenCode config path is not a directory: ${root}`);
    return { root, fixed, warnings };
  }
  for (const sub of ["skills", "agents"]) {
    const dir = path.join(root, sub);
    const action = await ensureRealDir(io, dir);
    if (action === "created" || action === "replaced-symlink") fixed.push({ path: dir, action });
    else if (action === "not-a-directory") warnings.push(`OpenCode ${sub} path is not a directory: ${dir}`);
  }
  // Legacy singular names are also watched by OpenCode; a symlinked singular
  // entry would hit the same misclassification, so normalize it when present.
  for (const sub of ["skill", "agent"]) {
    const dir = path.join(root, sub);
    const entry = await lstatOrNull(io, dir);
    if (entry?.isSymbolicLink()) {
      await io.rm(dir, { force: true });
      await io.mkdir(dir, { recursive: true });
      fixed.push({ path: dir, action: "replaced-symlink" });
    }
  }
  return { root, fixed, warnings };
}

function hasTopLevelKey(content, key) {
  const errors = [];
  const tree = parseTree(content, errors);
  if (errors.length || !tree || tree.type !== "object") return false;
  return (tree.children || []).some((prop) => prop?.children?.[0]?.value === key);
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
  if (!hasTopLevelKey(content, "skills")) return { fixed: false, file };
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const edits = modify(content, ["skills"], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } });
  const next = applyEdits(content, edits);
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

export async function ensureOpencodeConfig({ home = "/home/t3", env = {}, io = defaultFs } = {}) {
  const layout = await ensureOpencodeLayout({ home, env, io });
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
  const env = { OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  if (fix) {
    ensureOpencodeConfig({ home, env })
      .then((result) => {
        console.log(JSON.stringify({ ok: true, ...result }));
      })
      .catch((error) => {
        console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }));
        process.exitCode = 1;
      });
  } else {
    console.log(opencodeConfigRoot(home, env));
  }
}
