// Shared storage service for the setup console, t3-storage, and t3-doctor.
// Heavy scans run in the background; snapshots never start a process. Cleanup
// uses the installer's cross-process lock and the tools' native cache commands.
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { createFs, createRunner, processAlive, processStartTime } from "../io.mjs";
import * as lock from "../lock.mjs";
import { DEFAULT_POLICY, policyPath, policyRevision, readPolicy, storageStateDir, validatePolicy, writeStorageJson } from "./policy.mjs";
import { buildsOrInstallsRunning, checkCachePath, countProjects, detectCaches, filesystemUsage, inside, measureStorage, mountSource, processSnapshot } from "./system.mjs";
import { CACHES, CACHE_IDS, cacheLabel, cacheTarget, cacheSafety, cacheCommand, cacheFingerprint, validCacheIds } from "./caches.mjs";
import { createFilesSizesIndex } from "./files-sizes.mjs";
export { CACHE_IDS, cacheLabel } from "./caches.mjs";

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
  const filesSizes = createFilesSizesIndex({ file: path.join(storageStateDir(env, userHome), "files-sizes.json.gz"), home: userHome, workspace, io, now });
  const ctx = { fs: options.lockFs ?? createFs(), lockPath: lock.lockPath(stateDir), pid: options.pid ?? process.pid,
    now, lockStaleMs: 60 * 60 * 1000, isAlive: options.isAlive ?? processAlive, startTimeOf: options.startTimeOf ?? processStartTime };
  let caches = null, scan = null, stopped = false;
  const previews = new Map();
  const safetyContext = { userHome, env, stateRoot, workspace, io, checkPath };
  const cachePolicies = CACHES.map(({ id, label, icon, budgetKey, defaultGB }) => ({ id, label, icon, budgetKey, defaultBytes: defaultGB * 1_000_000_000 }));
  let lastActivityAt = now();
  let facts = { at: null, refreshing: false, disk: null, categories: [], cleanableBytes: 0,
    volumeKind: null, workspaceKind: null, volumeBytes: null, workspaceProjects: null,
    volumeName: null, stateVolumeName: null, workspaceVolumeName: null,
    cachePolicies, policy: { ...DEFAULT_POLICY }, policyError: null, error: null, partial: false, operation: null };

  const ready = (async () => {
    await filesSizes.ready;
    const preferences = await readPolicy(policyFile, io);
      facts.policy = preferences.policy; facts.policyError = preferences.error;
    try {
      const saved = JSON.parse(await io.readFile(snapshotFile, "utf8"));
      if (saved.schema === 1 && saved.home === userHome && saved.workspace === workspace && Array.isArray(saved.facts?.categories)) {
        facts = { ...facts, ...saved.facts, cachePolicies, policy: preferences.policy, policyError: preferences.error, refreshing: false, operation: null };
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

  const snapshot = () => structuredClone({ ...facts, policyRevision: policyRevision(facts.policy, facts.policyError) });
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
        const targets = {};
        for (const def of CACHES) targets[def.id] = cacheTarget(def.id, caches);
        // A configured cache may be deeper than the bounded home traversal.
        // Measure those locations explicitly rather than report a false zero.
        const missing = [...Object.values(targets).filter(Boolean), path.join(dataDir, "installs"), ...["userdata", "agents", "backups", "container-runtime"].map((part) => path.join(stateRoot, part))]
          .filter((target) => sizes[target] === undefined);
        if (missing.length) {
          const extra = await measure(missing);
          if (extra.partial) throw new Error("Configured caches could not be fully measured. Try again later.");
          Object.assign(sizes, extra.sizes);
        }
        const guards = {};
        // A harness fixture or older detector may only know some caches. Rows
        // are shown only for caches with a detected location; cleanup of an
        // unknown cache reports it as unavailable instead of guessing.
        const present = CACHES.filter((def) => targets[def.id]);
        for (const def of present) {
          guards[def.id] = await cacheSafety(def.id, caches, safetyContext);
        }
        const row = (id, label, target, description, kind = "data", extra = {}) => ({ id, label, path: target,
          bytes: bytes(target), description, kind, ...extra });
        const cacheRow = (def) => row(def.id, def.label, targets[def.id], def.description, "cache", {
          cleanable: Boolean(guards[def.id].safe && caches[def.id]?.executable),
          unavailable: guards[def.id].detail || caches[def.id]?.unavailable || (!caches[def.id]?.executable ? "The cache tool is not available." : null),
          protection: guards[def.id].safe ? null : guards[def.id].reason, icon: def.icon, effect: def.effect,
        });
        const categories = [
          ...present.map(cacheRow),
          row("tools", "Agents & toolchains", path.join(dataDir, "installs"), "Installed agents, language runtimes, and added tools."),
          row("history", "Threads & agent data", path.join(stateRoot, "userdata"), "Conversation history, attachments, and server data."),
          row("agents", "Agent profiles", path.join(stateRoot, "agents"), "Agent conversations, sign-ins, and provider settings."),
          row("backups", "Upgrade backups", path.join(stateRoot, "backups"), "Retained database copies. Archive older backups when no longer needed."),
          row("runtime", "T3 Code runtimes", path.join(stateRoot, "container-runtime"), "Current, previous, and cached channel releases."),
        ];
        const cacheRoots = [path.join(userHome, ".cache"), path.join(userHome, ".npm")];
        const otherCaches = cacheRoots.reduce((sum, target) => sum + bytes(target), 0)
          - categories.filter((item) => CACHE_IDS.includes(item.id) && cacheRoots.some((root) => inside(root, item.path))).reduce((sum, item) => sum + item.bytes, 0);
        categories.push({ id: "other-caches", label: "Other caches", bytes: Math.max(0, otherCaches),
          path: cacheRoots.join(" · "), kind: "data", description: "Browser, npx, and other tool caches. Managed caches above are cleared individually." });
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
        await filesSizes.replace(sizes, { at: facts.at, partial });
        const { operation, policy, policyError, refreshing, ...inventory } = facts;
        await writeStorageJson(snapshotFile, { schema: 1, home: userHome, workspace, facts: inventory }, io);
      } catch (error) { facts.error = error.message || "Storage could not be measured. Try again."; }
    })().finally(() => { facts.refreshing = false; scan = null; });
    return scan;
  };

  async function setPolicy(input, { expectedRevision } = {}) {
    await ready;
    let policy;
    try { policy = validatePolicy(input); } catch (error) { return errorResult("invalid-policy", error.message); }
    const held = await lock.acquireLock({ ...ctx, lockPath: `${policyFile}.lock` }, { id: "storage-policy", operation: "save" });
    if (!held.acquired) return errorResult("busy", "Storage preferences are being saved elsewhere. Try again in a moment.");
    try {
      await readPreferences();
      if (expectedRevision !== undefined && expectedRevision !== policyRevision(facts.policy, facts.policyError)) {
        return errorResult("stale-policy", "Storage preferences changed elsewhere. Reload the latest preferences before saving.");
      }
      await writeStorageJson(policyFile, policy, io);
      facts.policy = policy; facts.policyError = null; lastActivityAt = now();
      return { ok: true, policy, policyRevision: policyRevision(policy) };
    } catch { return errorResult("write-failed", "Storage preferences could not be saved. Try again."); }
    finally { await held.release(); }
  }

  async function previewClean(ids) {
    await ready;
    if (!validCacheIds(ids)) return errorResult("invalid-cache", "Choose one or more known tool caches.");
    try {
      const detected = await detect({ env, userHome, run });
      const activity = await processes();
      // Guards and targets resolve first without measuring. One traversal
      // below then sizes every selected cache at once, instead of one `du`
      // per cache on every preview.
      const pending = [];
      for (const id of ids) {
        const busy = buildsOrInstallsRunning(activity, [id]);
        const definition = CACHES.find((cache) => cache.id === id), guard = await cacheSafety(id, detected, safetyContext);
        pending.push({ id, busy, definition, guard, target: cacheTarget(id, detected),
          bytes: facts.categories.find((row) => row.id === id)?.bytes || 0,
          status: guard.safe ? "ready" : "protected", reason: guard.reason || null, detail: guard.detail || null });
      }
      const measurable = pending.filter((entry) => entry.guard.safe);
      const measured = measurable.length ? await measure(measurable.map((entry) => entry.target)) : { sizes: {}, partial: false };
      const rows = [], approved = new Map();
      for (const entry of pending) {
        let { bytes, status, reason, detail } = entry;
        if (entry.guard.safe) {
          bytes = measured.sizes[entry.target] ?? 0;
          if (measured.partial) { status = "unavailable"; reason = "Measurement incomplete"; detail = "Refresh and review this cache again before cleaning it."; }
          else if (!bytes) { status = "empty"; reason = "Already empty"; detail = "There is no cached data to clear."; }
          else if (entry.busy) { status = "busy"; reason = activity.complete ? "Tools are in use" : "Activity unavailable"; detail = activity.complete
            ? "Finish running builds or tool commands, then check again. No files have been changed." : "Running tools could not be checked. Try again in a moment."; }
        }
        const eligible = status === "ready";
        if (eligible) approved.set(entry.id, cacheFingerprint(entry.id, detected, entry.guard));
        rows.push({ id: entry.id, label: entry.definition.label, icon: entry.definition.icon, effect: entry.definition.effect, cleanupHint: entry.definition.cleanupHint, path: entry.target,
          bytes, eligible, status, reason, detail, method: entry.id === "uv" ? "prune" : "clear" });
      }
      const token = randomBytes(32).toString("hex"), expiresAt = now() + 5 * 60 * 1000;
      while (previews.size >= 16) previews.delete(previews.keys().next().value);
      previews.set(token, { approved, expiresAt });
      return { ok: true, dryRun: true, token, expiresAt, expiresInMs: 5 * 60 * 1000, caches: rows,
        estimatedBytes: rows.filter((row) => row.eligible).reduce((sum, row) => sum + row.bytes, 0),
        byteMeaning: "cache-data", note: "Sizes describe cached data. Shared files and entries still in use can remain on disk." };
    } catch { return errorResult("unavailable", "Cache locations could not be reviewed. Try again; no files have been changed."); }
  }

  async function clean(ids, { onStarted, onProgress, automatic = false, dryRun = false, token } = {}) {
    await ready;
    if (!validCacheIds(ids)) {
      return errorResult("invalid-cache", `Choose one or more caches: ${CACHES.map((cache) => cache.id).join(", ")}.`);
    }
    if (dryRun) return previewClean(ids);
    const preview = token === undefined ? null : previews.get(token);
    if (token !== undefined && (!preview || preview.expiresAt <= now() || ids.some((id) => !preview.approved.has(id)))) {
      return errorResult("stale-preview", "This review has expired or its selection changed. Review the caches again before cleaning them.");
    }
    const held = await lock.acquireLock(ctx, { id: "storage", operation: "clean" });
    if (held && !held.acquired) return errorResult("busy", "An installation or cleanup is running. Try again when it finishes.");
    let operation, scratch = null;
    const report = async (patch) => {
      operation = { ...operation, ...patch }; facts.operation = operation;
      await persistOperation(operation);
      try { onProgress?.(structuredClone(operation)); } catch { /* listeners do not own the operation */ }
    };
    try {
      // Selection is resolved again under the shared install lock. A cached
      // inventory is useful presentation, never authorization to remove files.
      caches = await detect({ env, userHome, run });
      const activity = await processes();
      if (!activity.complete) return errorResult("unavailable", "Tool activity could not be checked. Cleanup is paused.");
      if (buildsOrInstallsRunning(activity, ids)) {
        lastActivityAt = now();
        return errorResult("busy", "A build or package installation is running. Try again when it finishes.");
      }
      const selected = [];
      for (const id of ids) {
        const cache = caches[id];
        const target = cacheTarget(id, caches), guard = await cacheSafety(id, caches, safetyContext);
        if (!guard.safe) return errorResult(token === undefined ? "unavailable" : "stale-preview", guard.detail || "This cache cannot be cleaned safely. Review it again.");
        const fingerprint = cacheFingerprint(id, caches, guard);
        if (preview && preview.approved.get(id) !== fingerprint) return errorResult("stale-preview", "A cache location changed after this review. Check the new locations before cleaning them.");
        selected.push({ id, bytes: 0, target, fingerprint, ...cache });
      }
      if (token !== undefined) previews.delete(token);
      {
        operation = { id: randomUUID(), ids, state: "running", phase: "checking", automatic, pid: ctx.pid,
          startTime: ctx.startTimeOf(ctx.pid), startedAt: now(), finishedAt: null,
          estimatedBytes: facts.categories.filter((item) => ids.includes(item.id)).reduce((sum, item) => sum + item.bytes, 0),
          reclaimedBytes: null, removedCacheBytes: 0, byteMeaning: "cache-data", completedIds: [], remainingIds: [...ids], error: null };
        await report({});
        try { onStarted?.(structuredClone(operation)); } catch { /* listener */ }
      }
      // One traversal sizes every selected cache at once, instead of one `du`
      // per cache before each cleanup.
      {
        const measured = await measure(selected.map((entry) => entry.target));
        if (measured.partial) throw new Error("This cache could not be fully checked. Clean it from a terminal.");
        for (const entry of selected) entry.bytes = measured.sizes[entry.target] ?? 0;
      }
      const estimatedBytes = selected.reduce((sum, item) => sum + item.bytes, 0);
      await report({ estimatedBytes });
      let removedCacheBytes = 0;
      const scratchProject = async () => {
        if (scratch) return scratch;
        await io.mkdir(temporary, { recursive: true });
        scratch = await io.mkdtemp(path.join(temporary, "t3-storage-"));
        await io.writeFile(path.join(scratch, "package.json"), '{"private":true,"name":"t3-storage-cache"}\n', { flag: "wx", mode: 0o600 });
        return scratch;
      };
      for (const cache of selected) {
        const guard = await cacheSafety(cache.id, caches, safetyContext);
        if (!guard.safe || cacheFingerprint(cache.id, caches, guard) !== cache.fingerprint) throw new Error(guard.detail || "A cache location changed. Review it again before cleaning it.");
        // Recheck after measurement: a build may have started while scanning.
        if (buildsOrInstallsRunning(await processes(), [cache.id])) throw new Error("A build or tool command started. Cleanup was stopped; review the remaining caches when it finishes.");
        await report({ phase: cache.id, removedCacheBytes });
        const command = cacheCommand(cache.id, caches, ["bun", "mise"].includes(cache.id) ? await scratchProject() : null);
        const result = await run(command.argv, { cwd: command.cwd || userHome, timeoutMs: 5 * 60 * 1000,
          env: { ...env, GOTOOLCHAIN: "local", MISE_AUTO_INSTALL: "false", MISE_NOT_FOUND_SYSTEM_FALLBACK: "false", ...command.env } });
        if (result.error || result.code !== 0) throw new Error(`${cacheLabel(cache.id)} cleanup failed. Retry, or use the terminal for details.`);
        const after = await measure([cache.target]);
        if (after.partial) throw new Error("Cleanup finished, but its result could not be fully measured. Refresh storage.");
        const remainingBytes = after.sizes[cache.target] ?? 0;
        operation.cacheResults = { ...operation.cacheResults, [cache.id]: remainingBytes };
        const row = facts.categories.find((item) => item.id === cache.id);
        if (row) row.bytes = remainingBytes;
        facts.cleanableBytes = facts.categories.filter((item) => item.cleanable).reduce((sum, item) => sum + item.bytes, 0);
        // A removed hardlink does not free its file's blocks. Report cache data
        // removed; only the live filesystem meter describes available space.
        removedCacheBytes += Math.max(0, cache.bytes - remainingBytes);
        await report({ removedCacheBytes, completedIds: [...operation.completedIds, cache.id], remainingIds: operation.remainingIds.filter((id) => id !== cache.id) });
      }
      await report({ state: "succeeded", phase: "done", finishedAt: now(), removedCacheBytes });
      return { ok: true, reclaimedBytes: null, removedCacheBytes, byteMeaning: "cache-data", operation: structuredClone(operation) };
    } catch (error) {
      if (operation) await report({ state: "failed", finishedAt: now(), error: error.message }).catch(() => {});
      return errorResult("failed", error.message || "Cleanup failed. Refresh and try again.");
    } finally {
      lastActivityAt = now();
      if (scratch) await io.rm(scratch, { recursive: true, force: true }).catch(() => {});
      await held?.release();
      // Affected caches were already measured. Update the filesystem meter
      // cheaply; full home traversal belongs to Refresh or the scan timer.
      if (options.refreshAfterCleanup !== false) await refreshDisk();
    }
  }

  async function maintain() {
    await ready;
    // A kill between ticks leaves {running} on disk and in memory; the
    // minute timer never calls status(), so heal here too or auto-clean
    // stalls until the next manual refresh or restart.
    try {
      const saved = JSON.parse(await io.readFile(operationFile, "utf8"));
      if (saved?.id && saved.id === facts.operation?.id && saved.state !== "running") facts.operation = saved;
      else if (saved?.id && (!facts.operation || saved.startedAt > facts.operation.startedAt)) facts.operation = saved;
    } catch { /* no operation */ }
    if (facts.operation?.state === "running" && (!ctx.isAlive(facts.operation.pid)
      || (facts.operation.startTime && ctx.startTimeOf(facts.operation.pid) !== facts.operation.startTime))) {
      facts.operation = { ...facts.operation, state: "interrupted", finishedAt: now(), error: "Cleanup was interrupted. Refresh before trying again." };
    }
    if (stopped || facts.operation?.state === "running") return;
    await readPreferences();
    if (!facts.policy.automatic || facts.policyError || facts.partial || !facts.at) return;
    const overBudget = (item) => {
      const budgetKey = CACHES.find((cache) => cache.id === item.id)?.budgetKey;
      const last = [facts.operation, ...(facts.operation?.recent || [])].find((op) => op?.cacheResults?.[item.id] === item.bytes);
      if (last?.finishedAt && now() - last.finishedAt < 24 * 60 * 60 * 1000) return false;
      return facts.policy.automaticCaches.includes(item.id) && budgetKey && Number.isFinite(facts.policy[budgetKey]) && item.bytes > facts.policy[budgetKey];
    };
    const ids = facts.categories.filter((item) => item.cleanable && overBudget(item)).map((item) => item.id);
    if (!ids.length) return;
    if (buildsOrInstallsRunning(await processes(), ids)) { lastActivityAt = now(); return; }
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
    } finally { if (options.refreshAfterCleanup !== false) await refreshDisk(); }
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
      const completions = [...(facts.operation?.recent || []), facts.operation].filter((op) => op?.finishedAt > (facts.at || 0))
        .sort((a, b) => a.finishedAt - b.finishedAt);
      if (completions.length) {
        for (const completion of completions) for (const [id, bytes] of Object.entries(completion.cacheResults || {})) {
          const row = facts.categories.find((item) => item.id === id);
          if (row && CACHE_IDS.includes(id) && Number.isFinite(bytes) && bytes >= 0) row.bytes = bytes;
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
  return { ready, refresh, snapshot, status, clean, previewClean, setPolicy, maintain, previewVersions, trimVersions,
    sizes: filesSizes.snapshot,
    paths: { home: userHome, workspace, stateRoot, policyFile },
    stop: () => { stopped = true; timers.forEach(clearInterval); } };
}
