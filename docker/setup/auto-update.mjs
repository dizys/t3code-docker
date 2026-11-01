// Smart auto-update policy for providers, toolchains and T3 Code.
//
// The console never updates anything on its own unless this policy says so.
// When enabled, a background pass checks for new releases every
// `checkMinutes` and installs them only after `idleMinutes` without activity.
//
// Activity here means someone is using the server: signed-in setup API
// traffic (an open console or a T3 Code client counts), a lifecycle
// install/update in flight, a T3 Code update/restart in flight, or the
// first-start install running. Agent turns already running inside T3 Code
// are not directly visible to this service, so idle is a client-activity
// signal, not proof that no turn is running.
export const POLICY_VERSION = 2;

export const DEFAULT_POLICY = Object.freeze({
  version: POLICY_VERSION,
  providers: Object.freeze({
    enabled: false,
    // How often to look for new agent releases.
    checkMinutes: 180,
    // Install only after this long without activity.
    idleMinutes: 30,
  }),
  toolchains: Object.freeze({
    enabled: false,
    // Toolchains, source-control CLIs and added tools have their own switch
    // and schedule; they are not an add-on to provider updates.
    checkMinutes: 180,
    idleMinutes: 30,
  }),
  skills: Object.freeze({
    enabled: false,
    // Tracked repository skills that opted into auto-update.
    checkMinutes: 180,
    idleMinutes: 60,
  }),
  t3: Object.freeze({
    enabled: false,
    checkMinutes: 180,
    idleMinutes: 30,
    // Auto-update stays within the selected channel; it never switches
    // Stable <-> Nightly on its own.
    stayOnChannel: true,
  }),
});

const clamp = (value, min, max, fallback) => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

/** Validate user input into a safe policy, keeping unknown fields out. */
export function normalizePolicy(input) {
  const src = input && typeof input === "object" ? input : {};
  const providers = src.providers && typeof src.providers === "object" ? src.providers : {};
  const hasToolchains = !!(src.toolchains && typeof src.toolchains === "object");
  const toolchains = hasToolchains ? src.toolchains : {};
  const skills = src.skills && typeof src.skills === "object" ? src.skills : {};
  const t3 = src.t3 && typeof src.t3 === "object" ? src.t3 : {};
  const normalizedProviders = {
    enabled: providers.enabled === true,
    checkMinutes: clamp(providers.checkMinutes, 15, 1440, DEFAULT_POLICY.providers.checkMinutes),
    idleMinutes: clamp(providers.idleMinutes, 5, 480, DEFAULT_POLICY.providers.idleMinutes),
  };
  return {
    version: POLICY_VERSION,
    providers: normalizedProviders,
    toolchains: {
      // Version 1 nested toolchains under providers. Carry over only updates
      // that actually ran before (providers on + included), with that shared
      // schedule, so upgrading never starts previously inert automation.
      enabled: hasToolchains ? toolchains.enabled === true : normalizedProviders.enabled && providers.includeToolchains === true,
      checkMinutes: clamp(hasToolchains ? toolchains.checkMinutes : normalizedProviders.checkMinutes, 15, 1440, DEFAULT_POLICY.toolchains.checkMinutes),
      idleMinutes: clamp(hasToolchains ? toolchains.idleMinutes : normalizedProviders.idleMinutes, 5, 480, DEFAULT_POLICY.toolchains.idleMinutes),
    },
    skills: {
      enabled: skills.enabled === true,
      checkMinutes: clamp(skills.checkMinutes, 15, 1440, DEFAULT_POLICY.skills.checkMinutes),
      idleMinutes: clamp(skills.idleMinutes, 5, 480, DEFAULT_POLICY.skills.idleMinutes),
    },
    t3: {
      enabled: t3.enabled === true,
      checkMinutes: clamp(t3.checkMinutes, 15, 1440, DEFAULT_POLICY.t3.checkMinutes),
      idleMinutes: clamp(t3.idleMinutes, 5, 480, DEFAULT_POLICY.t3.idleMinutes),
      stayOnChannel: true,
    },
  };
}

export const policyPath = (stateDir) => `${stateDir}/setup/auto-update.json`;
export const statePath = (stateDir) => `${stateDir}/setup/auto-update-state.json`;

export async function readPolicy(fs, stateDir) {
  try {
    const raw = JSON.parse(await fs.readFile(policyPath(stateDir), "utf8"));
    return normalizePolicy(raw);
  } catch {
    return normalizePolicy(null);
  }
}

export async function writePolicy(fs, stateDir, input) {
  const policy = normalizePolicy(input);
  await fs.mkdir(`${stateDir}/setup`, { recursive: true });
  await fs.writeFile(policyPath(stateDir), `${JSON.stringify(policy, null, 2)}\n`);
  return policy;
}

export async function readUpdateState(fs, stateDir) {
  try {
    const raw = JSON.parse(await fs.readFile(statePath(stateDir), "utf8"));
    if (!raw || typeof raw !== "object") throw new Error("bad state");
    const lastProviderCheckAt = Number(raw.lastProviderCheckAt) || null;
    const lastToolchainCheckAt = Object.hasOwn(raw, "lastToolchainCheckAt") ? Number(raw.lastToolchainCheckAt) || null : lastProviderCheckAt;
    return {
      lastProviderCheckAt,
      // Version 1 refreshed one shared latest-release cache for agents and
      // tools, so its provider check is also the last toolchain check.
      lastToolchainCheckAt,
      lastSkillsCheckAt: Number(raw.lastSkillsCheckAt) || null,
      lastProviderAttemptAt: Number(raw.lastProviderAttemptAt) || lastProviderCheckAt,
      lastToolchainAttemptAt: Number(raw.lastToolchainAttemptAt) || lastToolchainCheckAt,
      lastSkillsAttemptAt: Number(raw.lastSkillsAttemptAt) || Number(raw.lastSkillsCheckAt) || null,
      lastT3CheckAt: Number(raw.lastT3CheckAt) || null,
      lastProviderRunAt: Number(raw.lastProviderRunAt) || null,
      lastToolchainRunAt: Number(raw.lastToolchainRunAt) || null,
      lastSkillsRunAt: Number(raw.lastSkillsRunAt) || null,
      lastT3RunAt: Number(raw.lastT3RunAt) || null,
      lastResult: typeof raw.lastResult === "string" ? raw.lastResult.slice(0, 300) : null,
    };
  } catch {
    return { lastProviderCheckAt: null, lastToolchainCheckAt: null, lastSkillsCheckAt: null, lastProviderAttemptAt: null, lastToolchainAttemptAt: null, lastSkillsAttemptAt: null, lastT3CheckAt: null, lastProviderRunAt: null, lastToolchainRunAt: null, lastSkillsRunAt: null, lastT3RunAt: null, lastResult: null };
  }
}

export async function writeUpdateState(fs, stateDir, patch) {
  const current = await readUpdateState(fs, stateDir);
  const next = { ...current, ...patch };
  await fs.mkdir(`${stateDir}/setup`, { recursive: true });
  await fs.writeFile(statePath(stateDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Minutes since `at`, or null when never. */
export const minutesSince = (at, now) => (Number.isFinite(at) && at > 0 ? Math.max(0, (now - at) / 60_000) : null);

/** True when nobody has been active for at least `idleMinutes`. */
export function isIdle({ idleMinutes, lastActivityAt, now = Date.now(), busy = false }) {
  if (busy) return false;
  if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) return true;
  return now - lastActivityAt >= idleMinutes * 60_000;
}

/** True when a periodic check is due (never checked counts as due). */
export function checkDue({ checkMinutes, lastCheckAt, now = Date.now() }) {
  if (!Number.isFinite(lastCheckAt) || lastCheckAt <= 0) return true;
  return now - lastCheckAt >= checkMinutes * 60_000;
}

/**
 * The shared software cache checks every source when either enabled schedule
 * is due. A failed source does not make that whole pass due again: between
 * scheduled passes, retry only failures and honor their per-source backoff.
 * Attempts and successful verification are persisted separately so restarts
 * preserve the cadence without presenting an incomplete check as successful.
 */
export async function checkSoftwareUpdates({ policy, state, cache, persist, now = Date.now }) {
  const groups = [
    { kind: "providers", attempt: "lastProviderAttemptAt", success: "lastProviderCheckAt", owns: (key) => key.startsWith("harness:") },
    { kind: "toolchains", attempt: "lastToolchainAttemptAt", success: "lastToolchainCheckAt", owns: (key) => !key.startsWith("harness:") },
  ].filter((group) => policy[group.kind]?.enabled);
  if (!groups.length) return;
  await cache.load();
  // Do not stamp a scheduled pass as complete by joining a partial TTL pass.
  if (cache.refreshing()) return;
  const due = groups.some((group) => checkDue({ checkMinutes: policy[group.kind].checkMinutes, lastCheckAt: state[group.attempt] ?? state[group.success], now: now() }));
  const before = Object.keys(cache.errors());
  if (!due && !before.some((key) => groups.some((group) => group.owns(key)))) return;
  const checked = await cache.refresh({ force: due, manual: false, failedOnly: !due });
  if (!checked) return;
  const at = now();
  const failures = Object.keys(cache.errors());
  const patch = {};
  for (const group of groups) {
    if (due) patch[group.attempt] = at;
    if ((due || before.some(group.owns)) && !failures.some(group.owns)) patch[group.success] = at;
  }
  if (Object.keys(patch).length) await persist(patch);
}

/** Combine the busy signals the server already tracks into one verdict. */
export function busyReason({ lifecycleActive = false, lifecycleQueued = 0, runtimeBusy = false, setupRunning = false, restarting = false } = {}) {
  if (runtimeBusy) return "T3 Code update in progress";
  if (lifecycleActive) return "An install or update is already running";
  if (lifecycleQueued > 0) return "Updates are queued";
  if (setupRunning) return "First-start install is running";
  if (restarting) return "T3 Code is restarting";
  return null;
}

/**
 * Lifecycle jobs for rows with a newer known release. Pure: the server
 * injects the latest-version cache (`latestFor(key)`) and version ordering
 * (`isNewer(latest, current)`). When ordering is unavailable or throws, a
 * plain string difference counts as due; the lifecycle manager still
 * refuses an actual downgrade. `toolchains` is the manager's toolchain
 * status result, or null to leave toolchains, source-control CLIs and
 * added tools out.
 */
export function dueUpdates({ harnesses = [], toolchains = null, latestFor, isNewer, harnessIds, skipIds = new Set() }) {
  const due = (key, current) => {
    const latest = latestFor(key);
    if (!latest || !current || latest === current) return false;
    try { return isNewer ? isNewer(latest, current) : true; } catch { return true; }
  };
  const jobs = [];
  for (const row of harnesses) {
    if (skipIds.has(row.id) || !harnessIds.has(row.id) || !row.installed || row.inProgress) continue;
    if (due(`harness:${row.id}`, row.installedVersion)) jobs.push({ target: "harness", id: row.id });
  }
  if (toolchains) {
    for (const row of [...(toolchains.toolchains ?? []), ...(toolchains.sourceControl ?? [])]) {
      if (!row.installed || row.inImage || row.inProgress) continue;
      if (due(`toolchain:${row.id}`, row.version)) jobs.push({ target: "toolchain", id: row.id });
    }
    for (const row of toolchains.packages ?? []) {
      if (!row.installed || row.inProgress) continue;
      if (due(`package:${row.id}`, row.version)) jobs.push({ target: "package", id: row.id });
    }
  }
  return jobs;
}

/** Short human summary for the UI, e.g. "On · every 3h · after 30m idle". */
export function describeKind(kind) {
  if (!kind?.enabled) return "Off";
  const every = kind.checkMinutes >= 60 && kind.checkMinutes % 60 === 0
    ? `every ${kind.checkMinutes / 60}h` : `every ${kind.checkMinutes}m`;
  return `On · ${every} · after ${kind.idleMinutes}m idle`;
}
