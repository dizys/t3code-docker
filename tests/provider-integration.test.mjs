import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProviderIntegration } from "../docker/provider-integration/index.mjs";
import { LAUNCHERS, launcherPathFor, launcherScript } from "../docker/provider-integration/launchers.mjs";
import { PROVIDERS, driverFor, idFor } from "../docker/provider-integration/providers.mjs";
import {
  applyManaged,
  baseDirFor,
  clearManaged,
  settingsPathFor,
  statePathFor,
} from "../docker/provider-integration/settings.mjs";

const HOME = "/home/t3";
const BASE = "/home/t3/.t3";
const SETTINGS = "/home/t3/.t3/userdata/settings.json";
const STATE = "/home/t3/.t3/provider-integration.json";
const LAUNCHER_DIR = "/home/t3/.local/share/t3-harness/launchers";
const launcher = (id) => launcherPathFor(LAUNCHER_DIR, id);

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const modes = new Map();
  const dirs = new Set();
  return {
    files,
    modes,
    dirs,
    async readFile(file) {
      if (!files.has(file)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(file);
    },
    async writeFile(file, data, options) {
      files.set(file, String(data));
      if (options?.mode) modes.set(file, options.mode);
    },
    async mkdir(dir) {
      dirs.add(dir);
    },
    async rename(from, to) {
      if (!files.has(from)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      files.set(to, files.get(from));
      files.delete(from);
      if (modes.has(from)) modes.set(to, modes.get(from));
      modes.delete(from);
    },
    async rm(file) {
      files.delete(file);
    },
    async stat(file) {
      if (!files.has(file) && !dirs.has(file)) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return { isFile: () => files.has(file) };
    },
    async exists(file) {
      return files.has(file) || dirs.has(file);
    },
  };
}

function fact(id, { runnable = false, executable = null } = {}) {
  return { id, runnable, executable, installed: runnable };
}

function fakeHarness(facts) {
  return {
    async status() {
      return { harnesses: facts, degraded: [] };
    },
  };
}

const json = (fs, file) => JSON.parse(fs.files.get(file));

test("provider mapping covers the five harnesses and their T3 driver kinds", () => {
  assert.deepEqual(
    PROVIDERS.map((provider) => provider.id),
    ["claude", "codex", "opencode", "grok", "cursor"],
  );
  assert.equal(driverFor("claude"), "claudeAgent");
  assert.equal(driverFor("cursor"), "cursor");
  assert.equal(idFor("claudeAgent"), "claude");
  assert.equal(idFor("nope"), null);
});

test("paths follow T3CODE_HOME and fall back to the home dotfile", () => {
  assert.equal(baseDirFor({}, HOME), path.join(HOME, ".t3"));
  assert.equal(baseDirFor({ T3CODE_HOME: "/data/t3" }, HOME), "/data/t3");
  assert.equal(baseDirFor({ T3CODE_HOME: "  " }, HOME), path.join(HOME, ".t3"));
  assert.equal(settingsPathFor(BASE), SETTINGS);
  assert.equal(statePathFor(BASE), STATE);
});

test("applyManaged preserves unrelated keys in both representations", () => {
  const settings = {
    defaultTheme: "dark",
    providers: {
      claudeAgent: { homePath: "/home/t3/.claude", launchArgs: "--chrome" },
      codex: { homePath: "/home/t3/.codex" },
    },
    providerInstances: {
      claudeAgent: {
        driver: "claudeAgent",
        enabled: false,
        displayName: "Personal",
        config: { launchArgs: "--chrome", autoCompactWindow: "300000" },
      },
    },
  };

  const { settings: next, changed } = applyManaged(settings, "claudeAgent", "/managed/claude");

  assert.equal(changed, true);
  assert.equal(next.defaultTheme, "dark");
  assert.equal(next.providers.codex.homePath, "/home/t3/.codex");
  assert.equal(next.providers.claudeAgent.binaryPath, "/managed/claude");
  assert.equal(next.providers.claudeAgent.launchArgs, "--chrome");
  assert.equal(next.providerInstances.claudeAgent.config.binaryPath, "/managed/claude");
  assert.equal(next.providerInstances.claudeAgent.config.autoCompactWindow, "300000");
  assert.equal(next.providerInstances.claudeAgent.config.launchArgs, "--chrome");
  assert.equal(next.providerInstances.claudeAgent.enabled, false);
  assert.equal(next.providerInstances.claudeAgent.displayName, "Personal");
});

test("applyManaged sets the value without mutating the input", () => {
  const settings = { providers: { codex: { homePath: "/x" } } };
  const { settings: next } = applyManaged(settings, "codex", "/managed/codex");
  assert.equal(settings.providers.codex.binaryPath, undefined);
  assert.equal(next.providers.codex.binaryPath, "/managed/codex");
});

test("applyManaged does not synthesize a providerInstances entry", () => {
  const { settings: next } = applyManaged({}, "grok", "/managed/grok");
  assert.equal(next.providers.grok.binaryPath, "/managed/grok");
  assert.equal(next.providerInstances, undefined);
});

test("clearManaged retracts only the exact recorded value", () => {
  const settings = {
    providers: {
      claudeAgent: { binaryPath: "/managed/claude", homePath: "/h" },
      cursor: { binaryPath: "/user/set/cursor" },
    },
    providerInstances: {
      claudeAgent: { driver: "claudeAgent", config: { binaryPath: "/managed/claude", x: 1 } },
    },
  };

  const { settings: next } = clearManaged(settings, "claudeAgent", "/managed/claude");
  assert.equal(next.providers.claudeAgent.binaryPath, undefined);
  assert.equal(next.providers.claudeAgent.homePath, "/h");
  assert.equal(next.providerInstances.claudeAgent.config.binaryPath, undefined);
  assert.equal(next.providerInstances.claudeAgent.config.x, 1);

  const untouched = clearManaged(settings, "cursor", "/managed/cursor");
  assert.equal(untouched.changed, false);
  assert.equal(untouched.settings.providers.cursor.binaryPath, "/user/set/cursor");
});

test("sync with nothing runnable neither creates settings nor state", async () => {
  const fs = memoryFs();
  const integration = createProviderIntegration({
    fs,
    home: HOME,
    baseDir: BASE,
    harness: fakeHarness(PROVIDERS.map((provider) => fact(provider.id))),
  });

  const report = await integration.sync();
  assert.equal(report.ok, true);
  assert.equal(report.settingsChanged, false);
  assert.equal(fs.files.has(SETTINGS), false);
  assert.equal(fs.files.has(STATE), false);
  assert.deepEqual(report.unchanged, PROVIDERS.map((provider) => provider.id));
});

test("sync applies a runnable executable and records what it wrote", async () => {
  const fs = memoryFs({
    [SETTINGS]: JSON.stringify({
      defaultTheme: "dark",
      providers: { codex: { homePath: "/home/t3/.codex" } },
    }),
  });
  const integration = createProviderIntegration({
    fs,
    home: HOME,
    baseDir: BASE,
    now: () => 42,
    harness: fakeHarness([
      fact("claude", { runnable: true, executable: "/mise/claude/2.1.270/claude" }),
      ...PROVIDERS.filter((p) => p.id !== "claude").map((p) => fact(p.id)),
    ]),
  });

  const report = await integration.sync();
  assert.equal(report.ok, true);
  assert.equal(report.settingsChanged, true);
  assert.deepEqual(report.applied, [
    { id: "claude", driver: "claudeAgent", executable: launcher("claude"), target: "/mise/claude/2.1.270/claude" },
  ]);

  // T3 runs the launcher, which runs the managed executable.
  const settings = json(fs, SETTINGS);
  assert.equal(settings.providers.claudeAgent.binaryPath, launcher("claude"));
  assert.ok(launcher("claude").endsWith("/.local/bin/claude"), "where T3 recognises Claude's own installer");
  assert.match(fs.files.get(launcher("claude")), /^exec '\/mise\/claude\/2\.1\.270\/claude' "\$@"$/m);
  assert.equal(fs.modes.get(launcher("claude")), 0o755);
  assert.equal(settings.providers.codex.homePath, "/home/t3/.codex");
  assert.equal(settings.defaultTheme, "dark");

  const state = json(fs, STATE);
  assert.deepEqual(state.managed.claude, {
    driver: "claudeAgent",
    executable: launcher("claude"),
    target: "/mise/claude/2.1.270/claude",
    at: 42,
  });
});

test("sync retracts a managed path on uninstall and leaves user values alone", async () => {
  const fs = memoryFs({
    [launcher("claude")]: "#!/bin/sh\nexec /mise/claude/old/claude \"$@\"\n",
    [SETTINGS]: JSON.stringify({
      providers: {
        claudeAgent: { binaryPath: "/mise/claude/old/claude", homePath: "/h" },
        cursor: { binaryPath: "/user/cursor" },
      },
    }),
    [STATE]: JSON.stringify({
      schema: 1,
      managed: { claude: { driver: "claudeAgent", executable: "/mise/claude/old/claude" } },
    }),
  });
  const integration = createProviderIntegration({
    fs,
    home: HOME,
    baseDir: BASE,
    harness: fakeHarness(PROVIDERS.map((provider) => fact(provider.id))),
  });

  const report = await integration.sync();
  assert.equal(report.cleared.length, 1);
  assert.equal(report.cleared[0].id, "claude");

  const settings = json(fs, SETTINGS);
  assert.equal(settings.providers.claudeAgent.binaryPath, undefined);
  assert.equal(settings.providers.claudeAgent.homePath, "/h");
  assert.equal(settings.providers.cursor.binaryPath, "/user/cursor");

  const state = json(fs, STATE);
  assert.deepEqual(state.managed, {});
  assert.equal(fs.files.has(launcher("claude")), false, "nothing left to launch");
});

test("sync adopts an existing explicit default instance without disturbing it", async () => {
  const fs = memoryFs({
    [SETTINGS]: JSON.stringify({
      providerInstances: {
        codex: { driver: "codex", enabled: false, config: { homePath: "/custom" } },
      },
    }),
  });
  const integration = createProviderIntegration({
    fs,
    home: HOME,
    baseDir: BASE,
    harness: fakeHarness([
      fact("codex", { runnable: true, executable: "/mise/codex/bin/codex" }),
      ...PROVIDERS.filter((p) => p.id !== "codex").map((p) => fact(p.id)),
    ]),
  });

  await integration.sync();
  const instance = json(fs, SETTINGS).providerInstances.codex;
  assert.equal(instance.config.binaryPath, launcher("codex"));
  assert.equal(instance.config.homePath, "/custom");
  assert.equal(instance.enabled, false);
});

test("sync refuses to overwrite an unreadable settings file", async () => {
  const fs = memoryFs({ [SETTINGS]: "{not json" });
  const integration = createProviderIntegration({
    fs,
    home: HOME,
    baseDir: BASE,
    harness: fakeHarness([
      fact("claude", { runnable: true, executable: "/mise/claude/claude" }),
    ]),
  });

  const report = await integration.sync();
  assert.equal(report.ok, false);
  assert.equal(report.code, "settings-unreadable");
  assert.equal(fs.files.get(SETTINGS), "{not json");
});

test("a degraded mise changes nothing, even with managed paths recorded", async () => {
  const claudePath = "/home/t3/.local/share/mise/installs/claude/2.1.273/claude";
  const settings = { providers: { claudeAgent: { binaryPath: claudePath, enabled: true } } };
  const state = { schema: 1, managed: { claude: { driver: "claudeAgent", executable: claudePath, at: 1 } } };
  const fs = memoryFs({
    [SETTINGS]: JSON.stringify(settings),
    [STATE]: JSON.stringify(state),
  });
  // What a failed `mise ls` really looks like: every harness reads as absent.
  const harness = {
    async status() {
      return {
        harnesses: PROVIDERS.map((provider) => fact(provider.id)),
        degraded: [{ what: "mise", error: "timed out after 120000ms" }],
      };
    },
  };
  const integration = createProviderIntegration({ fs, home: HOME, baseDir: BASE, harness });

  const report = await integration.sync();
  assert.equal(report.ok, false);
  assert.equal(report.code, "degraded");
  assert.match(report.error, /timed out/);
  assert.deepEqual(JSON.parse(fs.files.get(SETTINGS)), settings, "settings untouched");
  assert.deepEqual(JSON.parse(fs.files.get(STATE)), state, "managed record untouched");
});

test("sync keeps a binaryPath someone set, and replaces only T3's default name", async () => {
  const wrapper = "/home/t3/bin/my-codex-wrapper";
  const fs = memoryFs({
    [wrapper]: "#!/bin/sh\nexec codex \"$@\"\n",
    [SETTINGS]: JSON.stringify({
      providers: {
        codex: { binaryPath: wrapper },
        claudeAgent: { binaryPath: "claude" },
      },
    }),
  });
  const codexPath = "/home/t3/.local/share/mise/installs/codex/0.159.1/bin/codex";
  const claudePath = "/home/t3/.local/share/mise/installs/claude/2.1.285/claude";
  const harness = fakeHarness([
    fact("codex", { runnable: true, executable: codexPath }),
    fact("claude", { runnable: true, executable: claudePath }),
  ]);
  const integration = createProviderIntegration({ fs, home: HOME, baseDir: BASE, harness });

  const report = await integration.sync();
  assert.equal(report.ok, true);
  assert.deepEqual(report.kept.map((entry) => entry.id), ["codex"]);
  const written = JSON.parse(fs.files.get(SETTINGS));
  assert.equal(written.providers.codex.binaryPath, wrapper, "the wrapper survives");
  assert.equal(written.providers.claudeAgent.binaryPath, launcher("claude"), "the default name is replaced");
  const recorded = JSON.parse(fs.files.get(STATE));
  assert.equal(recorded.managed.codex, undefined, "a kept value is not claimed");
  assert.equal(recorded.managed.claude.executable, launcher("claude"));

  // Running again, and then after an uninstall, never touches the wrapper.
  await integration.sync();
  const nothingRunnable = fakeHarness(PROVIDERS.map((provider) => fact(provider.id)));
  const uninstalled = createProviderIntegration({ fs, home: HOME, baseDir: BASE, harness: nothingRunnable });
  await uninstalled.sync();
  assert.equal(JSON.parse(fs.files.get(SETTINGS)).providers.codex.binaryPath, wrapper);
});

test("a binaryPath to an executable that no longer exists is replaced", async () => {
  // What an upgrade from the old baked image can leave behind: an absolute
  // path into a prefix the new image does not have.
  const fs = memoryFs({
    [SETTINGS]: JSON.stringify({
      providers: { claudeAgent: { binaryPath: "/opt/npm-global/bin/claude", enabled: true } },
      providerInstances: { cursor: { driver: "cursor", config: { binaryPath: "/opt/cursor/.local/bin/cursor-agent" } } },
    }),
  });
  const claudePath = "/home/t3/.local/share/mise/installs/claude/2.1.285/claude";
  const cursorPath = "/home/t3/.local/share/mise/installs/cursor-agent/2026.09.28-64d2043/dist-package/cursor-agent";
  const harness = fakeHarness([
    fact("claude", { runnable: true, executable: claudePath }),
    fact("cursor", { runnable: true, executable: cursorPath }),
  ]);
  const report = await createProviderIntegration({ fs, home: HOME, baseDir: BASE, harness }).sync();
  assert.deepEqual(report.kept, []);
  const written = JSON.parse(fs.files.get(SETTINGS));
  assert.equal(written.providers.claudeAgent.binaryPath, launcher("claude"));
  assert.equal(written.providers.claudeAgent.enabled, true);
  assert.equal(written.providerInstances.cursor.config.binaryPath, launcher("cursor"));
});

test("sync leaves Codex alone when T3's own managed setup owns it", async () => {
  const fs = memoryFs({
    [SETTINGS]: JSON.stringify({
      providerInstances: { codex: { driver: "codex", config: { setupMode: "managed", binaryPath: "/home/t3/.t3/provider/codex/bin/codex" } } },
    }),
  });
  const harness = fakeHarness([
    fact("codex", { runnable: true, executable: "/home/t3/.local/share/mise/installs/codex/0.159.1/bin/codex" }),
  ]);
  const integration = createProviderIntegration({ fs, home: HOME, baseDir: BASE, harness });
  const before = fs.files.get(SETTINGS);
  const report = await integration.sync();
  assert.equal(report.ok, true);
  assert.ok(report.unchanged.includes("codex"));
  assert.equal(fs.files.get(SETTINGS), before);
});

test("sync skips a harness whose operation is still running", async () => {
  const claudePath = "/home/t3/.local/share/mise/installs/claude/2.1.273/claude";
  const fs = memoryFs({
    [SETTINGS]: JSON.stringify({ providers: { claudeAgent: { binaryPath: claudePath } } }),
    [STATE]: JSON.stringify({ schema: 1, managed: { claude: { driver: "claudeAgent", executable: claudePath, at: 1 } } }),
  });
  const harness = {
    async status() {
      return { harnesses: [{ ...fact("claude"), installed: true, inProgress: true }], degraded: [] };
    },
  };
  const integration = createProviderIntegration({ fs, home: HOME, baseDir: BASE, harness });
  const report = await integration.sync();
  assert.ok(report.unchanged.includes("claude"));
  assert.equal(JSON.parse(fs.files.get(SETTINGS)).providers.claudeAgent.binaryPath, claudePath);
});

test("an update replaces the recorded path", async () => {
  const fs = memoryFs({
    [SETTINGS]: JSON.stringify({ providers: { claudeAgent: { binaryPath: "/old/claude" } } }),
    [STATE]: JSON.stringify({
      schema: 1,
      managed: { claude: { driver: "claudeAgent", executable: "/old/claude" } },
    }),
  });
  const integration = createProviderIntegration({
    fs,
    home: HOME,
    baseDir: BASE,
    harness: fakeHarness([
      fact("claude", { runnable: true, executable: "/new/claude" }),
      ...PROVIDERS.filter((p) => p.id !== "claude").map((p) => fact(p.id)),
    ]),
  });

  // From an image before launchers, which pointed T3 at the executable itself.
  await integration.sync();
  assert.equal(json(fs, SETTINGS).providers.claudeAgent.binaryPath, launcher("claude"));
  assert.equal(json(fs, STATE).managed.claude.executable, launcher("claude"));
  assert.equal(json(fs, STATE).managed.claude.target, "/new/claude");

  // And the next update: T3's path stays, and the launcher runs the new release.
  const updated = createProviderIntegration({
    fs,
    home: HOME,
    baseDir: BASE,
    harness: fakeHarness([fact("claude", { runnable: true, executable: "/newer/claude" })]),
  });
  const report = await updated.sync();
  assert.equal(report.settingsChanged, false, "T3's settings are left as they are");
  assert.equal(json(fs, SETTINGS).providers.claudeAgent.binaryPath, launcher("claude"));
  assert.match(fs.files.get(launcher("claude")), /^exec '\/newer\/claude' "\$@"$/m);
  assert.equal(json(fs, STATE).managed.claude.target, "/newer/claude");
});

test("the managed executable itself, as an older image wrote it, is ours to replace", async () => {
  const exe = "/home/t3/.local/share/mise/installs/claude/2.1.285/claude";
  const fs = memoryFs({ [exe]: "", [SETTINGS]: JSON.stringify({ providers: { claudeAgent: { binaryPath: exe } } }) });
  const harness = fakeHarness([fact("claude", { runnable: true, executable: exe })]);
  const report = await createProviderIntegration({ fs, home: HOME, baseDir: BASE, harness }).sync();
  assert.deepEqual(report.kept, [], "with no record of having written it");
  assert.equal(json(fs, SETTINGS).providers.claudeAgent.binaryPath, launcher("claude"));
});

test("each launcher sits where T3 offers its own update, and hands that update to the manager", () => {
  // T3 Code 0.0.45's checks (providerMaintenance.ts), and what it runs.
  const shape = {
    claude: [(p) => p.endsWith("/.local/bin/claude"), "update"],
    codex: [(p) => p.includes("/packages/standalone/"), "update"],
    opencode: [(p) => p.endsWith("/.opencode/bin/opencode"), "upgrade"],
    grok: [() => true, "update"],
    cursor: [() => true, "update"],
  };
  assert.deepEqual(Object.keys(LAUNCHERS).sort(), PROVIDERS.map((p) => p.id).sort(), "one for every managed agent");
  for (const provider of PROVIDERS) {
    const [recognised, update] = shape[provider.id];
    const file = launcher(provider.id);
    assert.ok(recognised(file), `${provider.id}: ${file}`);
    assert.equal(path.basename(file), provider.defaultBinary, `${provider.id} keeps its command's name`);
    const script = launcherScript({ id: provider.id, name: provider.name, executable: "/mise/x", harnessCli: "/usr/local/bin/t3-harness" });
    assert.ok(script.includes(`if [ "$#" -eq 1 ] && [ "$1" = '${update}' ]; then exec '/usr/local/bin/t3-harness' update '${provider.id}'; fi`), provider.id);
  }
  // Any path, quoted for sh.
  const odd = launcherScript({ id: "claude", name: "Claude Code", executable: "/odd dir/it's/claude", harnessCli: "/usr/local/bin/t3-harness" });
  assert.match(odd, /^exec '\/odd dir\/it'\\''s\/claude' "\$@"$/m);
  assert.throws(() => launcherScript({ id: "nope", name: "x", executable: "/x", harnessCli: "/y" }));
});

test("the CLI resolves, reports exit codes, and syncs through the real file IO", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "provider-integration-"));
  try {
    const harnessModule = path.join(dir, "fake-harness.mjs");
    writeFileSync(
      harnessModule,
      [
        "export function createHarnessManager() {",
        "  const facts = {",
        "    claude: { id: 'claude', runnable: true, executable: process.env.FAKE_EXE },",
        "    codex: { id: 'codex', runnable: false, executable: null },",
        "  };",
        "  return {",
        "    async resolve(id) { return facts[id] ?? { id, runnable: false, executable: null }; },",
        "    async status() { return { harnesses: Object.values(facts), degraded: [] }; },",
        "  };",
        "}",
      ].join("\n"),
    );
    const exe = path.join(dir, "claude");
    writeFileSync(exe, "#!/bin/sh\necho claude \"$@\"\n", { mode: 0o755 });
    const harnessCli = path.join(dir, "t3-harness");
    writeFileSync(harnessCli, "#!/bin/sh\necho t3-harness \"$@\"\n", { mode: 0o755 });
    const cli = new URL("../docker/provider-integration/cli.mjs", import.meta.url).pathname;
    const env = {
      ...process.env,
      FAKE_EXE: exe,
      T3_HARNESS_MODULE: harnessModule,
      T3_HARNESS_CLI: harnessCli,
      HOME: dir,
      T3CODE_HOME: path.join(dir, ".t3"),
    };
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });

    const resolved = run("resolve", "claude");
    assert.equal(resolved.status, 0);
    assert.equal(resolved.stdout.trim(), exe);

    const missing = run("resolve", "codex");
    assert.equal(missing.status, 3);
    assert.equal(missing.stdout, "");

    const synced = run("sync", "--json");
    assert.equal(synced.status, 0);
    const report = JSON.parse(synced.stdout);
    const launched = path.join(dir, ".local", "share", "t3-harness", "launchers", "claude", ".local", "bin", "claude");
    assert.deepEqual(report.applied, [{ id: "claude", driver: "claudeAgent", executable: launched, target: exe }]);
    const settings = JSON.parse(
      readFileSync(path.join(dir, ".t3", "userdata", "settings.json"), "utf8"),
    );
    assert.equal(settings.providers.claudeAgent.binaryPath, launched);

    // Run as T3 runs it: anything goes to the managed executable, T3's update
    // call to the manager.
    const launch = (...args) => spawnSync(launched, args, { env, encoding: "utf8" });
    assert.equal(launch("--version").stdout, "claude --version\n");
    assert.equal(launch("update", "--force").stdout, "claude update --force\n", "claude's own update with other words is claude's");
    assert.equal(launch("update").stdout, "t3-harness update claude\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
