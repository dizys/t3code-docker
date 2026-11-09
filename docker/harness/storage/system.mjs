// Linux filesystem/process adapters. No shell interpolation, no commands in
// polling responses, and no arbitrary paths accepted by cleanup endpoints.
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);

export function coveringMount(target, mountinfo) {
  let best = null;
  for (const line of String(mountinfo || "").split("\n")) {
    const fields = line.split(" ");
    const point = fields[4];
    if (!point || point === "/") continue;
    if (inside(point, target) && (!best || point.length > best.point.length)) best = { point, root: fields[3] };
  }
  return best;
}

/**
 * Where a path's mount comes from: `durable` (a named volume or a host
 * directory), `anonymous` (a volume named by a hash, which a recreated
 * container does not get back) or `none`, and the Docker volume's name when it
 * is a volume, so a page can name it in the command that moves it.
 */
export function mountSource(target, mountinfo) {
  const mount = coveringMount(target, mountinfo);
  if (!mount) return { kind: "none", volume: null };
  const volume = /\/var\/lib\/docker\/volumes\/([^/]+)\/_data/.exec(mount.root);
  return { kind: volume && /^[0-9a-f]{64}$/.test(volume[1]) ? "anonymous" : "durable", volume: volume ? volume[1] : null };
}

export const mountKind = (target, mountinfo) => mountSource(target, mountinfo).kind;

export async function countProjects(workspace) {
  const isRepo = async (directory) => fs.stat(path.join(directory, ".git")).then(() => true, () => false);
  if (await isRepo(workspace)) return 1;
  const entries = await fs.readdir(workspace, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.')) count += 1;
  return count;
}

export async function filesystemUsage(target) {
  const info = await fs.statfs(target, { bigint: true });
  const totalBytes = Number(info.blocks * info.bsize);
  const availableBytes = Number(info.bavail * info.bsize);
  const usedBytes = Number((info.blocks - info.bfree) * info.bsize);
  const usedPercent = totalBytes ? Math.min(100, Math.round(usedBytes / totalBytes * 100)) : null;
  return { totalBytes, availableBytes, usedBytes, usedPercent,
    severity: usedPercent === null ? "unknown" : usedPercent >= 90 ? "critical" : usedPercent >= 80 ? "warning" : "ok" };
}

/** One bounded traversal. Descendant sizes come from that same traversal,
 * so category subtraction cannot count a file twice through nested folders. */
export async function measureStorage(roots, { timeout = 120_000, run = exec } = {}) {
  const deadline = Date.now() + timeout;
  const targets = [...new Set(roots)];
  const existing = [];
  for (const target of targets) {
    try { if ((await fs.lstat(target)).isDirectory()) existing.push(target); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!existing.length) return { sizes: {}, partial: false };
  let stdout = "", partial = false;
  try {
    ({ stdout } = await run("du", ["-x", "-B1", "--max-depth=5", "--", ...existing], {
      timeout, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
    }));
  } catch (error) {
    // Permission errors still produce useful totals. A timeout has no
    // reliable root totals and must not replace the last scan. A truncated
    // (maxBuffer) deep listing falls back to root totals. Node kills du on
    // overflow too, so distinguish the error code from a genuine timeout.
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Storage measurement did not finish. Try again later.");
      try {
        ({ stdout } = await run("du", ["-x", "-B1", "-s", "--", ...existing], {
          timeout: remaining, maxBuffer: 256 * 1024, encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
        }));
      } catch (fallback) {
        if (fallback.killed || fallback.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || !fallback.stdout) throw new Error("Storage measurement did not finish. Try again later.");
        stdout = fallback.stdout;
      }
      partial = true; // Descendant sizes are unavailable, so never authorize cleanup.
    } else {
      if (error.killed || !error.stdout) throw new Error("Storage measurement did not finish. Try again later.");
      stdout = error.stdout; partial = true;
    }
  }
  const sizes = {};
  for (const line of stdout.split("\n")) {
    const match = /^(\d+)\t(.+)$/.exec(line);
    if (match) sizes[match[2]] = Number(match[1]);
  }
  return { sizes, partial };
}

export async function executableOnPath(name, env) {
  for (const directory of String(env.PATH || "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try { await fs.access(candidate, 1); if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

/** Read cache configuration without installing a tool or changing versions. */
export async function detectCaches({ env, userHome, run }) {
  const safeEnv = { ...env, MISE_AUTO_INSTALL: "false", MISE_NOT_FOUND_SYSTEM_FALLBACK: "false", GOTOOLCHAIN: "local" };
  const goBin = await executableOnPath("go", env);
  // npm is part of the image. Run it through the infrastructure Node rather
  // than a user-selected Node shim that may have no selection yet.
  const nodeBin = env.T3_INFRA_NODE || process.execPath;
  const builtinNpm = path.join(path.dirname(nodeBin), "npm");
  const npmBin = await fs.access(builtinNpm, 1).then(() => builtinNpm, () => executableOnPath("npm", env));
  const uvBin = await executableOnPath("uv", env);
  const bunBin = await executableOnPath("bun", env);
  const miseBin = await executableOnPath("mise", env);
  const denoBin = await executableOnPath("deno", env);
  const query = async (bin, args, cwd = userHome) => {
    if (!bin) return null;
    const result = await run([bin, ...args], { env: safeEnv, cwd, timeoutMs: 15_000 });
    const value = result.code === 0 && !result.error ? result.stdout.trim() : "";
    return path.isAbsolute(value) ? path.resolve(value) : null;
  };
  const queryJson = async (bin, args) => {
    if (!bin) return null;
    try {
      const result = await run([bin, ...args], { env: safeEnv, cwd: userHome, timeoutMs: 15_000 });
      if (result.code !== 0 || result.error) return null;
      const value = JSON.parse(result.stdout);
      return value && typeof value === "object" ? value : null;
    } catch { return null; }
  };
  const defaultCache = (part) => path.join(env.XDG_CACHE_HOME || path.join(userHome, ".cache"), part);
  const bunHome = env.BUN_INSTALL && path.isAbsolute(env.BUN_INSTALL) ? path.resolve(env.BUN_INSTALL) : path.join(userHome, ".bun");
  const queryBunCache = async () => {
    if (!bunBin) return null;
    // Bun requires a project even to report its global cache directory.
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "t3-storage-bun-"));
    try {
      await fs.writeFile(path.join(project, "package.json"), '{"private":true}\n');
      return await query(bunBin, ["pm", "cache"], project);
    } finally { await fs.rm(project, { recursive: true, force: true }); }
  };
  const [go, gomod, npm, uv, bun, mise, denoInfo] = await Promise.all([
    query(goBin, ["env", "GOCACHE"]), query(goBin, ["env", "GOMODCACHE"]),
    query(npmBin ? nodeBin : null, [npmBin, "config", "get", "cache"]),
    query(uvBin, ["cache", "dir"]), queryBunCache(), query(miseBin, ["cache", "path"]),
    queryJson(denoBin, ["info", "--json"]),
  ]);
  const miseDir = mise || (env.MISE_CACHE_DIR && path.isAbsolute(env.MISE_CACHE_DIR) ? path.resolve(env.MISE_CACHE_DIR) : null);
  const deno = denoInfo && typeof denoInfo.denoDir === "string" && path.isAbsolute(denoInfo.denoDir)
    ? path.resolve(denoInfo.denoDir) : null;
  const install = (bin, tool) => !bin ? `Install ${tool} to clean this cache.` : null;
  return {
    go: { path: go || defaultCache("go-build"), executable: go ? goBin : null,
      unavailable: !goBin ? "Install Go to clean this cache." : !go ? "Go cache settings could not be read. Refresh or check your Go configuration." : null },
    gomod: { path: gomod || path.join(userHome, "go", "pkg", "mod"), executable: gomod ? goBin : null,
      unavailable: !goBin ? "Install Go to clean this cache." : !gomod ? "Go module settings could not be read. Refresh or check your Go configuration." : null },
    npm: { path: npm || path.join(userHome, ".npm"), executable: npm ? nodeBin : null, argsPrefix: npmBin ? [npmBin] : [],
      unavailable: !npmBin ? "Install Node/npm to clean this cache." : !npm ? "npm cache settings could not be read. Refresh or check your npm configuration." : null },
    uv: { path: uv || defaultCache("uv"), executable: uv ? uvBin : null,
      unavailable: install(uvBin, "uv") || (!uv ? "uv cache settings could not be read. Refresh or check your uv configuration." : null) },
    bun: { path: bun || path.join(bunHome, "install", "cache"), executable: bun ? bunBin : null,
      unavailable: install(bunBin, "Bun") || (!bun ? "Bun cache settings could not be read. Refresh or check your Bun configuration." : null) },
    mise: { path: miseDir || defaultCache("mise"), executable: miseBin,
      unavailable: install(miseBin, "mise") },
    deno: { path: deno || defaultCache("deno"), executable: deno ? denoBin : null,
      unavailable: install(denoBin, "Deno") || (!deno ? "Deno cache settings could not be read. Refresh or check your Deno configuration." : null) },
  };
}

/** Only ordinary cache directories under known cache roots can be cleaned.
 * Only the cache subtrees of ~/.bun and ~/go are eligible; their bin/src
 * directories contain installed tools and projects.
 * Symlink components and custom locations are visible but never auto-cleaned. */
export async function checkCachePath(target, { userHome, cacheHome, stateRoot, workspace, io = fs }) {
  if (!path.isAbsolute(target)) return { safe: false, reason: "This cache has a custom location. Clean it from a terminal." };
  const cacheRoots = [cacheHome, path.join(userHome, ".cache"), path.join(userHome, ".npm"),
    path.join(userHome, ".bun/install/cache"), path.join(userHome, "go/pkg/mod")].filter((p) => p && inside(userHome, p));
  if (!cacheRoots.some((root) => inside(root, target)) || target === userHome
      || inside(stateRoot, target) || inside(workspace, target)) {
    return { safe: false, reason: "This cache is outside the managed cache locations. Clean it from a terminal." };
  }
  // Check every component, including the home itself: resolving just the final
  // directory misses an ancestor symlink redirected into credentials or work.
  let current = path.parse(target).root;
  for (const segment of target.slice(current.length).split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await io.lstat(current);
      if (info.isSymbolicLink()) return { safe: false, reason: "This cache uses a linked directory. Clean it from a terminal." };
      if (!info.isDirectory()) return { safe: false, reason: "This cache location is not a directory." };
    } catch (error) {
      if (error.code === "ENOENT") return { safe: true, exists: false };
      return { safe: false, reason: "This cache location could not be checked." };
    }
  }
  return { safe: true, exists: true };
}

/** Arguments stay internal; UI/status receive only a generic activity verdict.
 * Unreadable processes owned by this user make cleanup fail closed. */
export async function processSnapshot({ pid = process.pid, uid = process.getuid?.(), proc = "/proc", includeOpenFiles = false } = {}) {
  const entries = await fs.readdir(proc).catch(() => null);
  if (!entries) return { complete: false, processes: [] };
  const processes = [];
  let complete = true;
  for (const name of entries) {
    if (!/^\d+$/.test(name) || Number(name) === pid) continue;
    const directory = path.join(proc, name);
    let owner;
    try { owner = await fs.stat(directory); } catch { continue; }
    try {
      const raw = await fs.readFile(path.join(directory, "cmdline"));
      const args = raw.toString().split("\0").filter(Boolean);
      if (!args.length) continue;
      const executable = await fs.readlink(path.join(directory, "exe")).catch(() => null);
      const cwd = await fs.readlink(path.join(directory, "cwd")).catch((error) => {
        if (includeOpenFiles && owner.uid === uid && !["ENOENT", "ESRCH"].includes(error.code)) complete = false;
        return null;
      });
      const openFiles = [];
      if (includeOpenFiles && owner.uid === uid) {
        try {
          const descriptors = await fs.readdir(path.join(directory, "fd"));
          if (descriptors.length > 4096) complete = false;
          for (const descriptor of descriptors.slice(0, 4096)) {
            try { const file = await fs.readlink(path.join(directory, "fd", descriptor)); if (path.isAbsolute(file)) openFiles.push(file.replace(/ \(deleted\)$/, "")); }
            catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) complete = false; }
          }
        } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) complete = false; }
      }
      processes.push({ pid: Number(name), uid: owner.uid, args, executable, cwd, ...(includeOpenFiles ? { openFiles } : {}) });
    } catch (error) { if (owner.uid === uid && error.code !== "ENOENT" && error.code !== "ESRCH") complete = false; }
  }
  return { complete, processes };
}

export function buildsOrInstallsRunning(snapshot, cacheIds = null) {
  if (!snapshot.complete) return true;
  const relevant = (...ids) => !cacheIds || ids.some((id) => cacheIds.includes(id));
  return snapshot.processes.some(({ args, executable }) => {
    const bin = path.basename(executable || args[0] || "");
    if (["go", "compile", "link"].includes(bin)) return relevant("go", "gomod");
    if (bin === "rustc") return relevant("mise");
    if (bin === "bunx") return relevant("bun");
    if (bin === "uvx") return relevant("uv");
    // A Deno process of any kind can populate the Deno cache; cleaning while
    // one runs risks removing files from under it.
    if (bin === "deno") return relevant("deno");
    if (bin === "cargo" && args.slice(1).some((arg) => /^(build|run|test|bench|install|fetch|update|add|remove|package|publish)$/.test(arg))) return relevant("mise");
    if (bin === "mise" && args.slice(1).some((arg) => /^(install|i|upgrade|up|uninstall|run|r|exec|x)$/.test(arg))) return true;
    // Bun can auto-install imports while running an application, and uv run
    // and uvx use environments in the cache. They are activity, not idle time.
    if (bin === "bun" && !(args.length === 2 && /^(--version|-v|--help|-h)$/.test(args[1]))) return relevant("bun");
    const packageTool = args.findIndex((arg) => /(?:^|\/)(?:npm(?:-cli\.js)?|pnpm(?:\.cjs)?|yarn(?:\.js)?|bun)$/.test(arg));
    if (packageTool !== -1 && args.slice(packageTool + 1).some((arg) => /^(install|ci|add|update|upgrade|exec|dlx)$/.test(arg))) return relevant(path.basename(args[packageTool]) === "bun" ? "bun" : "npm");
    const uvTool = args.findIndex((arg) => /(?:^|\/)(?:uv|pip(?:\d(?:\.\d+)?)?)$/.test(arg));
    return uvTool !== -1 && args.slice(uvTool + 1).some((arg) => /^(run|install|sync|add|lock|pip|tool|venv|download|wheel)$/.test(arg)) && relevant("uv");
  });
}
