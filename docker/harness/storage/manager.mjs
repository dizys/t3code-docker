// Shared storage service for the setup console, t3-storage, and t3-doctor.
// Heavy scans run in the background; snapshots never start a process. Cleanup
// uses the installer's cross-process lock and the tools' native cache commands.
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { createFs, createRunner, processAlive, processStartTime } from "../io.mjs";
import * as lock from "../lock.mjs";
import { DEFAULT_POLICY, policyPath, readPolicy, storageStateDir, validatePolicy, writeStorageJson } from "./policy.mjs";
import { buildsOrInstallsRunning, checkCachePath, countProjects, detectCaches, filesystemUsage, inside, measureStorage, mountSource, processSnapshot } from "./system.mjs";

const IDLE_MS = 10 * 60 * 1000;
const TERMINAL = new Set(["succeeded", "failed", "interrupted"]);
const errorResult = (code, error) => ({ ok: false, code, error });

export function createStorageManager(options = {}) {
  const env = options.env ?? process.env;
  const userHome = path.resolve(options.home ?? env.HOME ?? os.homedir());
  const workspace = path.resolve(options.workspace ?? env.T3_WORKSPACE ?? "/workspace");
  const stateRoot = path.resolve(env.T3CODE_HOME || path.join(userHome, ".t3"));
  const temporary = path.resolve(options.temporary ?? os.tmpdir());
  const dataDir = path.resolve(env.MISE_DATA_DIR || path.join(userHome, ".local/share/mise"));
  const stateDir = path.resolve(env.MISE_STATE_DIR || path.join(userHome, ".local/state/mise"));
  const io = options.fs ?? fs;
  const run = options.run ?? createRunner();
  const now = options.now ?? Date.now;
  const processes = options.processes ?? processSnapshot;
  const measure = options.measure ?? measureStorage;
  const diskUsage = options.diskUsage ?? filesystemUsage;
  const checkPath = options.checkPath ?? checkCachePath;
  const detect = options.detectCaches ?? detectCaches;
  const policyFile = policyPath(env, userHome);
  const operationFile = path.join(storageStateDir(env, userHome), "storage-operation.json");
  const snapshotFile = path.join(storageStateDir(env, userHome), "storage-snapshot.json");
  const ctx = { fs: options.lockFs ?? createFs(), lockPath: lock.lockPath(stateDir), pid: options.pid ?? process.pid,
    now, lockStaleMs: 60 * 60 * 1000, isAlive: options.isAlive ?? processAlive, startTimeOf: options.startTimeOf ?? processStartTime };
  let caches = null, scan = null, stopped = false;
  let lastActivityAt = now();
  let facts = { at: null, refreshing: false, disk: null, categories: [], cleanableBytes: 0,
    volumeKind: null, workspaceKind: null, volumeBytes: null, workspaceProjects: null,
    volumeName: null, stateVolumeName: null, workspaceVolumeName: null,
    policy: { ...DEFAULT_POLICY }, policyError: null, error: null, partial: false, operation: null };

  const ready = (async () => {
    const preferences = await readPolicy(policyFile, io);
    facts.policy = preferences.policy; facts.policyError = preferences.error;
    try {
      const saved = JSON.parse(await io.readFile(snapshotFile, "utf8"));
      if (saved.schema === 1 && saved.home === userHome && saved.workspace === workspace && Array.isArray(saved.facts?.categories)) {
        facts = { ...facts, ...saved.facts, policy: preferences.policy, policyError: preferences.error, refreshing: false, operation: null };
      }
    } catch { /* no cached inventory */ }
    try {
      const saved = JSON.parse(await io.readFile(operationFile, "utf8"));
      if (saved && typeof saved.id === "string" && ["running", ...TERMINAL].includes(saved.state)) {
        const alive = ctx.isAlive(saved.pid) && (!saved.startTime || ctx.startTimeOf(saved.pid) === saved.startTime);
        facts.operation = saved.state === "running" && !alive
          ? { ...saved, state: "interrupted", finishedAt: now(), error: "Cleanup was interrupted. Refresh storage before trying again." } : saved;
      }
    } catch { /* no prior operation */ }
  })();

  const snapshot = () => structuredClone(facts);
  const persistOperation = async (operation) => {
    let previous;
    try { previous = JSON.parse(await io.readFile(operationFile, "utf8")); } catch { /* first operation */ }
    const recent = previous?.id === operation.id ? previous.recent || []
      : [previous, ...(previous?.recent || [])].filter((item) => item?.id && TERMINAL.has(item.state));
    operation.recent = recent.slice(0, 6).map(({ recent: ignored, ...item }) => item);
    await writeStorageJson(operationFile, operation, io);
  };
  const readPreferences = async () => {
    const result = await readPolicy(policyFile, io);
    facts.policy = result.policy; facts.policyError = result.error;
  };
  const refreshDisk = async () => {
    try { facts.disk = await diskUsage(userHome); } catch { facts.disk = null; }
  };

  const refresh = () => {
    if (scan) return scan;
    facts.refreshing = true;
    scan = (async () => {
      await ready;
      await readPreferences();
      await refreshDisk();
      try {
        caches = await detect({ env, userHome, run });
        const roots = [userHome, workspace, temporary];
        if (!roots.some((root) => inside(root, stateRoot))) roots.push(stateRoot);
        const { sizes, partial } = await measure(roots);
        const bytes = (target) => sizes[target] ?? 0;
        const go = caches.go.path;
        const npm = path.join(caches.npm.path, "_cacache");
        // A configured cache may be deeper than the bounded home traversal.
        // Measure those locations explicitly rather than report a false zero.
        const missing = [go, npm, path.join(dataDir, "installs"), ...["userdata", "agents", "backups", "container-runtime"].map((part) => path.join(stateRoot, part))]
          .filter((target) => sizes[target] === undefined);
        if (missing.length) {
          const extra = await measure(missing);
          if (extra.partial) throw new Error("Configured caches could not be fully measured. Try again later.");
          Object.assign(sizes, extra.sizes);
        }
        const guards = {};
        for (const [id, target] of [["go", go], ["npm", npm]]) {
          guards[id] = await checkPath(target, { userHome, cacheHome: env.XDG_CACHE_HOME, stateRoot, workspace, io });
        }
        const row = (id, label, target, description, kind = "data", extra = {}) => ({ id, label, path: target,
          bytes: bytes(target), description, kind, ...extra });
        const cacheRow = (id, label, target, description) => row(id, label, target, description, "cache", {
          cleanable: Boolean(guards[id].safe && caches[id].executable),
          unavailable: guards[id].reason || caches[id].unavailable || (!caches[id].executable ? "The cache tool is not available." : null),
        });
        const categories = [
          cacheRow("go", "Go build cache", go, "Compiled packages. Builds recreate these when needed."),
          cacheRow("npm", "npm downloads", npm, "Downloaded packages. Installs fetch them again when needed."),
          row("tools", "Agents & toolchains", path.join(dataDir, "installs"), "Installed agents, language runtimes, and added tools."),
          row("history", "Threads & agent data", path.join(stateRoot, "userdata"), "Conversation history, attachments, and server data."),
          row("agents", "Agent profiles", path.join(stateRoot, "agents"), "Agent conversations, sign-ins, and provider settings."),
          row("backups", "Upgrade backups", path.join(stateRoot, "backups"), "Retained database copies. Archive older backups when no longer needed."),
          row("runtime", "T3 Code runtimes", path.join(stateRoot, "container-runtime"), "Current, previous, and cached channel releases."),
        ];
        const cacheRoots = [path.join(userHome, ".cache"), path.join(userHome, ".npm")];
        const otherCaches = cacheRoots.reduce((sum, target) => sum + bytes(target), 0)
          - categories.filter((item) => ["go", "npm"].includes(item.id) && cacheRoots.some((root) => inside(root, item.path))).reduce((sum, item) => sum + item.bytes, 0);
        categories.push({ id: "other-caches", label: "Other caches", bytes: Math.max(0, otherCaches),
          path: cacheRoots.join(" · "), kind: "data", description: "Browser, package manager, model, and npx caches." });
        const assignedHome = categories.filter((item) => item.id !== "other-caches" && inside(userHome, item.path)).reduce((sum, item) => sum + item.bytes, 0) + Math.max(0, otherCaches);
        categories.push({ id: "other-home", label: "Other home data", bytes: Math.max(0, bytes(userHome) - assignedHome),
          path: userHome, kind: "data", description: "Other files in the persistent home." });
        categories.push(row("workspace", "Projects", workspace, "Source code, dependencies, and local application data."));
        categories.push(row("temporary", "Temporary files", temporary, "Files created by tools and tests. Projects own their cleanup."));
        if (!partial) {
          const oldBytes = facts.categories.filter((item) => item.kind === "cache").reduce((sum, item) => sum + item.bytes, 0);
          const newBytes = categories.filter((item) => item.kind === "cache").reduce((sum, item) => sum + item.bytes, 0);
          if (newBytes > oldBytes) lastActivityAt = now();
        }
        facts.categories = categories;
        facts.cleanableBytes = categories.filter((item) => item.cleanable).reduce((sum, item) => sum + item.bytes, 0);
        facts.volumeBytes = bytes(userHome); facts.partial = partial;
        facts.error = partial ? "Some folders could not be read. Sizes are partial estimates." : null;
        facts.at = now();
        const mountinfo = await io.readFile("/proc/self/mountinfo", "utf8").catch(() => "");
        const home = mountSource(userHome, mountinfo), work = mountSource(workspace, mountinfo), stateMount = mountSource(stateRoot, mountinfo);
        facts.volumeKind = home.kind; facts.volumeName = home.volume;
        facts.workspaceKind = work.kind; facts.workspaceVolumeName = work.volume;
        facts.stateKind = stateMount.kind; facts.stateVolumeName = stateMount.volume; facts.statePath = stateRoot;
        facts.workspaceProjects = await (options.countProjects ?? countProjects)(workspace);
        const { operation, policy, policyError, refreshing, ...inventory } = facts;
        await writeStorageJson(snapshotFile, { schema: 1, home: userHome, workspace, facts: inventory }, io);
      } catch (error) { facts.error = error.message || "Storage could not be measured. Try again."; }
    })().finally(() => { facts.refreshing = false; scan = null; });
    return scan;
  };

  async function setPolicy(input) {
    await ready;
    let policy;
    try { policy = validatePolicy(input); } catch (error) { return errorResult("invalid-policy", error.message); }
    try { await writeStorageJson(policyFile, policy, io); }
    catch { return errorResult("write-failed", "Storage preferences could not be saved. Try again."); }
    facts.policy = policy; facts.policyError = null; lastActivityAt = now();
    return { ok: true, policy };
  }

  async function clean(ids, { onStarted, onProgress, automatic = false, dryRun = false } = {}) {
    await ready;
    if (!Array.isArray(ids) || !ids.length || ids.length > 2 || new Set(ids).size !== ids.length || ids.some((id) => !["go", "npm"].includes(id))) {
      return errorResult("invalid-cache", "Choose Go, npm, or both caches.");
    }
    if (!caches) {
      try { caches = await detect({ env, userHome, run }); } catch { /* reported below */ }
    }
    if (!caches) return errorResult("unavailable", "Storage could not be checked. Refresh and try again.");
    const held = dryRun ? null : await lock.acquireLock(ctx, { id: "storage", operation: "clean" });
    if (held && !held.acquired) return errorResult("busy", "An installation or cleanup is running. Try again when it finishes.");
    let operation;
    const report = async (patch) => {
      operation = { ...operation, ...patch }; facts.operation = operation;
      await persistOperation(operation);
      try { onProgress?.(structuredClone(operation)); } catch { /* listeners do not own the operation */ }
    };
    try {
      const activity = await processes();
      if (!activity.complete) return errorResult("unavailable", "Tool activity could not be checked. Cleanup is paused.");
      if (buildsOrInstallsRunning(activity)) {
        lastActivityAt = now();
        return errorResult("busy", "A build or package installation is running. Try again when it finishes.");
      }
      const selected = [];
      for (const id of ids) {
        const cache = caches[id];
        const target = id === "npm" ? path.join(cache.path, "_cacache") : cache.path;
        const guard = await checkPath(target, { userHome, cacheHome: env.XDG_CACHE_HOME, stateRoot, workspace, io });
        if (!guard.safe || !cache.executable) return errorResult("unavailable", guard.reason || "The cache tool is not available.");
        selected.push({ id, bytes: 0, target, ...cache });
      }
      if (!dryRun) {
        operation = { id: randomUUID(), ids, state: "running", phase: "checking", automatic, pid: ctx.pid,
          startTime: ctx.startTimeOf(ctx.pid), startedAt: now(), finishedAt: null,
          estimatedBytes: facts.categories.filter((item) => ids.includes(item.id)).reduce((sum, item) => sum + item.bytes, 0),
          reclaimedBytes: 0, error: null };
        await report({});
        try { onStarted?.(structuredClone(operation)); } catch { /* listener */ }
      }
      for (const cache of selected) {
        const measured = await measure([cache.target]);
        if (measured.partial) throw new Error("This cache could not be fully checked. Clean it from a terminal.");
        cache.bytes = measured.sizes[cache.target] ?? 0;
      }
      const estimatedBytes = selected.reduce((sum, item) => sum + item.bytes, 0);
      if (dryRun) return { ok: true, dryRun: true, caches: selected.map(({ id, bytes }) => ({ id, bytes })), estimatedBytes };
      await report({ estimatedBytes });
      let reclaimedBytes = 0;
      for (const cache of selected) {
        const guard = await checkPath(cache.target, { userHome, cacheHome: env.XDG_CACHE_HOME, stateRoot, workspace, io });
        if (!guard.safe) throw new Error(guard.reason);
        // Recheck after measurement: a build may have started while scanning.
        if (buildsOrInstallsRunning(await processes())) throw new Error("A build or installation started. Cleanup was stopped; try again when it finishes.");
        await report({ phase: cache.id, reclaimedBytes });
        const argv = cache.id === "go" ? [cache.executable, ...(cache.argsPrefix || []), "clean", "-cache"]
          : [cache.executable, ...(cache.argsPrefix || []), "cache", "clean", "--force", "--cache", cache.path];
        const result = await run(argv, { cwd: userHome, timeoutMs: 5 * 60 * 1000,
          env: { ...env, GOCACHE: caches.go.path, GOTOOLCHAIN: "local", MISE_AUTO_INSTALL: "false", MISE_NOT_FOUND_SYSTEM_FALLBACK: "false" } });
        if (result.error || result.code !== 0) throw new Error(`${cache.id === "go" ? "Go" : "npm"} cache cleanup failed. Retry, or use the terminal for details.`);
        const after = await measure([cache.target]);
        if (after.partial) throw new Error("Cleanup finished, but its result could not be fully measured. Refresh storage.");
        const remainingBytes = after.sizes[cache.target] ?? 0;
        operation.cacheResults = { ...operation.cacheResults, [cache.id]: remainingBytes };
        const row = facts.categories.find((item) => item.id === cache.id);
        if (row) row.bytes = remainingBytes;
        facts.cleanableBytes = facts.categories.filter((item) => item.cleanable).reduce((sum, item) => sum + item.bytes, 0);
        reclaimedBytes += Math.max(0, cache.bytes - remainingBytes);
        await report({ reclaimedBytes });
      }
      await report({ state: "succeeded", phase: "done", finishedAt: now(), reclaimedBytes });
      return { ok: true, reclaimedBytes, operation: structuredClone(operation) };
    } catch (error) {
      if (operation) await report({ state: "failed", finishedAt: now(), error: error.message }).catch(() => {});
      return errorResult("failed", error.message || "Cleanup failed. Refresh and try again.");
    } finally {
      await held?.release();
      if (!dryRun && options.refreshAfterCleanup !== false) void refresh();
    }
  }

  async function maintain() {
    await ready;
    if (stopped || facts.operation?.state === "running") return;
    await readPreferences();
    if (!facts.policy.automatic || facts.policyError || facts.partial || !facts.at) return;
    const ids = facts.categories.filter((item) => item.cleanable && item.bytes > facts.policy[`${item.id}BudgetBytes`]).map((item) => item.id);
    if (!ids.length) return;
    if (buildsOrInstallsRunning(await processes())) { lastActivityAt = now(); return; }
    if (now() - lastActivityAt < IDLE_MS) return;
    return clean(ids, { automatic: true });
  }

  async function previewVersions({ includePrevious = false } = {}) {
    if (!options.retention) return errorResult("unavailable", "Tool retention is not available in this installation.");
    const plan = await options.retention.preview({ includePrevious });
    const paths = plan.items.filter((item) => item.eligible).map((item) => item.path);
    const measured = paths.length ? await measure(paths) : { sizes: {}, partial: false };
    return { ok: true, ...plan, partial: measured.partial, estimatedBytes: paths.reduce((sum, target) => sum + (measured.sizes[target] ?? 0), 0) };
  }

  async function trimVersions({ onStarted, onProgress, token, includePrevious = false } = {}) {
    await ready;
    if (!options.retention) return errorResult("unavailable", "Tool retention is not available in this installation.");
    let operation;
    const report = async (patch) => {
      operation = { ...operation, ...patch }; facts.operation = operation;
      await persistOperation(operation);
      try { onProgress?.(structuredClone(operation)); } catch { /* listener */ }
    };
    try {
      const result = await options.retention.prune({
        token, includePrevious,
        beforeRemove: async () => {
          operation = { id: randomUUID(), ids: ["versions"], includePrevious, state: "running", phase: "versions", pid: ctx.pid,
            startTime: ctx.startTimeOf(ctx.pid), startedAt: now(), finishedAt: null, error: null };
          // The retention manager holds the same global lock before this fires.
          await report({});
        },
        onStarted: () => {
          try { onStarted?.(structuredClone(operation)); } catch { /* listener */ }
        },
      });
      if (operation) await report({ state: result.ok ? "succeeded" : "failed", finishedAt: now(),
        removedCount: result.removed?.length || 0, error: result.warning || result.error || null });
      return result;
    } catch (error) {
      if (operation) await report({ state: "failed", finishedAt: now(), error: "Older versions could not be trimmed. Try again." }).catch(() => {});
      return errorResult("failed", "Older versions could not be trimmed. Try again.");
    } finally { if (options.refreshAfterCleanup !== false) void refresh(); }
  }

  async function status() {
    await ready;
    await readPreferences();
    await refreshDisk();
    try {
      const saved = JSON.parse(await io.readFile(operationFile, "utf8"));
      if (saved?.id && saved.id !== facts.operation?.id && (!facts.operation || saved.startedAt > facts.operation.startedAt)) facts.operation = saved;
      else if (saved?.id === facts.operation?.id && saved.state !== "running") facts.operation = saved;
      if (facts.operation?.state === "running" && (!ctx.isAlive(facts.operation.pid)
        || (facts.operation.startTime && ctx.startTimeOf(facts.operation.pid) !== facts.operation.startTime))) {
        facts.operation = { ...facts.operation, state: "interrupted", finishedAt: now(), error: "Cleanup was interrupted. Refresh before trying again." };
      }
      // A CLI operation can finish between console scans. Its measured cache
      // results update those rows without starting another traversal on a poll.
      if (facts.operation?.finishedAt > (facts.at || 0)) {
        for (const [id, bytes] of Object.entries(facts.operation.cacheResults || {})) {
          const row = facts.categories.find((item) => item.id === id);
          if (row && ["go", "npm"].includes(id) && Number.isFinite(bytes) && bytes >= 0) row.bytes = bytes;
        }
        facts.cleanableBytes = facts.categories.filter((item) => item.cleanable).reduce((sum, item) => sum + item.bytes, 0);
      }
    } catch { /* no operation */ }
    return snapshot();
  }

  const timers = options.intervalMs === 0 ? [] : [
    setInterval(() => { void refresh(); }, options.intervalMs ?? 10 * 60 * 1000),
    setInterval(() => { void refreshDisk(); void maintain().catch(() => {}); }, 60_000),
  ];
  timers.forEach((timer) => timer.unref?.());
  return { ready, refresh, snapshot, status, clean, setPolicy, maintain, previewVersions, trimVersions,
    paths: { home: userHome, workspace, stateRoot, policyFile },
    stop: () => { stopped = true; timers.forEach(clearInterval); } };
}
