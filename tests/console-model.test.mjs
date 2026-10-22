// Unit tests for the setup console's view model (docker/setup/client/model.js).
//
//   node --test tests/console-model.test.mjs
//
// The model is a classic browser script with no DOM: it is loaded here into a
// bare vm context exactly as the page loads it, and driven with /status and
// /ports payloads shaped like the server's. What each row says and offers,
// what readiness asks for next, and what the palette ranks first are all
// decided here, so this is where those rules are pinned.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { compareVersions } from "../docker/harness/version.mjs";

// In the page's order: the route table, then the model that reads it.
const context = vm.createContext({ URL });
for (const file of ["routes.js", "model.js"]) {
  const source = readFileSync(new URL(`../docker/setup/client/${file}`, import.meta.url), "utf8");
  vm.runInContext(source, context, { filename: file });
}
const M = vm.runInContext("T3Model", context);
const R = vm.runInContext("T3Routes", context);
// Objects built inside the vm have their own prototypes; compare as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

const NOW = Date.parse("2026-10-02T12:00:00Z");
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

test("update check controls distinguish background work, manual work, and scoped failures", () => {
  const status = { updates: { refreshing: false, errors: { 'harness:claude': 'offline', 'toolchain:go': 'rate limit' } } };
  assert.equal(M.updateCheckView(status, 'harness').label, 'Review update checks');
  assert.deepEqual(plain(M.updateCheckView(status, 'toolchain').failures), [['toolchain:go', 'rate limit']]);
  status.updates.refreshing = true;
  assert.equal(M.updateCheckView(status, 'harness').checking, true);
  assert.equal(Boolean(M.updateCheckView(status, 'harness').manual), false, 'a background check can be followed by a manual one');
  status.updates.manual = true;
  assert.equal(M.updateCheckView(status, 'harness').manual, true);
  assert.equal(M.updateCheckView(null, 'harness', true).manual, true);
  assert.equal(M.updateCheckView(null, 'harness').label, 'Check for updates');
});

test("opaque row failures have a concise summary without losing their diagnostic", () => {
  const detail = 'Install failed: GitHub rate limit exceeded: https://example.com/' + 'a'.repeat(120);
  const row = { name: 'OpenCode', status: { dot: 'danger', text: detail } };
  assert.deepEqual(plain(M.rowError(row)), { text: 'Source rate limit reached', title: 'OpenCode: install failed', detail });
  assert.equal(row.status.text, detail, 'model facts stay intact for other surfaces');
  assert.equal(M.rowError({ status: { dot: 'danger', text: 'Install failed: disk is full' } }), null, 'short actionable errors stay visible');
  assert.equal(M.rowError({ status: { dot: 'ok', text: detail } }), null);
  const notice = { ...row, notice: { tone: 'danger', text: 'Update failed: Connection timed out\n' + 'x'.repeat(120) } };
  assert.equal(M.rowError(notice, 'notice').text, 'Connection timed out');
  assert.equal(M.rowError(notice).text, 'Source rate limit reached', 'each diagnostic is summarized independently');
  assert.equal(M.rowError({ ...row, notice: { tone: 'danger', text: 'Try again' } }).detail, detail, 'a short notice does not hide a long status diagnostic');
});

test("storage view handles loading, unknown sizes, disk pressure, and job progress", () => {
  assert.equal(M.storageView({}, NOW).loading, true);
  const view = M.storageView({ storage: { at: NOW, disk: { usedPercent: 99, availableBytes: 1000 },
    categories: [{ id: 'go', bytes: 5000, cleanable: true }, { id: 'npm', bytes: null, cleanable: true }, { id: 'history', bytes: 10000 }],
    operation: { state: 'running', phase: 'npm' } } }, NOW);
  assert.deepEqual(plain(view.ids), ['go']); assert.equal(view.cleanableBytes, 5000);
  assert.equal(view.disk.tone, 'danger'); assert.equal(view.busy, true);
  assert.match(view.progress, /npm/); assert.equal(view.cacheRows[1].canClean, false);
  assert.equal(M.storageView({ storage: { disk: { usedPercent: 150 } } }, NOW).disk.usedPercent, 100);
  assert.equal(M.storageView({ storage: { disk: { usedPercent: null } } }, NOW).disk, null);
  assert.equal(M.storageView({ storage: { operation: { state: 'interrupted' } } }, NOW).busy, false);
});

test("storage view lists every detected cache and names the one being cleared", () => {
  const view = M.storageView({ storage: { at: NOW, disk: { usedPercent: 10 },
    categories: [
      { id: 'go', label: 'Go build cache', bytes: 100, cleanable: true, kind: 'cache' },
      { id: 'uv', label: 'uv cache', bytes: 200, cleanable: true, kind: 'cache' },
      { id: 'deno', label: 'Deno cache', bytes: 0, cleanable: false, kind: 'cache', unavailable: 'Install Deno to clean this cache.' },
      { id: 'history', label: 'Threads & agent data', bytes: 300, kind: 'data' },
    ],
    operation: { state: 'running', phase: 'uv' } } }, NOW);
  assert.deepEqual(plain(view.ids), ['go', 'uv']);
  assert.equal(view.cleanableBytes, 300);
  assert.deepEqual(view.cacheRows.map((row) => row.id), ['go', 'uv', 'deno']);
  assert.equal(view.cacheRows[2].canClean, false);
  assert.deepEqual(view.dataRows.map((row) => row.id), ['history']);
  assert.match(view.progress, /uv cache/);
});

test("disk pressure appears in navigation attention and storage is searchable", () => {
  const status = { storage: { disk: { usedPercent: 89 } } };
  assert.equal(M.navBadges(status).storage.count, 1);
  assert.equal(M.navBadges(status).server, null, "the disk is Storage's, not Server's");
  assert.equal(M.navBadges(status).more.count, 1);
  assert.equal(M.navBadges({ storage: { disk: { usedPercent: 79 } } }).storage, null);
  assert.equal(M.diskWarning(status), "warn");
  assert.equal(M.diskWarning({ storage: { disk: { usedPercent: 93 } } }), "danger");
  assert.ok(M.paletteItems(status, null, {}, NOW).some((item) => item.cmd.cmd === 'storage.goto'));
});

const harness = (id, overrides = {}) => ({
  id,
  name: M.AGENTS[id].name,
  supported: true,
  installed: true,
  runnable: true,
  signedIn: true,
  installedVersion: "1.0.0",
  version: "1.0.0",
  latestVersion: null,
  failed: false,
  failure: null,
  operation: null,
  inProgress: false,
  canSignIn: id !== "opencode",
  canSetKey: id === "codex" || id === "opencode",
  managedVersions: ["1.0.0"],
  ...overrides,
});
const toolchain = (id, overrides = {}) => ({
  id, name: M.TOOLCHAINS[id].name, installed: true, version: "1.0.0", latestVersion: null,
  failed: false, failure: null, operation: null, inProgress: false, ...overrides,
});
const statusWith = (overrides = {}) => ({
  server: { ok: true, version: "0.0.44" },
  publicUrl: "https://t3.example.com",
  t3: { port: 3773 },
  harnesses: ["claude", "codex", "opencode", "grok", "cursor"].map((id) => harness(id)),
  toolchains: ["go", "rust", "bun", "deno", "uv"].map((id) => toolchain(id)),
  sessions: [{ sessionId: "s1", client: { label: "iPhone", deviceType: "mobile", os: "iOS" }, connected: true, expiresAt: new Date(NOW + 30 * DAY).toISOString() }],
  pairings: [],
  operations: {},
  setup: { state: "finished", items: [] },
  ...overrides,
});
const ui = (overrides = {}) => ({ busy: new Map(), pending: new Map(), notices: new Map(), portsBusy: new Set(), expandedPorts: new Set(), providerNames: [], signingIn: null, ...overrides });
const row = (status, id, extra) => M.agentRows(status, ui(extra), NOW).find((r) => r.id === id);
const tool = (status, id, extra) => M.toolchainRows(status, ui(extra), NOW).find((r) => r.id === id);

// ------------------------------------------------------------------ formats --

test("versions compare by number, not by text", () => {
  assert.equal(M.compareVersions("2.1.290", "2.1.286"), 1);
  assert.equal(M.compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(M.compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(M.compareVersions("1.2", "1.2.1"), -1);
  assert.equal(M.compareVersions("2026.10.02-abc", "2026.10.01-e373342"), 1);
  assert.equal(M.isNewer("2.1.290", "2.1.286"), true);
  assert.equal(M.isNewer("2.1.286", "2.1.286"), false);
  assert.equal(M.isNewer(null, "2.1.286"), false, "unknown is never an update");
  assert.equal(M.isNewer("2.1.290", null), false);
});

test("the manager and the page agree on stable, preview, build and date versions", () => {
  for (const [left, right, expected] of [
    ["1.2.3", "1.2.3-rc.1", 1],
    ["1.2.3-rc.10", "1.2.3-rc.2", 1],
    ["1.2.3-1", "1.2.3-alpha", -1],
    ["1.2.3+build.2", "1.2.3+build.1", 0],
    ["v1.2.3", "1.2.3", 0],
    ["1.10.0", "1.9.0", 1],
    ["2026.10.02-abc", "2026.10.01-def", 1],
    ["1.4.7-R100.1", "1.4.7-R99.9", 1],
    ["1.4.7-R100.10", "1.4.7-R100.2", 1],
    ["1.4.7-R100", "1.4.7-R100.0", 0],
    ["1.4.7-R100.1", "1.4.7", 0],
    ["1.4.7-R100.1", "1.4.7-rc.1", 1],
  ]) {
    assert.equal(compareVersions(left, right), expected, `${left} vs ${right}`);
    assert.equal(M.compareVersions(left, right), expected, `${left} vs ${right} in the page`);
  }
});

test("relative times read the way a person says them", () => {
  assert.equal(M.relTime(NOW - 10 * 1000, NOW), "just now");
  assert.equal(M.relTime(NOW - 6 * MIN, NOW), "6 min ago");
  assert.equal(M.relTime(NOW - 2 * 60 * MIN, NOW), "2 hours ago");
  assert.equal(M.relTime(NOW - DAY, NOW), "yesterday");
  assert.equal(M.relTime(NOW + 12 * DAY, NOW), "in 12 days");
  assert.equal(M.relTime(NOW + DAY, NOW), "tomorrow");
  assert.equal(M.relTime(null, NOW), "—");
  assert.match(M.relTime(NOW - 90 * DAY, NOW), /^\d{1,2} [A-Z][a-z]{2}$/, "far away reads as a date");
});

test("sizes, durations and countdowns", () => {
  assert.equal(M.formatBytes(512), "512 B");
  assert.equal(M.formatBytes(148_000_000), "148 MB");
  assert.equal(M.formatBytes(4_402_341_888), "4.4 GB");
  assert.equal(M.formatBytes(undefined), "—");
  assert.equal(M.duration(45), "45 seconds");
  assert.equal(M.duration(3 * 86400), "3 days");
  assert.equal(M.countdown(14 * MIN + 32 * 1000), "14:32");
  assert.equal(M.countdown(-5), "0:00");
  assert.equal(M.listOf(["Grok Build", "Cursor"]), "Grok Build and Cursor");
  assert.equal(M.listOf(["A", "B", "C"]), "A, B and C");
});

test("progress has a percentage only when the total is known", () => {
  assert.deepEqual(plain(M.progressOf({ phase: "downloading", done: 155_000_000, total: 250_000_000 })),
    { phase: "downloading", pct: 62, done: 155_000_000, total: 250_000_000 });
  assert.equal(M.progressOf({ phase: "verifying" }).pct, null);
  assert.equal(M.progressText(M.progressOf({ phase: "x", done: 148_000_000, total: 238_000_000 })), "62% · 148 of 238 MB");
  assert.equal(M.progressText(M.progressOf({ phase: "x", done: 900_000, total: 1_200_000 })), "75% · 900 kB of 1.2 MB");
  assert.equal(M.progressText(M.progressOf({ phase: "x" })), "");
});

// --------------------------------------------------------------- agent rows --

test("a row shows exactly the one verb its state calls for", () => {
  const s = statusWith({
    harnesses: [
      harness("claude", { latestVersion: "1.1.0" }),
      harness("codex", { authMethod: "apikey" }),
      harness("opencode"),
      harness("grok", { signedIn: false }),
      harness("cursor", { installed: false, runnable: false, signedIn: null, installedVersion: null, version: null }),
    ],
  });
  const claude = row(s, "claude");
  assert.equal(claude.state, "update");
  assert.equal(claude.action.cmd, "harness.update");
  assert.equal(claude.status.text, "Signed in", "the version says there is a newer one; the status does not repeat it");
  assert.equal(claude.menu[0].label, "Update to 1.1.0");

  const codex = row(s, "codex");
  assert.equal(codex.action, null, "signed in and current: menu only");
  assert.equal(codex.status.text, "Signed in with an API key");
  assert.ok(codex.menu.some((m) => m.label === "Use an API key…"));

  const opencode = row(s, "opencode");
  assert.equal(opencode.action.label, "Add key", "OpenCode keeps Add key visible");
  assert.notEqual(opencode.action.variant, "primary");

  const grok = row(s, "grok");
  assert.equal(grok.state, "signin");
  assert.equal(grok.action.cmd, "harness.signin");
  assert.equal(grok.action.variant, "primary");
  assert.deepEqual(plain(grok.status), { dot: "warn", text: "Not signed in" });
  assert.equal(grok.attention, true);

  const cursor = row(s, "cursor");
  assert.equal(cursor.state, "missing");
  assert.equal(cursor.action.cmd, "harness.install");
  assert.deepEqual(plain(cursor.menu.map((m) => m.cmd)), ["harness.version"]);

  for (const r of M.agentRows(s, ui(), NOW)) {
    const last = r.menu[r.menu.length - 1];
    if (r.state !== "missing") assert.equal(last.cmd, "harness.uninstall", `${r.id}: uninstall is last`);
    if (r.state !== "missing") assert.equal(last.danger, true);
  }
});

test("Muse offers opt-in install, sign-in and updates without claiming saved credentials are verified", () => {
  const at = (overrides) => row(statusWith({ harnesses: [harness("muse", { canSetKey: true, ...overrides })] }), "muse");
  const missing = at({ installed: false, runnable: false, version: null, installedVersion: null });
  assert.equal(missing.name, "Muse Code");
  assert.equal(missing.action.cmd, "harness.install");
  assert.equal(missing.status.text, "Not installed · requires T3 Code Nightly");
  assert.equal(missing.attention, false, "an optional agent is not a setup problem");
  const signedOut = at({ signedIn: false });
  assert.equal(signedOut.action.cmd, "harness.signin");
  assert.ok(signedOut.menu.some((item) => item.cmd === "harness.apikey"));
  const saved = at({ signedIn: null, credentialsPresent: true });
  assert.equal(saved.status.text, "Credentials saved, checked when you first use it");
  assert.equal(saved.attention, false);
  const update = at({ signedIn: null, credentialsPresent: true, installedVersion: "1.4.7-R99.1", latestVersion: "1.4.7-R100.1" });
  assert.equal(update.action.cmd, "harness.update");
  assert.equal(update.updateAvailable, true);
  const newer = at({ signedIn: null, installedVersion: "1.4.7-R100.1", latestVersion: "1.4.7-R99.1" });
  assert.equal(newer.updateAvailable, false);
});

test("OpenCode v2 releases can be found by major prefix, preserving release-age and minimum-version markers", () => {
  const releases = [
    { version: "2.0.28", waiting: true, supported: true, requiresNightly: true },
    { version: "2.0.27", supported: true, requiresNightly: true },
    { version: "2.0.17", supported: false, requiresNightly: true },
    { version: "1.19.0", supported: true },
  ];
  assert.deepEqual(plain(M.matchReleases(releases, "2")).map(r => r.version), ["2.0.28", "2.0.27", "2.0.17"]);
  assert.equal(M.resolveRelease(releases, "2"), "2.0.27");
  assert.equal(M.resolveRelease(releases, "2.0.28"), "2.0.28");
  assert.equal(M.resolveRelease(releases, "1"), "1.19.0");
});

test("OpenCode names saved providers without calling browser accounts API keys", () => {
  const s = statusWith();
  assert.equal(row(s, "opencode", { providerNames: ["Anthropic", "DeepSeek"] }).status.text, "Keys saved for Anthropic and DeepSeek");
  assert.equal(row(s, "opencode", { providerNames: ["Anthropic"] }).status.text, "Key saved for Anthropic");
});

test("work in flight replaces the verb with progress and, for our own work, Cancel", () => {
  const s = statusWith({
    harnesses: [harness("claude", { latestVersion: "1.1.0" }), harness("codex"), harness("opencode"), harness("grok"), harness("cursor")],
    operations: { "harness:claude": { kind: "update", state: "running", progress: { phase: "installing" } } },
  });
  const claude = row(s, "claude");
  assert.equal(claude.state, "running");
  assert.equal(claude.kind, "update");
  assert.equal(claude.badge.text, "Updating");
  assert.equal(claude.versionTo, "1.1.0");
  assert.equal(claude.status.text, "1.0.0 keeps working until this finishes");
  assert.equal(claude.progress.phase, "installing");
  assert.equal(claude.action.cmd, "op.cancel");

  // Started elsewhere (t3-harness, a restart): shown, but not ours to cancel.
  const elsewhere = row(statusWith({ harnesses: [harness("claude", { inProgress: true, operation: "install" })] }), "claude");
  assert.equal(elsewhere.state, "running");
  assert.equal(elsewhere.cancellable, false);
  assert.equal(elsewhere.action, null);

  // A click still in flight shows the kind it asked for.
  const busy = row(statusWith(), "grok", { busy: new Map([["harness:grok", "uninstall"]]) });
  assert.equal(busy.badge.text, "Removing");
});

test("queued work says why it waits, and only our own queue can be cancelled", () => {
  const queued = row(statusWith({ operations: { "harness:grok": { kind: "install", state: "queued" } } }), "grok",
    { pending: new Map([["harness:grok", { kind: "install" }]]) });
  assert.equal(queued.state, "queued", "a pending click that the server queued is not shown as running");
  assert.equal(queued.action.cmd, "op.cancel");

  const firstStart = statusWith({
    harnesses: [harness("grok", { installed: false, runnable: false, signedIn: null })],
    setup: { state: "running", items: [{ kind: "agent", id: "grok", name: "Grok Build", state: "pending" }] },
  });
  const pending = row(firstStart, "grok");
  assert.equal(pending.state, "queued");
  assert.equal(pending.action, null);
  assert.equal(pending.status.text, "First start installs it in the background");
});

test("failures keep the row usable and say what happened", () => {
  const s = statusWith({
    harnesses: [
      harness("claude", { failed: true, failure: "network down", operation: "update" }),
      harness("codex", { runnable: false, failure: "Illegal instruction" }),
      harness("opencode", { installed: false, runnable: false, signedIn: null, failed: true, failure: "404", operation: "install" }),
      harness("grok", { supported: false, installed: false }),
      harness("cursor", { signedIn: null }),
    ],
  });
  const claude = row(s, "claude");
  assert.equal(claude.state, "failed");
  assert.equal(claude.action.label, "Retry");
  assert.equal(claude.action.variant, "warning");
  assert.deepEqual(plain(claude.status), { dot: "danger", text: "Update failed: network down" });
  assert.equal(row(s, "codex").action.label, "Reinstall");
  assert.deepEqual(plain(row(s, "opencode").status), { dot: "danger", text: "Install failed: 404" });
  assert.equal(row(s, "grok").state, "unsupported");
  assert.equal(row(s, "grok").action, null);
  assert.equal(row(s, "cursor").status.text, "Couldn’t check its sign-in");
});

test("the row being signed in says so and offers nothing else", () => {
  const signing = row(statusWith({ harnesses: [harness("grok", { signedIn: false })] }), "grok", { signingIn: "grok" });
  assert.equal(signing.state, "signing");
  assert.equal(signing.badge.text, "Signing in");
  assert.equal(signing.status.text, "Waiting for approval on another device");
  assert.equal(signing.action, null);
  assert.equal(signing.menu.length, 0);
});

test("a row's own error stays on it until the next action", () => {
  const r = row(statusWith(), "codex", { notices: new Map([["harness:codex", { tone: "danger", text: "boom" }]]) });
  assert.deepEqual(plain(r.notice), { tone: "danger", text: "boom" });
});

// ----------------------------------------------------------- toolchain rows --

test("toolchains follow the same rules without sign-in", () => {
  const s = statusWith({
    toolchains: [
      toolchain("go", { latestVersion: "1.0.0" }),
      toolchain("rust", { latestVersion: "1.98.1", inProgress: true, operation: "update" }),
      toolchain("bun", { latestVersion: "1.0.1" }),
      toolchain("deno"),
      toolchain("uv", { installed: false, version: null }),
    ],
    setup: { state: "finished", items: [{ kind: "toolchain", id: "go", state: "done" }] },
  });
  // Each wears its own project's mark.
  assert.deepEqual(plain(M.toolchainRows(s, ui(), NOW).map((r) => r.mark)), ["go", "rust", "bun", "deno", "uv"]);
  assert.equal(tool(s, "go").status.text, "Up to date");
  const rust = tool(s, "rust");
  assert.equal(rust.state, "running");
  assert.equal(rust.versionTo, "1.98.1");
  assert.equal(rust.status.text, "With clippy and rustfmt · 1.0.0 keeps working until this finishes");
  assert.equal(tool(s, "bun").action.cmd, "toolchain.update");
  assert.equal(tool(s, "deno").status.text, "Installed", "no claim about updates when the latest is unknown");
  const uv = tool(s, "uv");
  assert.equal(uv.state, "missing");
  assert.equal(uv.dim, true);
  assert.deepEqual(plain(uv.status), { dot: null, text: "Not installed · left out of", code: "T3_PREINSTALL" });
  assert.equal(tool(statusWith({ toolchains: [toolchain("uv", { installed: false })], setup: { state: "off", items: [] } }), "uv").status.text, "Not installed");
});

// ---------------------------------------------------------------- readiness --

test("readiness has exactly one next step, and collapses when everything is done", () => {
  const cases = [
    statusWith({ server: { ok: false, detail: "ECONNREFUSED" }, publicUrl: null, sessions: [] }),
    statusWith({ publicUrl: null, sessions: [] }),
    statusWith({ sessions: [] }),
    statusWith({ harnesses: [harness("grok", { signedIn: false }), harness("cursor", { signedIn: false })] }),
    statusWith(),
  ];
  const nexts = cases.map((s) => M.readiness(s, ui()).next);
  assert.deepEqual(nexts, ["server", "url", "pair", "agents", null]);
  for (const s of cases) {
    const r = M.readiness(s, ui());
    assert.ok(r.steps.filter((step) => step.state === "todo").length <= 1, "never two todos");
    const primaries = r.steps.filter((step) => step.action && step.action.variant === "primary");
    assert.equal(primaries.length, r.ready ? 0 : r.steps.find((step) => step.state === "todo").action ? 1 : 0, "one primary at most");
  }
  assert.equal(M.readiness(cases[4], ui()).ready, true);
  assert.equal(M.readiness(cases[4], ui()).title, "Ready");
});

test("the agents step finishes once an agent can work, and is never left without a way forward", () => {
  const step = (s) => plain(M.readiness(s, ui()).steps.find((x) => x.id === "agents"));
  // Muse's sign-in is only checked on first use: saved credentials count, so a
  // server whose only agent is Muse is set up rather than stuck at three of four.
  const museOnly = statusWith({ harnesses: [harness("muse", { signedIn: null, credentialsPresent: true })] });
  assert.equal(step(museOnly).done, true);
  assert.equal(M.readiness(museOnly, ui()).ready, true);
  const alongside = statusWith({ harnesses: [harness("claude"), harness("muse", { signedIn: null, credentialsPresent: true })] });
  assert.equal(step(alongside).done, true, "Muse beside a signed-in agent does not hold the step open");
  // A sign-in that could not be checked at all is no proof: the step waits,
  // says why, and offers the way to the agents.
  const unreadable = step(statusWith({ harnesses: [harness("claude", { signedIn: null, credentialsPresent: false })] }));
  assert.equal(unreadable.done, false);
  assert.match(unreadable.desc, /Couldn’t check whether Claude Code is signed in/);
  assert.deepEqual(unreadable.action, { cmd: "goto", route: "agents", label: "Open agents", variant: "primary" });
  // Every step that is not done offers something, except while the first start
  // is still installing the agents it is waiting for.
  const states = [
    statusWith({ harnesses: [] }),
    statusWith({ harnesses: [harness("claude", { signedIn: false })] }),
    statusWith({ harnesses: [harness("claude", { installed: false, version: null, installedVersion: null })] }),
  ];
  for (const s of states) {
    for (const x of plain(M.readiness(s, ui()).steps)) if (!x.done) assert.ok(x.action, `${x.id} has a next step`);
  }
  const installing = step(statusWith({ harnesses: [harness("claude", { installed: false, version: null, installedVersion: null })], setup: { state: "running", items: [] } }));
  assert.equal(installing.action, null);
  assert.match(installing.desc, /still installing/);
});

test("the public URL step offers this page's address when T3 Code answers on it, and a form otherwise", () => {
  const unset = statusWith({ publicUrl: null, publicUrlSource: null, sessions: [] });
  const step = (s, extra) => plain(M.readiness(s, ui(extra)).steps.find((x) => x.id === "url"));

  const plainStep = step(unset);
  assert.deepEqual(plainStep.action, { cmd: "url.edit", label: "Set address", icon: "globe", variant: "primary" });
  assert.equal(plainStep.alt, undefined);
  assert.match(plainStep.desc, /the address your phone or browser uses/);

  const offered = step(unset, { here: { url: "https://t3.example.net", local: false } });
  assert.deepEqual(offered.action, { cmd: "url.use", label: "Use t3.example.net", icon: "check", variant: "primary" });
  assert.deepEqual(offered.alt, { cmd: "url.edit", label: "Other address" }, "another address is one click away");
  assert.match(offered.desc, /open at t3\.example\.net, and T3 Code answers there too/);

  const local = step(unset, { here: { url: "http://localhost:8080", local: true } });
  assert.equal(local.action.cmd, "url.edit", "localhost is not offered as the one-tap answer");
  assert.match(local.desc, /localhost:8080 only opens on this computer/);

  const fromPlatform = step(statusWith({ publicUrl: "https://t3.up.railway.app", publicUrlSource: "platform", publicUrlPlatform: { url: "https://t3.up.railway.app", platform: "Railway" } }));
  assert.equal(fromPlatform.done, true);
  assert.equal(fromPlatform.aside, "from Railway");
  assert.equal(fromPlatform.action, null);
  assert.equal(step(statusWith({ publicUrlSource: "env" })).aside, "T3_PUBLIC_URL");
  assert.equal(step(statusWith({ publicUrlSource: "saved" })).aside, "set here");
});

test("this page's address is only offered when it would change something", () => {
  const here = { url: "https://t3.example.com", local: false };
  assert.equal(M.hereOffer(statusWith({ publicUrl: "https://t3.example.com" }), ui({ here })), null, "already the public URL");
  assert.deepEqual(plain(M.hereOffer(statusWith({ publicUrl: "https://old.example.com" }), ui({ here }))), here);
  assert.equal(M.hereOffer(statusWith(), ui()), null, "not confirmed to be T3 Code's");
});

test("the palette sets or changes the public URL, unless T3_PUBLIC_URL pins it", () => {
  const find = (s, label) => plain(M.paletteItems(s, null, ui(), NOW)).find((item) => item.label === label);
  const set = find(statusWith({ publicUrl: null, publicUrlSource: null }), "Set public URL");
  assert.equal(set.cmd.cmd, "url.edit");
  assert.equal(set.attention, true);
  const change = find(statusWith({ publicUrlSource: "saved" }), "Change public URL");
  assert.equal(change.meta.text, "set here");
  assert.equal(find(statusWith({ publicUrlSource: "env" }), "Change public URL"), undefined);
});

test("the palette shows the setup key, and replaces it unless T3_SETUP_KEY sets it", () => {
  const labels = (s) => plain(M.paletteItems(s, null, ui(), NOW)).filter((item) => /setup key/.test(item.label)).map((item) => `${item.label} -> ${item.cmd.cmd}`);
  assert.deepEqual(labels(statusWith({ setupKeySource: "volume" })), ["Show setup key -> key.show", "Replace setup key -> key.replace"]);
  assert.deepEqual(labels(statusWith({ setupKeySource: "env" })), ["Show setup key -> key.show"]);
});

test("T3 Connect reads as one state with at most one next step", () => {
  const view = (connect, t3 = { port: 3773, pid: 42 }) => plain(M.connectView(statusWith({ connect, t3 })));
  const saved = (over) => ({ state: "off", desired: false, authenticated: false, linked: false, relayHost: null, startedSinceLink: null, ...over });

  const off = view(saved());
  assert.equal(off.state, "off");
  assert.deepEqual(off.action, { cmd: "connect.setup", label: "Set up", icon: "globe" });
  assert.match(off.text, /no domain or tunnel of your own/);

  const restart = view(saved({ state: "pending", desired: true, authenticated: true }));
  assert.equal(restart.state, "restart");
  assert.equal(restart.action.cmd, "connect.restart");
  assert.equal(view(saved({ state: "pending", desired: true, authenticated: true, startedSinceLink: false })).state, "restart",
    "signed in after T3 Code last started: it still needs one");

  const unsupervised = view(saved({ state: "pending", desired: true, authenticated: true }), { port: 3773, pid: null });
  assert.equal(unsupervised.action, null, "no button this page cannot carry out");
  assert.match(unsupervised.text, /restart the container/);

  const linking = view(saved({ state: "pending", desired: true, authenticated: true, startedSinceLink: true }));
  assert.equal(linking.state, "linking", "T3 Code has started since: another restart would only interrupt it");
  assert.equal(linking.action, null);
  assert.equal(linking.badge.spinner, true);

  const on = view(saved({ state: "on", desired: true, authenticated: true, linked: true, relayHost: "relay.t3.codes" }));
  assert.equal(on.state, "on");
  assert.match(on.text, /through relay\.t3\.codes\./);
  assert.equal(on.action, null, "on, nothing is owed: turning it off is in its menu");
  assert.deepEqual(on.menu.map((m) => m.cmd), ["connect.off"]);
  assert.equal(on.menu[0].danger, true);

  assert.equal(view(saved({ state: "signin", desired: true })).action.cmd, "connect.setup");
  assert.deepEqual(view(null), { state: "unknown", badge: null, text: "Couldn’t read its state just now.", action: null });
});

test("the palette offers what T3 Connect needs next, and a restart when T3 Code can take one", () => {
  const labels = (s) => plain(M.paletteItems(s, null, ui(), NOW)).filter((i) => /T3 Connect|Restart T3 Code/.test(i.label)).map((i) => i.label);
  const t3 = { port: 3773, pid: 42 };
  assert.deepEqual(labels(statusWith({ t3, connect: { state: "off" } })), ["Set up T3 Connect", "Restart T3 Code"]);
  assert.deepEqual(labels(statusWith({ t3, connect: { state: "pending" } })), ["Restart T3 Code to turn T3 Connect on", "Restart T3 Code"]);
  assert.deepEqual(labels(statusWith({ t3, connect: { state: "on" } })), ["Turn T3 Connect off", "Restart T3 Code"]);
  assert.deepEqual(labels(statusWith({ t3: { port: 3773 }, connect: { state: "on" } })), ["Turn T3 Connect off"], "no restart without the supervisor");
});

test("a later step that needs the user is a warning, not a second todo", () => {
  const s = statusWith({ sessions: [], harnesses: [harness("grok", { signedIn: false }), harness("cursor", { signedIn: false })] });
  const r = M.readiness(s, ui());
  assert.equal(r.next, "pair");
  const agents = r.steps.find((step) => step.id === "agents");
  assert.equal(agents.state, "warn");
  assert.equal(agents.desc, "Grok Build and Cursor are installed but not signed in.");
  assert.equal(agents.action.label, "Sign in");
  assert.notEqual(agents.action.variant, "primary");
  assert.equal(r.title, "Pair your first device");
  assert.equal(r.done, 2);
});

test("the ready summary counts what is set up and what still wants a look", () => {
  const s = statusWith({ sessions: [{ sessionId: "a" }, { sessionId: "b" }] });
  // A count keeps its noun on the same line.
  assert.equal(M.readySummary(s, ui()), "2\u00a0devices paired · 5\u00a0agents signed in · 5\u00a0toolchains · nothing needs you");
  const signedOut = statusWith({ harnesses: [harness("claude", { signedIn: false })] });
  assert.match(M.readySummary(signedOut, ui()), /1\u00a0thing needs you$/);
  const update = statusWith({ harnesses: [harness("claude", { latestVersion: "2.0.0" })] });
  assert.match(M.readySummary(update, ui()), /nothing needs you$/, "an update is offered, not owed");
});

// ------------------------------------------------------ attention and badges --

test("needs-you lists failures before sign-ins, and leaves updates to the Updates page", () => {
  const s = statusWith({
    harnesses: [
      harness("claude", { latestVersion: "2.0.0" }),
      harness("codex", { signedIn: false }),
      harness("opencode", { failed: true, failure: "x", operation: "update" }),
      harness("grok"),
      harness("cursor"),
    ],
  });
  assert.deepEqual(plain(M.needsYou(s, null, ui()).map((r) => r.id)), ["opencode", "codex"]);
});

test("needs-you names the container's own problems, each with the one thing to do", () => {
  const s = statusWith({
    paths: { volumeKind: "anonymous", stateKind: "durable" },
    storage: { disk: { usedPercent: 91, availableBytes: 9e9 } },
    legacyEnv: ["GOROOT", "PATH"],
    harnesses: [harness("codex", { signedIn: false })],
    t3: { port: 3773, pid: 7, runtime: { channel: "stable", version: "0.1.0", releases: {}, operation: { phase: "rolled-back", error: "The new version did not start.\nlog: …" } } },
    connect: { state: "pending" },
  });
  const items = plain(M.needsYou(s, null, ui()));
  assert.deepEqual(items.map((i) => i.id), ["home", "disk", "codex", "legacy", "runtime", "connect"], "anything lost or nearly full first, then the rest in page order");
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(by.home.action, { cmd: "volume.fix", id: "home", label: "How to fix" });
  assert.match(by.home.text, /anonymous volume/);
  assert.equal(by.disk.tone, "danger");
  assert.equal(by.disk.name, "The disk is 91% full");
  assert.deepEqual(by.disk.action, { cmd: "goto", route: "storage", label: "Free up space" });
  assert.match(by.legacy.text, /^GOROOT is still set/);
  assert.equal(by.runtime.text, "The new version did not start.", "only the first line of a long error");
  assert.equal(by.connect.action.cmd, "connect.restart");
  const failedPort = { available: true, listening: [8080], tunnels: [{ port: 8080, state: "failed", error: "edge" }] };
  const port = plain(M.needsYou(statusWith(), failedPort, ui()))[0];
  assert.deepEqual([port.name, port.text, port.action.cmd, port.action.id], ["Port 8080 couldn’t be published", "edge", "port.publish", "8080"]);
  assert.deepEqual(plain(M.needsYou(statusWith(), null, ui())), [], "nothing wrong, nothing listed");
});

test("navigation badges count what needs the user, and only mark what is running or live", () => {
  const s = statusWith({
    harnesses: [harness("grok", { signedIn: false }), harness("cursor", { signedIn: false }), harness("claude")],
    toolchains: [toolchain("rust", { inProgress: true, operation: "update" }), toolchain("go")],
  });
  const ports = { available: true, listening: [3000, 5173], tunnels: [{ port: 3000, state: "open", url: "https://a.trycloudflare.com" }] };
  const b = M.navBadges(s, ports, ui());
  assert.deepEqual(plain(b.agents), { tone: "warn", count: 2 });
  assert.deepEqual(plain(b.toolchains), { tone: "info", kind: "running", count: 1 });
  assert.deepEqual(plain(b.ports), { tone: "info", kind: "live", count: 1 });
  assert.equal(b.access, null, "how many devices there are is the page's to say, not the sidebar's");
  assert.equal(M.navBadges(statusWith(), null, ui()).agents, null, "nothing to say, no mark");
  const failedPort = { available: true, listening: [8080], tunnels: [{ port: 8080, state: "failed", error: "edge" }] };
  assert.deepEqual(plain(M.navBadges(s, failedPort, ui()).ports), { tone: "warn", count: 1 });
});

test("the count T3 Code shows beside Setup is what needs the user, not what could be updated", () => {
  const s = statusWith({
    harnesses: [
      harness("claude", { latestVersion: "2.0.0" }),
      harness("codex", { signedIn: false }),
      harness("opencode", { failed: true, failure: "x", operation: "update" }),
      harness("grok"),
      harness("cursor"),
    ],
    toolchains: [toolchain("go", { failed: true, failure: "y", operation: "update" }), toolchain("rust", { latestVersion: "9.9.9" })],
    legacyEnv: ["GOROOT"],
  });
  // codex signed out, opencode failed, go failed, an old image's setting:
  // four. Claude's and Rust's updates are offered, not owed.
  assert.equal(M.attentionCount(s, null, ui()), 4);
  assert.equal(M.needsYou(s, null, ui()).length, 4, "the Overview lists the same four");
  const failedPort = { available: true, listening: [8080], tunnels: [{ port: 8080, state: "failed", error: "edge" }] };
  assert.equal(M.attentionCount(s, failedPort, ui()), 5, "a port that would not publish counts when ports are known");
  assert.equal(M.attentionCount(statusWith(), null, ui()), 0);
  assert.equal(M.attentionCount(statusWith(), null, null), 0, "the server asks without any page state");
});

test("a backend half typed gets what goes after the colon, and a spec to finish it with", () => {
  assert.deepEqual({ ...M.specPrefix("npm:") }, { backend: "npm", noun: "package", example: "npm:prettier" });
  assert.deepEqual({ ...M.specPrefix(" cargo: ") }, { backend: "cargo", noun: "crate", example: "cargo:ripgrep" });
  assert.deepEqual({ ...M.specPrefix("github:") }, { backend: "github", noun: "owner/repo", example: "github:cli/cli" });
  assert.deepEqual({ ...M.specPrefix("pnpm:") }, { backend: "pnpm", noun: null, example: null }, "a backend it has no example for");
  for (const q of ["npm", "npm:prettier", "npm::", ":", "NPM:", "", "foo bar:"]) assert.equal(M.specPrefix(q), null, q);
  // Every example is a spec the search itself would offer.
  for (const spec of [...M.SPEC_SAMPLES, "npm:prettier", "go:golang.org/x/tools/gopls"]) assert.ok(M.isToolSpec(spec), spec);
});

// --------------------------------------------------------------------- ports --

test("port rows join what listens with what is published, and spot databases", () => {
  const ports = {
    available: true,
    listening: [5432, 3000, 5173],
    details: [{ port: 3000, process: "next-server", address: "127.0.0.1" }, { port: 5173, process: "vite", address: "0.0.0.0" }],
    tunnels: [{ port: 3000, state: "open", url: "https://q.trycloudflare.com", startedAt: NOW - 6 * MIN }, { port: 8080, state: "failed", error: "edge" }],
  };
  const rows = M.portRows(ports, ui({ expandedPorts: new Set([3000, 5173]) }), NOW);
  assert.deepEqual(plain(rows.map((r) => [r.port, r.state])), [[3000, "open"], [5173, "idle"], [5432, "idle"], [8080, "failed"]]);
  assert.equal(rows[0].expanded, true);
  assert.equal(rows[1].expanded, false, "only a published port expands");
  assert.equal(rows[2].db, true, "5432 asks before publishing");
  assert.equal(rows[1].db, false);
  assert.equal(rows[3].listening, false);
  assert.equal(M.portRows({ listening: [7000], tunnels: [] }, ui({ portsBusy: new Set([7000]) }), NOW)[0].state, "starting");
  assert.equal(M.looksLikeDatabase(6000, "redis-server"), true);
});

// ------------------------------------------------------------------- devices --

test("devices read as what they are and when they were last seen", () => {
  const rows = M.deviceRows([
    { sessionId: "a", client: { label: "iPhone", deviceType: "mobile", os: "iOS", browser: "Safari" }, connected: false, lastConnectedAt: new Date(NOW - 2 * 60 * MIN).toISOString(), expiresAt: new Date(NOW + 12 * DAY).toISOString() },
    { sessionId: "b", client: { label: "work-laptop", deviceType: "desktop", os: "macOS" }, connected: true },
    { sessionId: "c", client: { deviceType: "mobile" } },
    { sessionId: "d", subject: "one-time-token", client: { deviceType: "desktop", os: "Linux", browser: "Chrome" }, connected: true },
    { sessionId: "e", subject: "build-bot", client: { os: "Linux" } },
  ], NOW);
  assert.equal(rows[0].status, "Safari on iOS · seen 2 hours ago");
  assert.equal(rows[0].ends, "session ends in 12 days");
  assert.equal(rows[0].icon, "smartphone");
  assert.equal(rows[1].status, "macOS desktop app · active now");
  assert.equal(rows[1].icon, "laptop");
  assert.equal(rows[2].name, "Mobile app", "no label: what it is");
  assert.equal(rows[2].label, "", "the rename field does not mistake a device kind for a saved label");
  assert.equal(rows[2].status, "not connected yet", "and not said twice");
  assert.equal(rows[3].name, "Chrome on Linux", "how T3 paired it is not a name");
  assert.equal(rows[3].status, "active now");
  assert.equal(rows[4].name, "build-bot", "a subject someone chose is");
  assert.equal(M.deviceName({ subject: "one-time-token", client: { browser: "Safari", os: "iOS" } }), "Safari on iOS");
  assert.equal(M.deviceName({ client: { label: "iPhone" } }), "iPhone");
  assert.equal(M.deviceName(null), "Client");
});

test("a saved device label wins over native labels and subjects throughout Setup", () => {
  const session = { sessionId: "phone", setupLabel: "Work phone", label: "CLI label", subject: "build-bot", client: { label: "iPhone", browser: "Safari", os: "iOS" } };
  assert.equal(M.deviceName(session), "Work phone");
  const row = M.deviceRows([session], NOW)[0];
  assert.equal(row.name, "Work phone");
  assert.equal(row.label, "Work phone");
  assert.match(row.status, /^Safari on iOS/);
  assert.equal(M.deviceName({ ...session, setupLabel: undefined }), "iPhone", "removing the override restores the native name");
});

// ------------------------------------------------------------------- palette --

test("the palette puts what needs the user first, then everything by group", () => {
  const s = statusWith({ harnesses: [harness("grok", { signedIn: false }), harness("claude", { latestVersion: "2.0.0" }), harness("codex")] });
  const items = M.paletteItems(s, { available: true, listening: [5173], tunnels: [] }, ui(), NOW);
  const ranked = M.searchPalette(items, "");
  assert.equal(ranked[0].group, "Needs you");
  assert.ok(ranked.slice(0, 3).some((i) => i.label === "Sign in to Grok Build"));
  assert.ok(ranked.some((i) => i.group === "Go to" && i.label === "Agents" && i.shortcut === "G A"));
  assert.ok(!ranked.some((i) => i.group === "Devices"), "devices only appear when searched for");
});

test("searching matches anywhere, ranks word starts first, and marks the match", () => {
  const ports = {
    available: true,
    listening: [5173, 5432, 3000],
    details: [{ port: 5173, process: "vite" }, { port: 5432, process: "postgres", looksLikeDatabase: true }],
    tunnels: [{ port: 3000, state: "open", url: "https://q.trycloudflare.com" }],
  };
  const items = M.paletteItems(statusWith(), ports, ui(), NOW);
  const hits = M.searchPalette(items, "pub");
  const labels = hits.map((i) => i.label);
  assert.deepEqual(plain(labels.slice(0, 2)), ["Publish port 5173", "Publish port 5432…"]);
  assert.ok(labels.includes("Copy published URL for port 3000"));
  assert.ok(labels.includes("Copy public URL"));
  assert.deepEqual(plain(hits[0].match), [0, 3]);
  assert.deepEqual(plain(hits.find((i) => i.label === "Copy published URL for port 3000").match), [5, 8]);
  assert.equal(hits.find((i) => i.label === "Publish port 5432…").meta.text, "database");
  assert.equal(M.searchPalette(items, "zzz").length, 0);
});

// --------------------------------------------------------------- diagnostics --

test("diagnostics leave out what identifies a person or a device", () => {
  const s = statusWith({
    sessions: [{ sessionId: "abcdef0123456789", client: { label: "iPhone", ipAddress: "10.0.0.2", userAgent: "UA" } }],
    pairings: [{ id: "0123456789abcdef", label: "x" }],
  });
  const report = M.redactedDiagnostics(s, { tunnels: [{ port: 3000, qr: "<svg/>" }] }, { console: { base: "/" } });
  assert.equal(report.status.sessions[0].client.ipAddress, undefined);
  assert.equal(report.status.sessions[0].client.userAgent, undefined);
  assert.equal(report.status.sessions[0].sessionId, "abcdef01…");
  assert.equal(report.status.pairings[0].id, "01234567…");
  assert.equal(report.ports.tunnels[0].qr, undefined);
  assert.equal(report.console.base, "/");
  assert.equal(s.sessions[0].client.ipAddress, "10.0.0.2", "the live status is not modified");
});

// -------------------------------------------------------------------- banner --

test("the first-start banner names what is still installing", () => {
  const banner = M.setupBanner({
    setup: {
      state: "running",
      items: [
        { name: "Claude Code", state: "done" }, { name: "Rust", state: "installing" }, { name: "uv", state: "pending" },
      ],
    },
  });
  assert.equal(banner.done, 1);
  assert.equal(banner.total, 3);
  assert.equal(banner.pct, 33);
  assert.equal(banner.text, "installing Rust and uv in the background. Everything else is ready.");
  assert.equal(M.setupBanner({ setup: { state: "finished", items: [] } }), null);
});

test("setup failures keep untried installs and stop reporting recovered rows", () => {
  const error = 'Full diagnostic\nhttps://example.test/' + 'a'.repeat(200);
  const status = {
    setup: { state: 'finished', items: [
      { kind: 'agent', id: 'opencode', name: 'OpenCode', state: 'failed', error },
      { kind: 'agent', id: 'claude', name: 'Claude Code', state: 'failed', error: 'old failure' },
      { kind: 'toolchain', id: 'go', name: 'Go', state: 'pending' },
      { kind: 'source-control', id: 'gh', name: 'GitHub CLI', state: 'failed' },
    ] },
    harnesses: [{ id: 'opencode', installed: false }, { id: 'claude', installed: true }],
    toolchains: [{ id: 'go', installed: false }], sourceControl: [{ id: 'gh', installed: true }],
  };
  assert.deepEqual(plain(M.setupFailures(status)).map((item) => item.id), ['opencode', 'go']);
  assert.equal(M.setupFailures(status)[0].error, error, 'diagnostics are never truncated');
  status.setup.state = 'running';
  assert.deepEqual(plain(M.setupFailures(status)).map((item) => item.id), ['opencode'], 'pending work is not a failure while startup runs');
  status.harnesses[0].installed = true;
  assert.deepEqual(plain(M.setupFailures(status)), []);
  assert.deepEqual(plain(M.setupFailures(null)), []);
});

test("a query finds items by the words people use, in any order", () => {
  const items = M.paletteItems(statusWith({ harnesses: [harness("grok", { signedIn: false })] }), null, ui(), NOW);
  const top = (q) => M.searchPalette(items, q)[0]?.label;
  assert.equal(top("go to serv"), "Server");
  // A page's old name still finds it.
  const goTo = (q) => M.searchPalette(items, q).filter((i) => i.group === "Go to").map((i) => i.cmd.route);
  assert.deepEqual(plain(goTo("environment")), ["server"]);
  assert.deepEqual(plain(goTo("devices")), ["access"]);
  assert.deepEqual(plain(goTo("context")), ["instructions"]);
  assert.equal(top("log out"), "Lock console");
  assert.equal(top("login grok"), "Sign in to Grok Build");
  assert.equal(top("toolch"), "Toolchains", "the group with the best match leads");
});

test("a build stamp is named short enough for a sidebar, and in full for a tooltip", () => {
  assert.deepEqual(plain(M.imageLabel({ version: "v0.5.0", variant: "browser" })),
    { text: "v0.5.0 · browser", version: "v0.5.0", full: "v0.5.0 · browser" });
  const branch = M.imageLabel({ version: "main@1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d", variant: "core" });
  assert.equal(branch.text, "main@1a2b3c4 · core");
  assert.equal(branch.full, "main@1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d · core");
  assert.equal(M.imageLabel({}).text, null);
});

test("an install that failed asks for a retry and counts as needing the user", () => {
  const s = statusWith({
    harnesses: [harness("claude", { installed: false, runnable: false, signedIn: null, installedVersion: null, version: null, failed: true, failure: "404", operation: "install" })],
    toolchains: [
      toolchain("go", { installed: false, version: null, failed: true, failure: "go: cannot find GOROOT directory: /usr/local/go", operation: "install" }),
      toolchain("uv", { installed: false, version: null }),
    ],
  });
  const go = tool(s, "go");
  assert.equal(go.state, "failed");
  assert.deepEqual(plain(go.action), { cmd: "toolchain.install", label: "Retry", icon: "refresh-cw", variant: "warning" });
  assert.equal(go.status.text, "Install failed: go: cannot find GOROOT directory: /usr/local/go");
  assert.equal(tool(s, "uv").action.label, "Install", "never tried is still Install");
  const claude = row(s, "claude");
  assert.equal(claude.action.label, "Retry");
  assert.deepEqual(plain(claude.menu.map((m) => m.cmd)), ["harness.version"], "nothing to uninstall");
  assert.deepEqual(plain(M.needsYou(s, null, ui()).map((r) => r.id)).sort(), ["claude", "go"]);
  assert.deepEqual(plain(M.navBadges(s, null, ui()).toolchains), { tone: "warn", count: 1 });
  assert.ok(M.paletteItems(s, null, ui(), NOW).some((i) => i.label === "Retry installing Go" && i.attention));
});

test("a row's error is not repeated when its status line already says it", () => {
  const failure = "go: cannot find GOROOT directory: /usr/local/go";
  const s = statusWith({ toolchains: [toolchain("go", { installed: false, version: null, failed: true, failure, operation: "install" })] });
  assert.equal(tool(s, "go", { notices: new Map([["toolchain:go", { tone: "danger", text: failure }]]) }).notice, undefined);
  const other = tool(s, "go", { notices: new Map([["toolchain:go", { tone: "warn", text: "The setup service restarted" }]]) });
  assert.equal(other.notice.text, "The setup service restarted");
});

test("a home or state folder that a recreate would leave behind needs the user", () => {
  const paths = (volumeKind, stateKind = "durable") => statusWith({ paths: { volumeKind, stateKind } });
  assert.deepEqual(plain(M.serverWarnings(paths("anonymous"))), ["home"]);
  assert.deepEqual(plain(M.serverWarnings(paths("durable", "anonymous"))), ["state"]);
  assert.deepEqual(plain(M.serverWarnings(paths("none"))), ["home"], "not mounted at all is lost too");
  assert.deepEqual(plain(M.serverWarnings(paths(null, null))), [], "not measured yet is not a warning");
  assert.deepEqual(plain(M.navBadges(paths("anonymous"), null, ui()).server), { tone: "warn", count: 1 });
  assert.equal(M.attentionCount(paths("anonymous"), null, ui()), 1, "T3 Code's Setup entry counts it");
  assert.equal(M.attentionCount(paths("durable"), null, ui()), 0);
});

test("a channel name where a release would be is no release to wait for", () => {
  const rust = M.toolchainRows(statusWith({ releaseAgeMs: DAY, toolchains: [toolchain("rust", { version: "1.99.1", latestVersion: "1.99.1", newestVersion: "stable" })] }), ui(), NOW)[0];
  assert.equal(rust.held, null);
  assert.equal(rust.status.text, "With clippy and rustfmt · up to date");
});

test("a failed tool update has one error and keeps an unrelated notice", () => {
  const s = statusWith({ toolchains: [toolchain("rust", {
    version: "1.99.1", latestVersion: "1.99.1", failed: true,
    operation: "update", failure: "invalid version: stable",
  })] });
  const state = ui();
  state.notices.set("toolchain:rust", { tone: "danger", text: "invalid version: stable" });
  let row = M.toolchainRows(s, state, NOW)[0];
  assert.equal(row.status.text, "Update failed: invalid version: stable");
  assert.equal(row.notice, undefined, "the status already contains the failed click's reason");
  assert.equal(row.version, "1.99.1");
  assert.equal(row.action.cmd, "toolchain.update");
  state.notices.set("toolchain:rust", { tone: "danger", text: "The update service could not be reached" });
  row = M.toolchainRows(s, state, NOW)[0];
  assert.equal(row.notice.text, "The update service could not be reached", "different recovery information stays available");
});

test("old Rust channel metadata never becomes a numbered update target", () => {
  const s = statusWith({ toolchains: [toolchain("rust", {
    version: "1.99.1", latestVersion: "stable", newestVersion: "beta",
  })] });
  const row = M.toolchainRows(s, ui(), NOW)[0];
  assert.equal(row.latest, null);
  assert.equal(row.updateAvailable, false);
  assert.equal(row.held, null);
  assert.equal(M.updatesView(s, ui(), NOW).available.some(r => r.id === "rust"), false);
});

test("settings an older image left behind flag Server", () => {
  assert.deepEqual(plain(M.navBadges(statusWith({ legacyEnv: ["GOROOT", "PATH"] }), null, ui()).server), { tone: "warn", count: 1 });
  assert.deepEqual(plain(M.navBadges(statusWith({ legacyEnv: ["GOROOT"] }), null, ui()).more), { tone: "warn", count: 1 });
  assert.equal(M.navBadges(statusWith({ legacyEnv: [] }), null, ui()).server, null);
});

// --------------------------------------------------------------- added tools --

const pkg = (id, overrides = {}) => ({
  id, name: id, configured: true, installed: true, version: "1.0.0", requestedVersion: "1.0.0", latestVersion: null,
  failed: false, failure: null, operation: null, inProgress: false, adopted: false, managedVersions: ["1.0.0"], ...overrides,
});
const pkgRow = (status, id, extra) => M.packageRows(status, ui(extra), NOW).find((r) => r.id === id);

test("an added tool reads like a toolchain row, under its own commands", () => {
  const s = statusWith({ packages: [
    pkg("ripgrep", { bins: ["rg"], latestVersion: "1.0.0", description: "searches directories" }),
    pkg("jq", { bins: ["jq"], latestVersion: "1.1.0" }),
    pkg("node", { bins: ["node", "npm", "npx", "corepack"] }),
  ] });
  const rg = pkgRow(s, "ripgrep");
  assert.equal(rg.target, "package");
  assert.equal(rg.mono, "Ri");
  assert.equal(rg.mark, null, "an added tool has no mark of its own, only its monogram");
  assert.equal(rg.status.text, "Provides rg · up to date");
  assert.equal(rg.description, "searches directories");
  assert.deepEqual(plain(rg.menu.map((m) => m.cmd || "sep")), ["package.version", "sep", "package.uninstall"]);
  const jq = pkgRow(s, "jq");
  assert.equal(jq.status.text, "Installed", "a command named like the tool goes unsaid, and the version says there is a newer one");
  assert.deepEqual(plain(jq.action), { cmd: "package.update", label: "Update" });
  assert.equal(jq.menu[0].label, "Update to 1.1.0");
  assert.equal(pkgRow(s, "node").status.text, "Provides node, npm, npx and 1 more");
});

test("a tool the config does not pin says what it follows", () => {
  const s = statusWith({ packages: [pkg("yq", { requestedVersion: "latest", version: "4.44.1", adopted: true })] });
  assert.equal(pkgRow(s, "yq").status.text, "Installed · follows latest");
});

test("a failed first install offers Retry, and taking it off the list", () => {
  const s = statusWith({ packages: [pkg("terraform", { configured: false, installed: false, version: null, failed: true, failure: "404 Not Found", operation: "install" })] });
  const row = pkgRow(s, "terraform");
  assert.equal(row.state, "failed");
  assert.deepEqual(plain(row.action), { cmd: "package.install", label: "Retry", icon: "refresh-cw", variant: "warning" });
  assert.deepEqual(plain(row.menu.map((m) => m.cmd)), ["package.dismiss"]);
  assert.deepEqual(plain(M.needsYou(s, null, ui()).map((r) => r.id)), ["terraform"]);
  assert.deepEqual(plain(M.navBadges(s, null, ui()).toolchains), { tone: "warn", count: 1 });
});

test("an added tool's work shows with the rest, and its own operations name it", () => {
  const s = statusWith({
    packages: [pkg("jq", { latestVersion: "1.1.0" })],
    operations: {
      "package:jq": { kind: "update", state: "running", progress: { phase: "installing" } },
      "package:npm:prettier": { kind: "install", state: "ok", finishedAt: NOW - 60_000 },
    },
  });
  const row = pkgRow(s, "jq");
  assert.equal(row.state, "running");
  assert.equal(row.action.cmd, "op.cancel");
  const act = M.activity(s, ui(), NOW);
  assert.deepEqual(plain(act.running.map((r) => r.id)), ["jq"]);
  assert.equal(act.finished[0].text, "Installed prettier");
  assert.equal(M.summaries(s, null, ui(), NOW).toolchains.text, "5 installed · 1 added");
});

// The shape GET /packages/registry serves.
const REGISTRY = [
  { name: "jq", description: "Command-line JSON processor", kinds: ["aqua"], bins: ["jq"], aliases: [] },
  { name: "jless", description: "A command-line JSON viewer", kinds: ["aqua"], bins: ["jless"], aliases: [] },
  { name: "ripgrep", description: "Searches directories for a regex", kinds: ["aqua", "cargo"], bins: ["rg"], aliases: ["rg"] },
  { name: "rgr", description: "Something else entirely", kinds: ["github"], bins: ["rgr"], aliases: [] },
  { name: "kubectl", description: "kubectl cli", kinds: ["aqua"], bins: ["kubectl"], aliases: [] },
  { name: "kubectx", description: "Switch contexts", kinds: ["aqua"], bins: ["kubectx", "kubens"], aliases: [] },
  { name: "helm", description: "The Kubernetes package manager", kinds: ["aqua"], bins: ["helm"], aliases: [] },
  { name: "claude", description: "Claude Code", kinds: ["aqua"], bins: ["claude"], aliases: ["claude-code"] },
  { name: "go", description: "Go", kinds: ["core"], bins: ["go"], aliases: [] },
];

test("registry search ranks the name, then an alias or command, then the description", () => {
  const names = (q) => plain(M.searchRegistry(REGISTRY, q).map((r) => r.entry.name));
  assert.deepEqual(names("rg").slice(0, 2), ["ripgrep", "rgr"], "rg is ripgrep's command before it is a prefix");
  assert.deepEqual(names("kube"), ["kubectl", "kubectx", "helm"], "names first, then a description that mentions it");
  assert.deepEqual(names("json"), ["jq", "jless"]);
  assert.deepEqual(plain(M.searchRegistry(REGISTRY, "ctl")[0].match), [4, 7]);
  assert.deepEqual(names(""), ["kubectl", "helm"], "suggestions this registry has, before anything is typed");
  assert.deepEqual(names("zzz"), []);
  assert.equal(M.searchRegistry(REGISTRY, "k", 2).length, 2);
});

test("names owned by agents and toolchains are known, and tool names are checked like the server does", () => {
  assert.equal(M.managedOn("claude-code"), "Agents");
  assert.equal(M.managedOn("go"), "Toolchains");
  assert.equal(M.managedOn("kubectl"), null);
  for (const ok of ["kubectl", "npm:prettier", "github:cli/cli", "npm:@biomejs/biome"]) assert.equal(M.isToolSpec(ok), true, ok);
  for (const bad of ["--help", "a b", "asdf:https://x/y", "x/"]) assert.equal(M.isToolSpec(bad), false, bad);
  assert.equal(M.isVersionSpec("3.12"), true);
  assert.equal(M.isVersionSpec("-1"), false);
});

test("the palette installs from the registry, but only when asked and never above the console's own actions", () => {
  const s = statusWith({ packages: [pkg("jq")] });
  const items = M.paletteItems(s, null, ui({ registry: REGISTRY }), NOW);
  assert.ok(!M.searchPalette(items, "").some((i) => i.group === "Install from mise"), "nothing from the registry without a query");
  const hits = M.searchPalette(items, "k");
  const registryHits = hits.filter((i) => i.group === "Install from mise");
  assert.ok(registryHits.length > 0 && registryHits.length <= 6);
  assert.ok(hits.indexOf(registryHits[0]) > hits.findIndex((i) => i.group !== "Install from mise"), "after the console's own results");
  assert.ok(!items.some((i) => i.label === "Install jq…"), "an installed tool is not offered again");
  assert.ok(!items.some((i) => i.label === "Install claude…" || i.label === "Install go…"), "nor one managed elsewhere");
  assert.equal(M.searchPalette(items, "kubectl").find((i) => i.group === "Install from mise").cmd.id, "kubectl");
  assert.ok(M.searchPalette(items, "json viewer").some((i) => i.label === "Install jless…"), "found by its description");
  assert.ok(items.some((i) => i.label === "Add a tool…" && i.shortcut === "N"));
});

test("a tool shows from the click on: in flight, then queued, before the server lists it", () => {
  const s = statusWith({ packages: [], operations: { "package:npm:prettier": { kind: "install", state: "queued" } } });
  const queued = pkgRow(s, "npm:prettier");
  assert.equal(queued.name, "prettier");
  assert.equal(queued.state, "queued");
  assert.equal(queued.action.cmd, "op.cancel");
  const inFlight = pkgRow(statusWith({ packages: [] }), "kubectl", { busy: new Map([["package:kubectl", "install"]]) });
  assert.equal(inFlight.state, "running");
  assert.equal(inFlight.badge.text, "Installing");
  assert.equal(M.toolName("npm:@biomejs/biome"), "biome");
  assert.equal(M.toolName("kubectl"), "kubectl");
});

test("added tools list by the name they show, a queued one already in its place", () => {
  const s = statusWith({
    packages: [{ id: "aqua:BurntSushi/ripgrep", name: "ripgrep", configured: true, installed: true, version: "15.2.0" },
      { id: "jq", name: "jq", configured: true, installed: true, version: "1.8.2" },
      { id: "npm:prettier", name: "prettier", configured: true, installed: true, version: "3.3.3" }],
    operations: { "package:kubectl": { kind: "install", state: "queued" } },
  });
  assert.deepEqual(plain(M.packageRows(s, ui(), NOW).map((r) => r.name)), ["jq", "kubectl", "prettier", "ripgrep"]);
});

test("a typed version resolves the way mise does, segment by segment", () => {
  const releases = ["1.37.1", "1.37.0", "1.4.0", "1.3.10", "1.3.9", "1.3.0-rc.1", "1.3"];
  assert.equal(M.resolveRelease(releases, "1.3"), "1.3", "an exact release wins");
  assert.equal(M.resolveRelease(releases.filter((v) => v !== "1.3"), "1.3"), "1.3.10", "else the newest 1.3.x, not 1.37");
  assert.equal(M.resolveRelease(releases, "1.37"), "1.37.1");
  assert.equal(M.resolveRelease(releases, "1"), "1.37.1");
  assert.equal(M.resolveRelease(releases, "2"), null);
  assert.equal(M.resolveRelease(null, "1"), null);
  assert.equal(M.resolveRelease(releases, ""), null);
});

test("the version list shows what a typed version names, newest first, the one it installs highlighted", () => {
  const releases = ["1.37.1", "1.37.0", "1.4.0", "1.3.10", "1.3.9", "1.3.0-rc.1", "1.3"];
  assert.deepEqual(plain(M.matchReleases(releases, "1.3")), ["1.3.10", "1.3.9", "1.3.0-rc.1", "1.3"], "not 1.37, which mise would not install");
  assert.deepEqual(plain(M.matchReleases(releases.slice(0, 5), "1.3")), ["1.3.10", "1.3.9"]);
  assert.deepEqual(plain(M.matchReleases(releases, "rc")), ["1.3.0-rc.1"], "text that names no release finds the ones containing it");
  assert.deepEqual(plain(M.matchReleases(releases, " ")), releases);
  assert.deepEqual(plain(M.matchReleases(releases, "2")), []);
  assert.deepEqual(plain(M.matchReleases(null, "1")), []);
  for (const q of ["1", "1.3", "1.37", "1.3.0", "1.4"]) {
    const listed = M.matchReleases(releases, q);
    assert.equal(listed[M.releaseIndex(listed, q)], M.resolveRelease(releases, q), `the highlighted release is the one ${q} installs`);
  }
  assert.equal(M.releaseIndex(M.matchReleases(releases, "1.3"), "1.3"), 3, "jq-style: 1.3 is a release of its own");
  assert.equal(M.releaseIndex(releases, "nothing"), 0);
});

test("a release mise still holds back installs when named in full, never through a prefix", () => {
  const releases = [
    { version: "2.1.288", waiting: true },
    { version: "2.1.287", waiting: false },
    { version: "2.1.286", waiting: false },
    { version: "2.2.0-beta.1", waiting: false, prerelease: true },
  ];
  assert.equal(M.resolveRelease(releases, "2.1.288"), "2.1.288", "named in full");
  assert.equal(M.resolveRelease(releases, "2.1"), "2.1.287", "a prefix takes what mise offers");
  assert.equal(M.resolveRelease(releases, "2.2"), null, "nor a preview");
  assert.equal(M.resolveRelease(releases, "2.2.0-beta.1"), "2.2.0-beta.1");
  const listed = M.matchReleases(releases, "2.1");
  assert.deepEqual(plain(listed.map(M.versionOf)), ["2.1.288", "2.1.287", "2.1.286"]);
  assert.equal(M.releaseIndex(listed, "2.1"), 1, "the highlight sits on the release that installs");
});

test("agents offer new stable releases immediately, including from an older saved cache", () => {
  const out = Date.parse("2026-10-02T09:00:00Z"); // three hours before NOW
  const s = statusWith({
    releaseAgeMs: DAY,
    harnesses: [harness("claude", { installedVersion: "2.1.287", version: "2.1.287", latestVersion: "2.1.287", newestVersion: "2.1.288", newestReleasedAt: new Date(out).toISOString() })],
  });
  const claude = row(s, "claude");
  assert.equal(claude.updateAvailable, true);
  assert.equal(claude.status.text, "Signed in");
  assert.equal(claude.action.cmd, "harness.update");
  assert.equal(claude.menu.some((m) => m.cmd === "release.now"), false);
  const behind = row(statusWith({ releaseAgeMs: DAY, harnesses: [harness("claude", { installedVersion: "2.1.286", version: "2.1.286", latestVersion: "2.1.287", newestVersion: "2.1.288", newestReleasedAt: new Date(out).toISOString() })] }), "claude");
  assert.equal(behind.action.cmd, "harness.update");
  assert.equal(behind.status.text, "Signed in");
  assert.equal(behind.latest, "2.1.288", "the row's version shows where the update goes");
  // Already on it, or no date to say when: nothing claims a wait it cannot time.
  assert.equal(row(statusWith({ harnesses: [harness("claude", { installedVersion: "2.1.288", version: "2.1.288", latestVersion: "2.1.287", newestVersion: "2.1.288" })] }), "claude").held, null);
  const undated = row(statusWith({ harnesses: [harness("claude", { installedVersion: "2.1.287", version: "2.1.287", latestVersion: "2.1.287", newestVersion: "2.1.288" })] }), "claude");
  assert.equal(undated.status.text, "Signed in");
  assert.equal(undated.latest, "2.1.288");
  // A toolchain says so too, but only takes mise's newest: no menu item.
  const go = M.toolchainRows(statusWith({ releaseAgeMs: DAY, toolchains: [toolchain("go", { version: "1.27.1", latestVersion: "1.27.1", newestVersion: "1.27.2", newestReleasedAt: new Date(out).toISOString() })] }), ui(), NOW)[0];
  assert.equal(go.status.text, "Installed · 1.27.2 available in 21 hours");
  assert.equal(go.menu.some((m) => m.cmd === "release.now"), false);
});

test("an unchanged update is described as keeping the version in activity", () => {
  const message = "Claude Code 2.1.290 is newer than the available 2.1.273; keeping 2.1.290.";
  const s = statusWith({ operations: {
    "harness:claude": { kind: "update", state: "ok", changed: false, message, finishedAt: NOW - MIN },
  } });
  assert.equal(M.activity(s, ui(), NOW).finished[0].text, message);
});

test("Antigravity reads as an agent T3 Code installs and signs in itself", () => {
  const ag = (overrides = {}) => ({
    id: "antigravity", name: "Antigravity", managedBy: "t3", available: true, reachable: true, installed: true, runnable: true,
    version: "1.1.1", installedVersion: "1.1.1", latestVersion: "1.1.1", enabled: true, t3Status: "warning", signedIn: null,
    canSignIn: true, canSetKey: false, downloadBytes: 656_572_786, managedVersions: ["1.1.1"], failed: false, failure: null, inProgress: false,
    ...overrides,
  });
  const at = (h, extra) => row(statusWith({ harnesses: [harness("claude"), h] }), "antigravity", extra);
  const missing = at(ag({ installed: false, version: null, installedVersion: null }));
  assert.equal(missing.state, "missing");
  assert.equal(missing.status.text, "Not installed · a 657 MB download, through T3 Code");
  assert.equal(missing.action.cmd, "harness.install");
  assert.equal(missing.mark, "antigravity");
  const unchecked = at(ag());
  assert.equal(unchecked.state, "unchecked");
  assert.equal(unchecked.status.text, "Installed · Google sign-in not checked yet");
  assert.equal(unchecked.action.cmd, "harness.signin");
  assert.equal(unchecked.action.variant, undefined, "offered, not asked for");
  assert.equal(unchecked.menu.some((m) => m.cmd === "harness.version"), false, "T3 installs the release it supports");
  assert.equal(M.needsYou(statusWith({ harnesses: [harness("claude"), ag()] }), null, ui()).some((i) => i.id === "antigravity"), false);
  const signedIn = at(ag({ signedIn: true, account: "dev@example.com", t3Status: "ready" }));
  assert.equal(signedIn.status.text, "Signed in as dev@example.com");
  assert.ok(signedIn.menu.some((m) => m.cmd === "harness.signin" && m.label === "Sign in again"));
  const signedOut = at(ag({ signedIn: false }));
  assert.equal(signedOut.state, "signin");
  assert.equal(signedOut.action.variant, "primary");
  const off = at(ag({ enabled: false }));
  assert.equal(off.state, "off");
  assert.equal(off.action.cmd, "harness.enable");
  const update = at(ag({ latestVersion: "1.2.0", signedIn: true }));
  assert.equal(update.state, "update");
  assert.equal(update.status.text, "Signed in");
  const error = at(ag({ t3Status: "error", t3Message: "Google requires an eligible Antigravity subscription for this account." }));
  assert.equal(error.status.text, "Google requires an eligible Antigravity subscription for this account.");
  const down = at(ag({ reachable: false, error: "T3 Code did not answer" }));
  assert.equal(down.state, "unreachable");
  assert.equal(down.action, null);
  const downloading = at(ag({ installed: false, version: null, inProgress: true, operation: "install", progress: { phase: "downloading", done: 328_286_393, total: 656_572_786 } }));
  assert.equal(downloading.state, "running");
  assert.equal(downloading.progress.pct, 50, "T3's own download, even one started in its settings");
  assert.equal(at(ag(), { signingIn: "antigravity" }).status.text, "Waiting for the Google sign-in");
});

// ----------------------------------------------------------- source control --

const scm = (id, overrides = {}) => ({
  id, name: M.SOURCE_CONTROL[id].name, provider: M.SOURCE_CONTROL[id].provider, inImage: id === "gh",
  installed: true, version: "1.0.0", latestVersion: null, failed: false, failure: null, operation: null,
  inProgress: false, missingExtensions: [], auth: { status: "authenticated", account: "ana", host: "gitlab.com", detail: null },
  ...overrides,
});
const scmRow = (status, id, extra) => M.sourceControlRows(status, ui(extra), NOW).find((r) => r.id === id);

test("a source control CLI says which host it is for and who is signed in", () => {
  const s = statusWith({
    sourceControl: [
      scm("gh", { version: "2.102.0", auth: { status: "unauthenticated", account: null, host: null, detail: null } }),
      scm("glab", { latestVersion: "1.1.0" }),
      scm("fj", { auth: { status: "unknown", account: null, host: null, detail: "timed out" } }),
      scm("tea", { installed: false, version: null, auth: null }),
      scm("az", { auth: { status: "unauthenticated", account: null, host: null, detail: "ERROR: Please run 'az login'" } }),
    ],
  });
  assert.deepEqual(plain(M.sourceControlRows(s, ui(), NOW).map((r) => r.id)), ["gh", "glab", "fj", "tea", "az"], "in the server's order, which is its catalogue's");
  // Each wears its provider's mark, as in T3 Code, and Gitea its own.
  assert.deepEqual(plain(M.sourceControlRows(s, ui(), NOW).map((r) => r.mark)), ["github", "gitlab", "forgejo", "gitea", "azure-devops"]);

  const glab = scmRow(s, "glab");
  assert.equal(glab.provider, "GitLab");
  assert.equal(glab.status.text, "Signed in as ana on gitlab.com");
  assert.equal(glab.action.cmd, "toolchain.update");

  // Installed and signed out: T3 Code cannot use it, so it wants the user.
  const az = scmRow(s, "az");
  assert.equal(az.state, "signin");
  assert.equal(az.attention, true);
  assert.deepEqual(plain(az.status), { dot: "warn", text: "Not signed in" });

  assert.deepEqual(plain(az.action), { variant: "primary", cmd: "scm.signin", label: "Sign in", icon: "log-in" });

  // The image's gh is never a warning, and has nothing to install or remove:
  // signing it in is offered quietly.
  const gh = scmRow(s, "gh");
  assert.equal(gh.inImage, true);
  assert.equal(gh.state, "ok");
  assert.equal(gh.attention, false);
  assert.deepEqual(plain(gh.action), { cmd: "scm.signin", label: "Sign in", icon: "log-in" });
  assert.equal(gh.flow, "device", "a device code: nothing to make or paste");
  assert.deepEqual(plain(gh.menu), [{ cmd: "scm.token", label: "Sign in with a token…", icon: "key-round" }], "a token for GitHub Enterprise, or narrower scopes");
  assert.equal(gh.status.text, "Not signed in");
  assert.equal(gh.badge.text, "In the image");


  const tea = scmRow(s, "tea");
  assert.equal(tea.state, "missing");
  assert.deepEqual(plain(tea.status), { dot: null, text: "Not installed" }, "never left out of T3_PREINSTALL: nothing installs it unasked");
  assert.equal(tea.action.cmd, "toolchain.install");

  assert.equal(scmRow(s, "fj").status.text, "Sign-in could not be checked: timed out", "and why");
});

test("source control rows keep sign-in within reach in every state, and say why a check failed", () => {
  // An update failed on a CLI that is also signed out: Retry holds the button,
  // and signing in waits in the menu, and in the palette.
  const failed = statusWith({ sourceControl: [scm("glab", { failed: true, failure: "network down", operation: "update",
    auth: { status: "unauthenticated", account: null, host: "gitlab.com", detail: null } })] });
  const glab = scmRow(failed, "glab");
  assert.equal(glab.state, "failed");
  assert.notEqual(glab.action.cmd, "scm.signin");
  assert.ok(glab.menu.some((m) => m.cmd === "scm.signin"), "sign-in is still reachable");
  assert.ok(M.paletteItems(failed, null, ui(), NOW).some((i) => i.label === "Sign in to GitLab CLI"));

  // Not known: the reason, signing in again to the same host, and out of it.
  const unknown = scmRow(statusWith({ sourceControl: [scm("glab", { auth: { status: "unknown", account: null, host: "git.example.com",
    detail: "x509: certificate signed by unknown authority" } })] }), "glab");
  assert.equal(unknown.status.text, "Sign-in could not be checked: x509: certificate signed by unknown authority");
  assert.deepEqual(plain(unknown.menu.filter((m) => m.cmd && m.cmd.startsWith("scm.")).map((m) => m.label)), ["Sign in again…", "Sign out of git.example.com…"]);
  const gh = scmRow(statusWith({ sourceControl: [scm("gh", { auth: { status: "unknown", account: null, host: "github.com", detail: "github.com did not answer in time" } })] }), "gh");
  assert.equal(gh.status.text, "Sign-in could not be checked: github.com did not answer in time", "the image's gh says so too");
  const long = scmRow(statusWith({ sourceControl: [scm("fj", { auth: { status: "unknown", detail: "x".repeat(200) } })] }), "fj");
  assert.ok(long.status.text.length < 140, "a long reason is cut to a line");

  // While it waits its turn or works, no sign-in is offered over it.
  const queued = scmRow(statusWith({ sourceControl: [scm("glab", { inProgress: true, operation: "update" })] }), "glab");
  assert.equal(queued.menu.some((m) => m.cmd && m.cmd.startsWith("scm.")), false);

  // Signing out shows on the row while it runs.
  const signingOut = scmRow(statusWith({ sourceControl: [scm("glab")] }), "glab", { signingOut: "glab" });
  assert.equal(signingOut.badge.text, "Signing out");
  assert.equal(signingOut.status.text, "Signing out of gitlab.com");
  assert.equal(signingOut.action, null);

  // gh did not answer its version check: it is in the image, so it says that, not "missing".
  assert.equal(scmRow(statusWith({ sourceControl: [scm("gh", { installed: false, version: null, auth: null })] }), "gh").status.text, "Could not be run");
});

test("an az an added tool provides, without its extension, says how to add it", () => {
  const s = statusWith({ sourceControl: [scm("az", { installed: false, version: null, providedBy: { tool: "azure-cli", version: "2.88.0" },
    missingExtensions: ["azure-devops"], auth: { status: "authenticated", account: "ana@example.com", host: "dev.azure.com" } })] });
  const az = scmRow(s, "az");
  assert.equal(az.state, "failed");
  assert.equal(az.attention, true);
  assert.deepEqual(plain(az.status), { dot: "warn", text: "Missing the azure-devops extension:", code: "az extension add --name azure-devops" });
  assert.equal(az.action, null, "nothing to repair here: it is the added tool's");
});

test("a CLI an added tool provides is signed in to here, and installed, updated and removed there", () => {
  const providedBy = { tool: "gitlab:gitlab-org/cli", version: "1.118.0" };
  const signedOut = statusWith({ sourceControl: [scm("glab", { installed: false, version: null, providedBy,
    auth: { status: "unauthenticated", account: null, host: "gitlab.com", detail: null } })] });
  const glab = scmRow(signedOut, "glab");
  assert.equal(glab.badge.text, "Added tool");
  assert.equal(glab.version, "1.118.0");
  assert.equal(glab.providedBy, "gitlab:gitlab-org/cli");
  assert.deepEqual(plain(glab.status), { dot: "warn", text: "Not signed in to gitlab.com" });
  assert.deepEqual(plain(glab.action), { variant: "primary", cmd: "scm.signin", label: "Sign in", icon: "log-in" });
  assert.equal(glab.attention, true, "added to be used: signed out wants the user");
  assert.deepEqual(plain(M.managedSourceControlRows(signedOut, ui(), NOW)), [], "nothing to install or update here");
  assert.deepEqual(plain(M.needsYou(signedOut, null, ui()).map((r) => r.id)), ["glab"], "and on the Overview, like one installed here");
  assert.equal(M.summaries(signedOut, null, ui(), NOW).sourcecontrol.text, "0 signed in");

  const signedIn = scmRow(statusWith({ sourceControl: [scm("glab", { installed: false, version: null, providedBy })] }), "glab");
  assert.equal(signedIn.status.text, "Signed in as ana on gitlab.com");
  assert.deepEqual(plain(signedIn.menu.map((m) => m.cmd)), ["scm.signin", "scm.signout"]);
  const labels = M.paletteItems(statusWith({ sourceControl: [scm("glab", { installed: false, version: null, providedBy })] }), null, ui(), NOW).map((i) => i.label);
  assert.ok(!labels.some((l) => /(Install|Update|Uninstall) GitLab CLI/.test(l)));
});

test("an az without its extension offers to repair it", () => {
  const s = statusWith({ sourceControl: [scm("az", { missingExtensions: ["azure-devops"] })] });
  const az = scmRow(s, "az");
  assert.equal(az.state, "failed");
  assert.equal(az.status.text, "Missing the azure-devops extension");
  assert.equal(az.action.label, "Repair");
  assert.equal(az.action.cmd, "toolchain.update");
});

test("source control counts with the toolchains: needs-you, badges, update all, and the palette", () => {
  const s = statusWith({
    sourceControl: [
      scm("gh", { auth: { status: "unauthenticated" } }),
      scm("glab", { auth: { status: "unauthenticated" } }),
      scm("fj", { latestVersion: "1.1.0" }),
      scm("tea", { installed: false, version: null, auth: null }),
    ],
  });
  assert.deepEqual(plain(M.needsYou(s, null, ui()).map((i) => i.id)), ["glab"], "gh signed out is not owed anything, and fj's update is offered");
  // Its own page, with its own badge; the Toolchains page is not blamed for it.
  const badges = M.navBadges(s, null, ui());
  assert.deepEqual(plain(badges.sourcecontrol), { tone: "warn", count: 1 });
  assert.equal(badges.toolchains, null);
  assert.equal(badges.more.count, 1, "on a phone, More carries it");
  assert.equal(M.attentionCount(s, null, ui()), 1);
  assert.equal(M.summaries(s, null, ui(), NOW).sourcecontrol.text, "1 signed in");
  const labels = M.paletteItems(s, null, ui(), NOW).map((i) => i.label);
  assert.ok(labels.includes("Install Gitea CLI"));
  assert.ok(labels.includes("Update Forgejo CLI to 1.1.0"));
  assert.ok(labels.includes("Update all source control CLIs"));
  assert.ok(!labels.includes("Update all toolchains"), "the toolchains have nothing to update");
  const items = M.paletteItems(s, null, ui(), NOW);
  assert.equal(items.find((i) => i.label === "Install Gitea CLI").group, "Source control");
  assert.deepEqual(plain(items.find((i) => i.label === "Source control" && i.group === "Go to").cmd), { cmd: "goto", route: "sourcecontrol" });
  assert.ok(!labels.some((l) => /(Install|Update|Uninstall) GitHub CLI/.test(l)), "the image's gh is not installed here");
  assert.ok(labels.includes("Sign in to GitHub CLI"));
  assert.ok(labels.includes("Sign in to GitLab CLI"));
  assert.ok(M.searchPalette(M.paletteItems(s, null, ui(), NOW), "gitlab").some((i) => i.label === "Uninstall GitLab CLI…"));
});

test("a source control CLI the first start installs shows as queued, and finished work names it", () => {
  const s = statusWith({
    sourceControl: [scm("glab", { installed: false, version: null, auth: null })],
    setup: { state: "running", items: [{ kind: "source-control", id: "glab", name: "GitLab CLI", state: "pending" }] },
    operations: { "toolchain:fj": { kind: "install", state: "ok", finishedAt: NOW - MIN } },
  });
  assert.equal(scmRow(s, "glab").state, "queued");
  assert.ok(M.activity(s, ui(), NOW).finished.some((f) => f.text === "Installed Forgejo CLI"));
  assert.equal(M.managedOn("azure-cli"), "Source control");
  assert.equal(M.managedOn("glab"), "Source control");
});

test("a signed-in CLI offers another host and signing out; az signs in with a device code", () => {
  const s = statusWith({
    sourceControl: [
      scm("glab"),
      scm("az", { auth: { status: "authenticated", account: "ana@example.com", host: "dev.azure.com" } }),
    ],
  });
  const glab = scmRow(s, "glab");
  assert.equal(glab.flow, "token");
  assert.deepEqual(plain(glab.menu.filter((m) => m.cmd && m.cmd.startsWith("scm.")).map((m) => m.label)), ["Sign in to another host…", "Sign out of gitlab.com…"]);
  assert.equal(glab.menu.at(-1).cmd, "toolchain.uninstall", "Uninstall stays last, after the separator");
  const az = scmRow(s, "az");
  assert.equal(az.flow, "device");
  assert.deepEqual(plain(az.menu.filter((m) => m.cmd && m.cmd.startsWith("scm.")).map((m) => m.label)), ["Sign in again…", "Sign out…"]);
  // gh signs in again with a device code, or with a token for another host,
  // and signs out of the host it is signed in to.
  const gh = scmRow(statusWith({ sourceControl: [scm("gh", { auth: { status: "authenticated", account: "ana", host: "github.com" } })] }), "gh");
  assert.deepEqual(plain(gh.menu.map((m) => [m.cmd, m.label])),
    [["scm.signin", "Sign in again…"], ["scm.token", "Sign in with a token…"], ["scm.signout", "Sign out of github.com…"]]);
  const signing = scmRow(s, "az", { signingIn: "az" });
  assert.equal(signing.state, "signing");
  assert.equal(signing.badge.text, "Signing in");
  assert.ok(M.paletteItems(s, null, ui(), NOW).some((i) => i.label === "Sign GitLab CLI out of gitlab.com…"));
  assert.match(M.SOURCE_CONTROL.glab.tokenPage("gitlab.example.com"), /^https:\/\/gitlab\.example\.com\/-\/user_settings\/personal_access_tokens\?/);
});

test('unavailable device snapshots do not prompt pairing a first device', () => {
  const s = { server: { ok: true }, publicUrl: 'https://t3.example', sessions: [],
    authLists: { session: { available: false, stale: true, refreshing: true }, pairing: { available: false } } };
  const view = M.readiness(s, {});
  assert.equal(view.title, 'Reading paired devices');
  assert.equal(view.steps.find((step) => step.id === 'pair').action, null);
  s.authLists.session.available = true;
  assert.equal(M.readiness(s, {}).title, 'Pair your first device');
});

test('auto-update view says each schedule, when each last checked, and the last activity', () => {
  const off = M.autoUpdateView({}, NOW);
  assert.equal(off.schedule.providers, 'Off');
  assert.deepEqual(plain(off.lastChecked), { providers: null, toolchains: null, t3: null });
  assert.equal(off.lastActivityText, 'Not used since the setup service started');
  assert.equal(M.autoUpdateView({ autoUpdate: { lastActivityAt: NOW - 10_000 } }, NOW).lastActivityText, 'Last used just now');
  const on = M.autoUpdateView({ autoUpdate: {
    policy: { providers: { enabled: false, checkMinutes: 180, idleMinutes: 30 }, toolchains: { enabled: true, checkMinutes: 45, idleMinutes: 15 }, t3: { enabled: false, checkMinutes: 45, idleMinutes: 15 } },
    state: { lastProviderCheckAt: NOW - 6 * MIN, lastToolchainCheckAt: NOW - 12 * MIN, lastResult: 'Queued 2 tool updates' },
    lastActivityAt: NOW - 2 * 60 * MIN, busy: 'An install or update is already running',
  } }, NOW);
  assert.equal(on.schedule.providers, 'Off');
  assert.equal(on.schedule.toolchains, 'Checks every 45 min, and installs after 15 min without activity.');
  assert.equal(on.lastChecked.providers, 'Last checked 6 min ago.');
  assert.equal(on.lastChecked.toolchains, 'Last checked 12 min ago.');
  assert.match(on.lastActivityText, /Last used 2 hours ago/);
  assert.equal(on.busy, 'An install or update is already running');
  assert.equal(on.lastResult, 'Queued 2 tool updates');
});


test("runtime freshness requires a successful check for the selected channel", () => {
  const s = { t3: { runtime: { channel: 'stable', version: '0.0.45', releases: { stable: { version: '0.0.45' } }, checkedAt: NOW } } };
  assert.equal(M.runtimeView(s).verified, true);
  s.t3.runtime.checkError = 'offline';
  assert.equal(M.runtimeView(s).verified, false);
  s.t3.runtime.releases.stable.version = '0.0.46';
  assert.equal(M.runtimeView(s).available, true, 'retain known updates when offline');
  s.t3.runtime.checkError = null;
  s.t3.runtime.checkedAt = null;
  assert.equal(M.runtimeView(s).verified, false);
});

test("tool rows do not call a failed update check up to date", () => {
  const s = { toolchains: [{ id: 'go', installed: true, version: '1.27.1', latestVersion: '1.27.1' }], updates: { errors: { 'toolchain:go': 'offline' } } };
  assert.match(M.toolchainRows(s, ui(), NOW)[0].status.text, /couldn’t check for updates/);
  s.toolchains[0].latestVersion = '1.27.2';
  assert.equal(M.toolchainRows(s, ui(), NOW)[0].updateAvailable, true);
});

// ------------------------------------------------------------------- routes --

test("every page is named once, in the table the shell, router and palette read", () => {
  const routes = plain(R.PAGES.map((p) => p.route));
  assert.equal(new Set(routes).size, routes.length, "no route twice");
  assert.equal(new Set(R.PAGES.filter((p) => p.key).map((p) => p.key)).size, R.PAGES.filter((p) => p.key).length, "no shortcut twice");
  for (const page of R.PAGES) {
    assert.match(page.route, /^[a-z]+$/, page.route);
    assert.ok(page.title && page.icon && page.summary, page.route + " has a title, an icon and a summary");
    assert.ok(R.GROUPS.some((g) => g.id === page.group), page.route + " is in a sidebar group");
    assert.ok(!page.summary.endsWith(" "), page.route);
  }
  const goTo = plain(M.paletteItems(statusWith(), null, ui(), NOW)).filter((i) => i.group === "Go to");
  assert.deepEqual(goTo.map((i) => i.cmd.route), routes, "the palette reaches every page, in the sidebar's order");
  assert.ok(goTo.every((i) => /^G [A-Z]$/.test(i.shortcut)));
  // Tabs: the rest of the pages are under More.
  for (const tab of R.TABS) assert.equal(R.tabOf(tab.route), tab.route);
  assert.equal(R.tabOf("environment"), "more");
  // An address a page used to have still lands on it; one that names nothing does not.
  for (const [from, to] of Object.entries(R.ALIASES)) assert.equal(R.resolve(from), to);
  assert.equal(R.resolve("overview"), "overview");
  assert.equal(R.resolve("nowhere"), null);
});

test("a guide is linked at the release the image was built from", () => {
  assert.equal(R.docUrl("agents.md", "v0.19.0"), "https://github.com/dizys/t3code-docker/blob/v0.19.0/docs/agents.md");
  assert.equal(R.docUrl("agents.md", "0.19.0"), "https://github.com/dizys/t3code-docker/blob/v0.19.0/docs/agents.md");
  assert.equal(R.docUrl("agents.md", "main@0123456789abcdef0123"), "https://github.com/dizys/t3code-docker/blob/main/docs/agents.md", "a branch build reads main");
  assert.equal(R.docUrl("agents.md", null), "https://github.com/dizys/t3code-docker/blob/main/docs/agents.md");
});

// ------------------------------------------------------------------ updates --

test("the Updates page gathers every newer release, and Update all leaves T3 Code alone", () => {
  const s = statusWith({
    releaseAgeMs: DAY,
    harnesses: [harness("claude", { latestVersion: "2.0.0" }), harness("codex")],
    toolchains: [toolchain("go", { version: "1.27.1", latestVersion: "1.27.1", newestVersion: "1.27.2", newestReleasedAt: new Date(NOW - 3 * 60 * MIN).toISOString() }),
      toolchain("rust", { latestVersion: "9.9.9" })],
    t3: { port: 3773, runtime: { channel: "stable", version: "0.1.0", releases: { stable: { version: "0.1.1" } }, checkedAt: NOW } },
  });
  const view = M.updatesView(s, ui(), NOW);
  assert.deepEqual(plain(view.available.map((r) => r.id)), ["claude", "rust"]);
  assert.deepEqual(plain(view.due.map((r) => r.id)), ["claude", "rust"]);
  assert.deepEqual(plain(view.held.map((r) => r.id)), ["go"], "mise's day-old wait is shown, with no button");
  assert.equal(view.runtime.available, true);
  assert.equal(view.count, 3, "T3 Code's own release counts in the sidebar...");
  assert.equal(view.due.some((r) => r.id === "t3"), false, "...but restarts on its own button");
  assert.deepEqual(plain(M.navBadges(s, null, ui()).updates), { tone: "info", kind: "count", count: 3 });
  assert.equal(M.attentionCount(s, null, ui()), 0, "updates are offered, not owed");
  assert.equal(M.summaries(s, null, ui(), NOW).updates.text, "3 available");
  assert.equal(M.summaries(statusWith(), null, ui(), NOW).updates.text, "Up to date");
});

test("an update in progress stays on the Updates page until it ends", () => {
  const s = statusWith({ harnesses: [harness("claude", { latestVersion: "2.0.0", installedVersion: "1.0.0", version: "1.0.0" })],
    operations: { "harness:claude": { state: "running", kind: "update" } } });
  const view = M.updatesView(s, ui(), NOW);
  assert.deepEqual(plain(view.available.map((r) => r.id)), ["claude"]);
  assert.equal(view.due.length, 0, "Update all does not ask twice");
  assert.equal(view.running, 1);
  assert.deepEqual(plain(M.navBadges(s, null, ui()).updates), { tone: "info", kind: "running", count: 1 });
});

test("each automatic update schedule reads as a sentence", () => {
  const view = (policy) => M.autoUpdateView({ autoUpdate: { policy } }, NOW).schedule;
  const off = view({ providers: { enabled: false }, toolchains: { enabled: false }, t3: { enabled: false } });
  assert.equal(off.providers, "Off");
  const on = view({ providers: { enabled: true, checkMinutes: 180, idleMinutes: 30 }, toolchains: { enabled: true, checkMinutes: 90, idleMinutes: 15 }, t3: { enabled: true, checkMinutes: 60, idleMinutes: 45 } });
  assert.equal(on.providers, "Checks every 3 hours, and installs after 30 min without activity.");
  assert.equal(on.toolchains, "Checks every 1.5 hours, and installs after 15 min without activity.");
  assert.equal(on.t3, "Checks every 1 hour, and installs after 45 min without activity.");
});

test("update check failures can be read for every source at once", () => {
  const status = { updates: { errors: { "harness:claude": "offline", "toolchain:go": "rate limit" } } };
  assert.equal(M.updateCheckView(status, null).failures.length, 2);
  assert.equal(M.updateCheckView(status, "harness").failures.length, 1);
});
