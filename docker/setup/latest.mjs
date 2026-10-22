// The newest release of each agent and toolchain, so a row can say "2.1.290 is
// available" without anyone asking - and, past that, the newest release mise
// is still holding back for toolchains and added tools. Agent updates take
// new stable releases immediately, without the release-age wait.
//
// `mise latest` asks a registry, which takes a second or two online and up to
// its timeout offline - far too slow and too flaky for a status poll. So it
// runs here in the background, three tools at a time, at most every hour (as
// often as T3 Code checks the same releases), and the answers are kept on the
// state volume so a restart starts warm. A poll only ever reads memory. A
// lookup that fails keeps the last answer: an unreachable registry is not news
// that the update went away.
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 *   keys      () => ["harness:claude", "toolchain:go", ...]
 *   lookup    (key, { fresh }) => Promise<version | { version, newest?, newestAt? }>
 *             (throws when it cannot say)
 *   read      () => Promise<string>       the saved cache, or throws
 *   write     (text) => Promise<void>
 */
/** A lookup's answer as stored: `{ version, at }`, plus `newest`/`newestAt` when mise holds one back. */
const validVersion = (key, version) => key !== "toolchain:rust" || /^\d+\.\d+\.\d+$/.test(version);
const entryOf = (key, answer, at) => {
  const version = String((typeof answer === "object" && answer !== null ? answer.version : answer) ?? "").trim();
  if (!version || !validVersion(key, version)) return null;
  const newest = typeof answer === "object" && answer !== null && typeof answer.newest === "string" ? answer.newest.trim() : "";
  return {
    version,
    at,
    ...(newest && validVersion(key, newest) ? { newest, newestAt: typeof answer.newestAt === "string" ? answer.newestAt : null } : {}),
  };
};

export function createLatestCache({ keys, lookup, read, write, ttlMs = DEFAULT_TTL_MS, retryMs = 60_000, now = Date.now }) {
  let versions = {};          // key -> { version, at, newest?, newestAt? }
  let checkedAt = null;       // when a full pass last finished
  let loaded = null;
  let running = null;
  let runningManual = false;
  let queued = null;
  let failures = {};
  const lookups = new Map();
  let saving = Promise.resolve();

  const load = () => {
    loaded ??= (async () => {
      try {
        const saved = JSON.parse(await read());
        if (saved && typeof saved === "object" && saved.versions && typeof saved.versions === "object") {
          // Discard old Rust channel targets on load, before the first status
          // poll or automatic update pass. Keep a usable numbered answer even
          // if its former held-release metadata contained a rolling alias.
          for (const [key, hit] of Object.entries(saved.versions)) {
            const entry = hit && typeof hit === "object" ? entryOf(key, hit, hit.at) : null;
            if (entry) versions[key] = entry;
          }
          failures = saved.failures && typeof saved.failures === "object" ? saved.failures : {};
          checkedAt = Number.isFinite(saved.checkedAt) ? saved.checkedAt : null;
        }
      } catch { /* nothing saved yet */ }
    })();
    return loaded;
  };

  const lookupOne = async (key, fresh) => {
    // A targeted lookup can overlap a background pass. Only the newest
    // request for this key may publish an answer, including a failure.
    const request = {};
    lookups.set(key, request);
    try {
      const entry = entryOf(key, await lookup(key, { fresh }), now());
      if (lookups.get(key) !== request) return;
      if (!entry) throw new Error("No release version returned");
      versions[key] = entry;
      delete failures[key];
    } catch (error) {
      if (lookups.get(key) === request) failures[key] = { at: now(), error: String(error?.message ?? error).slice(0, 300) };
    } finally {
      if (lookups.get(key) === request) lookups.delete(key);
    }
  };
  const save = () => {
    // Targeted and bulk checks can finish together. Serialize snapshots so
    // a slow older write cannot restore obsolete state after a newer one.
    saving = saving.then(async () => {
      try { await write(JSON.stringify({ checkedAt, versions, failures }, null, 2)); }
      catch { /* a read-only volume still has the answers in memory */ }
    });
    return saving;
  };

  // Manual checks must start a fresh pass if a background pass is already
  // underway: some of its rows may have been read before the button was pressed.
  const refresh = ({ force = false, manual = force, failedOnly = false } = {}) => {
    if (running) {
      if (!manual || runningManual) return running;
      queued ??= running.then(() => {
        queued = null;
        return refresh({ force: true });
      });
      return queued;
    }
    runningManual = manual;
    running = (async () => {
      await load();
      const due = keys().filter((key) => (!failedOnly || failures[key]) && (force || (failures[key]
        ? now() - failures[key].at >= retryMs
        : !versions[key]?.at || now() - versions[key].at >= ttlMs)));
      if (!due.length) return false;
      // A slow source should not block every row behind it. Keep registry
      // traffic bounded even when many user-added tools need checking.
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(3, due.length) }, async () => {
        while (next < due.length) await lookupOne(due[next++], true);
      }));
      checkedAt = now();
      await save();
      return true;
    })().finally(() => { running = null; runningManual = false; });
    return running;
  };

  /**
   * Look one key up now, outside the schedule: a tool just added at an older
   * release should say a newer one exists without waiting for the next pass.
   */
  const refreshOne = async (key) => {
    await load();
    await lookupOne(key, true);
    await save();
  };

  return {
    load,
    refresh,
    refreshOne,
    refreshing: () => Boolean(running || queued),
    manualPending: () => Boolean(runningManual || queued),
    errors: () => Object.fromEntries(keys().filter((key) => failures[key]).map((key) => [key, failures[key].error])),
    /**
     * For a row: `latestVersion` (what mise offers) and `latestCheckedAt`, and
     * `newestVersion`/`newestReleasedAt` for a release out but still held
     * back. Nulls when unknown.
     */
    get: (key) => {
      const hit = versions[key];
      return {
        latestVersion: hit?.version ?? null,
        latestCheckedAt: hit?.at ?? null,
        newestVersion: hit?.newest ?? null,
        newestReleasedAt: hit?.newestAt ?? null,
      };
    },
    checkedAt: () => checkedAt,
  };
}
