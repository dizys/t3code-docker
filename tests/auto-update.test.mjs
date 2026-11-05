import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLICY,
  POLICY_VERSION,
  normalizePolicy,
  readUpdateState,
  isIdle,
  checkDue,
  busyReason,
  describeKind,
  dueUpdates,
  checkSoftwareUpdates,
} from "../docker/setup/auto-update.mjs";
import { createLatestCache } from "../docker/setup/latest.mjs";

describe("auto-update policy", () => {
  it("defaults every independent kind to off with 3h checks and 30m idle", () => {
    assert.equal(POLICY_VERSION, 2);
    for (const kind of ["providers", "toolchains", "t3"]) {
      assert.equal(DEFAULT_POLICY[kind].enabled, false, kind);
      assert.equal(DEFAULT_POLICY[kind].checkMinutes, 180, kind);
      assert.equal(DEFAULT_POLICY[kind].idleMinutes, 30, kind);
    }
  });

  it("normalizes each kind independently and clamps ranges", () => {
    const policy = normalizePolicy({
      providers: { enabled: false, checkMinutes: 5, idleMinutes: 1000 },
      toolchains: { enabled: true, checkMinutes: 3000, idleMinutes: 1 },
      t3: { enabled: "yes", checkMinutes: 60, idleMinutes: 90 },
    });
    assert.deepEqual(policy.providers, { enabled: false, checkMinutes: 15, idleMinutes: 480 });
    assert.deepEqual(policy.toolchains, { enabled: true, checkMinutes: 1440, idleMinutes: 5 });
    assert.equal(policy.t3.enabled, false);
    assert.equal(policy.t3.checkMinutes, 60);
    assert.equal(policy.t3.idleMinutes, 90);
    assert.equal(policy.t3.stayOnChannel, true);
  });

  it("migrates legacy included toolchains without enabling previously inert updates", () => {
    const active = normalizePolicy({
      providers: { enabled: true, checkMinutes: 120, idleMinutes: 45, includeToolchains: true },
    });
    assert.deepEqual(active.toolchains, { enabled: true, checkMinutes: 120, idleMinutes: 45 });

    const inert = normalizePolicy({
      providers: { enabled: false, checkMinutes: 120, idleMinutes: 45, includeToolchains: true },
    });
    assert.deepEqual(inert.toolchains, { enabled: false, checkMinutes: 120, idleMinutes: 45 });
  });

  it("reads toolchain state and seeds its check time from the legacy shared check", async () => {
    const fs = { readFile: async () => JSON.stringify({ lastProviderCheckAt: 1234, lastResult: "done" }) };
    const state = await readUpdateState(fs, "/state");
    assert.equal(state.lastToolchainCheckAt, 1234);
    assert.equal(state.lastToolchainRunAt, null);
    assert.equal(state.lastProviderAttemptAt, 1234);
    assert.equal(state.lastToolchainAttemptAt, 1234);
  });

  it("rejects non-objects to defaults", () => {
    assert.deepEqual(normalizePolicy(null), JSON.parse(JSON.stringify(DEFAULT_POLICY)));
  });

  it("does not turn an explicitly incomplete toolchain check into provider success", async () => {
    const state = await readUpdateState({ readFile: async () => JSON.stringify({ lastProviderCheckAt: 1234, lastToolchainCheckAt: null, lastToolchainAttemptAt: 1234 }) }, "/state");
    assert.equal(state.lastToolchainCheckAt, null);
    assert.equal(state.lastToolchainAttemptAt, 1234);
  });
});

describe("scheduled software checks", () => {
  const world = () => {
    const w = { clock: 1_800_000_000_000, state: {}, patches: [], calls: [], failed: true, saved: null };
    w.policy = normalizePolicy({ providers: { enabled: true }, toolchains: { enabled: true } });
    w.cache = createLatestCache({
      keys: () => ["harness:claude", "harness:codex", "toolchain:go"],
      lookup: async (key) => {
        w.calls.push(key);
        if (key === "harness:claude" && w.failed) throw new Error("rate limited");
        return "2";
      },
      read: async () => w.saved || "{}", write: async (text) => { w.saved = text; }, now: () => w.clock,
    });
    w.tick = () => checkSoftwareUpdates({ policy: w.policy, state: w.state, cache: w.cache, now: () => w.clock,
      persist: async (patch) => { w.patches.push(patch); Object.assign(w.state, patch); } });
    return w;
  };

  it("keeps healthy sources on schedule and retries only the failed source", async () => {
    const w = world();
    const start = w.clock;
    await w.tick();
    assert.equal(w.state.lastProviderAttemptAt, start);
    assert.equal(w.state.lastProviderCheckAt, undefined);
    assert.equal(w.state.lastToolchainCheckAt, start);
    w.clock += 5 * 60_000;
    await w.tick();
    assert.deepEqual(w.calls, ["harness:claude", "harness:codex", "toolchain:go", "harness:claude"]);
    assert.equal(w.state.lastProviderAttemptAt, start, "retries do not postpone the next scheduled pass");
    assert.equal(w.patches.length, 1, "continued failure writes no successful-check timestamp");
    w.failed = false;
    w.clock += 5 * 60_000;
    await w.tick();
    assert.equal(w.state.lastProviderCheckAt, w.clock, "recovery verifies the provider group");
    assert.equal(w.state.lastToolchainCheckAt, start, "an unrelated retry does not refresh its timestamp");
    w.clock += 60 * 60_000;
    await w.tick();
    assert.equal(w.calls.length, 5, "healthy results are not forced at each auto-update tick");
    assert.equal(w.patches.length, 2);
    w.clock = start + 180 * 60_000;
    await w.tick();
    assert.equal(w.calls.length, 8, "the next full pass follows the configured cadence");
  });

  it("preserves failure backoff and attempt times across a restart", async () => {
    const w = world();
    await w.tick();
    const restored = await readUpdateState({ readFile: async () => JSON.stringify(w.state) }, "/state");
    const calls = [];
    const cache = createLatestCache({ keys: () => ["harness:claude", "harness:codex", "toolchain:go"],
      lookup: async (key) => { calls.push(key); throw new Error("offline"); }, read: async () => w.saved, write: async () => {}, now: () => w.clock });
    const tick = () => checkSoftwareUpdates({ policy: w.policy, state: restored, cache, now: () => w.clock, persist: async () => assert.fail("no successful verification") });
    await tick();
    assert.deepEqual(calls, [], "restart does not bypass failure backoff");
    w.clock += 5 * 60_000;
    await tick();
    assert.deepEqual(calls, ["harness:claude"]);
  });

  it("does nothing when automation is off, and joins no partial background pass", async () => {
    const w = world();
    w.policy = normalizePolicy(null);
    await w.tick();
    assert.deepEqual(w.calls, []);
    w.policy.providers.enabled = true;
    const refresh = w.cache.refresh;
    w.cache.refreshing = () => true;
    w.cache.refresh = () => assert.fail("a running TTL pass cannot count as a scheduled check");
    await w.tick();
    assert.equal(w.patches.length, 0);
    w.cache.refresh = refresh;
  });

  it("tracks success only for enabled groups", async () => {
    const w = world();
    w.policy.providers.enabled = false;
    await w.tick();
    assert.equal(w.state.lastToolchainCheckAt, w.clock);
    assert.equal(w.state.lastProviderAttemptAt, undefined);
    w.clock += 5 * 60_000;
    await w.tick();
    assert.equal(w.calls.length, 3, "a disabled group's failure does not trigger automatic retries");
  });
});

describe("auto-update scheduling", () => {
  it("is due when never checked", () => {
    assert.equal(checkDue({ checkMinutes: 180, lastCheckAt: null, now: 1000 }), true);
  });

  it("is due after the interval", () => {
    const now = 10 * 60_000;
    assert.equal(checkDue({ checkMinutes: 5, lastCheckAt: now - 6 * 60_000, now }), true);
    assert.equal(checkDue({ checkMinutes: 5, lastCheckAt: now - 4 * 60_000, now }), false);
  });

  it("is idle after idleMinutes without activity", () => {
    const now = 1_700_000_000_000;
    assert.equal(isIdle({ idleMinutes: 30, lastActivityAt: now - 31 * 60_000, now }), true);
    assert.equal(isIdle({ idleMinutes: 30, lastActivityAt: now - 29 * 60_000, now }), false);
    assert.equal(isIdle({ idleMinutes: 30, lastActivityAt: null, now }), true);
  });

  it("is never idle while busy", () => {
    const now = 1_700_000_000_000;
    assert.equal(isIdle({ idleMinutes: 30, lastActivityAt: now - 60 * 60_000, now, busy: true }), false);
  });

  it("names the busy reason", () => {
    assert.equal(busyReason({}), null);
    assert.match(busyReason({ lifecycleActive: true }), /already running/);
    assert.match(busyReason({ runtimeBusy: true }), /T3 Code update/);
    assert.match(busyReason({ setupRunning: true }), /First-start/);
  });

  it("describes each kind for the UI", () => {
    assert.equal(describeKind({ enabled: false }), "Off");
    assert.equal(describeKind({ enabled: true, checkMinutes: 180, idleMinutes: 30 }), "On · every 3h · after 30m idle");
  });
});

describe("auto-update due selection", () => {
  const isNewer = (latest, current) => latest > current;
  const base = {
    harnessIds: new Set(["claude", "codex"]),
    skipIds: new Set(["antigravity"]),
    isNewer,
  };

  it("selects installed harnesses with a strictly newer release only", () => {
    const latest = { "harness:claude": "2", "harness:codex": "1", "harness:antigravity": "9" };
    const jobs = dueUpdates({
      ...base,
      harnesses: [
        { id: "claude", installed: true, installedVersion: "1" },
        { id: "codex", installed: true, installedVersion: "1" },
        { id: "antigravity", installed: true, installedVersion: "1" },
        { id: "other", installed: true, installedVersion: "1" },
      ],
      toolchains: null,
      latestFor: (key) => latest[key] ?? null,
    });
    assert.deepEqual(jobs, [{ target: "harness", id: "claude" }]);
  });

  it("skips busy, missing and older-known rows", () => {
    const jobs = dueUpdates({
      ...base,
      harnesses: [
        { id: "claude", installed: true, installedVersion: "2", inProgress: true },
        { id: "codex", installed: true, installedVersion: "3" },
      ],
      toolchains: null,
      latestFor: () => "2",
    });
    assert.deepEqual(jobs, []);
  });

  it("includes toolchains, source control and added tools when asked", () => {
    const latest = { "toolchain:go": "2", "toolchain:glab": "2", "package:npm:prettier": "2", "toolchain:gh": "2" };
    const jobs = dueUpdates({
      ...base,
      harnesses: [],
      toolchains: {
        toolchains: [{ id: "go", installed: true, version: "1" }],
        sourceControl: [{ id: "glab", installed: true, version: "1" }, { id: "gh", installed: true, version: "1", inImage: true }],
        packages: [{ id: "npm:prettier", installed: true, version: "1" }],
      },
      latestFor: (key) => latest[key] ?? null,
    });
    assert.deepEqual(jobs, [
      { target: "toolchain", id: "go" },
      { target: "toolchain", id: "glab" },
      { target: "package", id: "npm:prettier" },
    ]);
  });

  it("never queues an OpenCode update from a cached different major", () => {
    for (const [current, latest, expected] of [['1.19.5', '2.2.5', 0], ['2.2.5', '1.99.0', 0], ['1.19.5', '1.19.6', 1], ['2.2.5', '2.2.6', 1]]) {
      const jobs = dueUpdates({ ...base, harnessIds: new Set(['opencode']), harnesses: [{ id: 'opencode', installed: true, installedVersion: current }], toolchains: null, latestFor: () => latest });
      assert.equal(jobs.length, expected);
    }
  });

  it("falls back to a plain difference when versions cannot be ordered", () => {
    const jobs = dueUpdates({
      ...base,
      isNewer: () => { throw new Error("unparseable"); },
      harnesses: [{ id: "claude", installed: true, installedVersion: "dev-1" }],
      toolchains: null,
      latestFor: () => "dev-2",
    });
    assert.deepEqual(jobs, [{ target: "harness", id: "claude" }]);
  });
});
