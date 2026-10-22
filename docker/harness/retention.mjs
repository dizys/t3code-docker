// Conservative pruning of installs owned by this manager. Never run a blanket
// mise prune: tracked project requirements, T3 provider paths, live processes,
// current selection all veto removal. The previous selection is kept unless
// a manual review explicitly includes it; automatic retention never does.
import path from "node:path";
import { createHash } from "node:crypto";
import { getHarness, getManagedTool, harnessInstallationForVersion } from "./catalogue.mjs";
import * as mise from "./mise.mjs";
import * as state from "./state.mjs";
import { policyPath, readPolicy } from "./storage/policy.mjs";
import { inside, processSnapshot } from "./storage/system.mjs";

const exact = /^\d+\.[0-9A-Za-z._+-]{1,62}$/;
const sections = ["harnesses", "toolchains", "packages"];
const recordsOf = (saved) => sections.flatMap((section) => Object.entries(saved[section] || {}).map(([id, record]) => ({ section, id, record })));
const versionsOf = (record) => [...new Set((record.managedVersions || []).filter((v) => typeof v === "string" && exact.test(v)))];

function providerPaths(value, result = []) {
  if (!value || typeof value !== "object") return result;
  for (const [key, child] of Object.entries(value)) {
    if (key === "binaryPath" && typeof child === "string" && path.isAbsolute(child)) result.push(path.resolve(child));
    else if (key === "PATH" && typeof child === "string") result.push(...child.split(path.delimiter).filter((part) => path.isAbsolute(part)).map((part) => path.resolve(part)));
    else if (child && typeof child === "object") providerPaths(child, result);
  }
  return result;
}

async function references(ctx) {
  const processes = await (ctx.retentionProcesses || processSnapshot)();
  if (!processes.complete) throw new Error("Running tools could not be checked. Older versions were kept.");
  const settings = path.join(ctx.env.T3CODE_HOME || path.join(ctx.home, ".t3"), "userdata/settings.json");
  let providers = [];
  try {
    const settingsValue = JSON.parse(await ctx.fs.readFile(settings, "utf8"));
    if (!settingsValue || typeof settingsValue !== "object" || Array.isArray(settingsValue)) throw new Error("Invalid settings");
    providers = providerPaths(settingsValue);
  }
  catch (error) { if (error.code !== "ENOENT") throw new Error("Provider selections could not be checked. Older versions were kept."); }
  for (const selected of [...providers]) {
    try { providers.push(await ctx.fs.realpath(selected)); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw new Error("Provider paths could not be checked. Older versions were kept."); }
  }
  return { prunable: await mise.listPrunable(ctx), providers, processes: processes.processes };
}

/** Verify both the path mise reported and its ancestors. Symlinked installs
 * remain usable, but are never deleted by automatic retention. */
async function ordinaryInstall(ctx, target) {
  const root = path.resolve(ctx.dataDir, "installs");
  if (!target || !inside(root, path.resolve(target)) || path.resolve(target) === root) return false;
  let current = path.resolve(target);
  try {
    while (true) {
      const info = await ctx.fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      if (current === path.parse(current).root) break;
      current = path.dirname(current);
    }
    return true;
  } catch { return false; }
}

export async function planRetention(ctx, { saved, only, includePrevious = false } = {}) {
  if (typeof includePrevious !== "boolean") throw new TypeError("includePrevious must be a boolean");
  saved ||= await state.readState(ctx);
  const preferences = await readPolicy(policyPath(ctx.env, ctx.home), ctx.fs);
  const records = only ? [only] : recordsOf(saved);
  const needsReferences = records.some(({ record }) => {
    const versions = versionsOf(record);
    const previous = record.previousVersion || versions.filter((version) => version !== record.version).at(-1);
    return versions.some((version) => version !== record.version && (includePrevious || version !== previous));
  });
  let refs = null, warning = preferences.error;
  if (needsReferences && !warning) {
    try { refs = await references(ctx); } catch (error) { warning = error.message; }
  }
  const items = [];
  for (const { section, id, record } of records) {
    const versions = versionsOf(record);
    const previous = record.previousVersion || versions.filter((v) => v !== record.version).at(-1);
    for (const version of versions) {
      const entry = section === "packages" ? { name: id, miseTool: id } : section === "harnesses" ? getHarness(id) : getManagedTool(id);
      if (!entry) continue;
      const installation = section === "harnesses" ? harnessInstallationForVersion(entry, version) : entry;
      const tool = installation.miseTool;
      const candidate = refs?.prunable?.[tool]?.find((item) => item.version === version && item.installed);
      const target = candidate?.install_path || null;
      let reason = version === record.version ? "Current version" : !includePrevious && version === previous ? "Previous version" : null;
      if (!reason && warning) reason = "Could not verify references";
      if (!reason && !candidate) reason = "Required by a project or tool selection";
      if (!reason && refs.providers.some((binary) => inside(target, binary))) reason = "Selected by a provider";
      if (!reason && refs.processes.some((process_) => [process_.executable, process_.cwd, ...process_.args].filter(Boolean).some((arg) => {
        const value = arg.startsWith("--") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
        return path.isAbsolute(value) && inside(target, path.resolve(value));
      }))) reason = "Used by a running process";
      if (!reason && !(await ordinaryInstall(ctx, target))) reason = "Install location could not be verified";
      items.push({ id, section, name: entry.name || id, tool, version, path: target, eligible: !reason, reason });
    }
  }
  // Bind consent to the cleanup mode as well as the exact removable set.
  const token = createHash("sha256").update(JSON.stringify({ includePrevious,
    items: items.filter((item) => item.eligible).map(({ section, id, version, tool }) => [section, id, version, tool]),
  })).digest("hex");
  return { enabled: preferences.policy.retainManagedVersions, includePrevious, items, warning, token,
    removableCount: items.filter((item) => item.eligible).length, retainedCount: items.filter((item) => !item.eligible).length };
}

/** Caller holds the harness lock. Cleanup failures never undo a verified
 * installation; failed removals remain recorded for a later retry. */
export async function applyRetention(ctx, plan, { signal, onProgress } = {}) {
  const removed = [], failed = [];
  for (const item of plan.items.filter((candidate) => candidate.eligible)) {
    if (signal?.aborted) break;
    // References and symlink checks are repeated immediately before removal.
    const current = await planRetention(ctx, { includePrevious: plan.includePrevious ?? false });
    if (!current.items.some((candidate) => candidate.section === item.section && candidate.id === item.id && candidate.version === item.version && candidate.eligible)) continue;
    try {
      onProgress?.({ phase: "retaining", tool: item.name, version: item.version });
      await mise.uninstall(ctx, item.tool, item.version);
      const saved = await state.readState(ctx);
      const record = saved[item.section]?.[item.id];
      if (record) await state.updateEntry(ctx, item.section, item.id, {
        managedVersions: versionsOf(record).filter((version) => version !== item.version),
        ...(record.previousVersion === item.version ? { previousVersion: null } : {}),
      });
      removed.push(item);
    } catch { failed.push(item); }
  }
  return { removed, failed, warning: failed.length ? "Some older versions could not be removed. They can be retried from Storage." : plan.warning };
}
