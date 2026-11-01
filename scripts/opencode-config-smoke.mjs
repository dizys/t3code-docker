#!/usr/bin/env node
// Verify migrated config with the real OpenCode CLI, without a model request.
// node scripts/opencode-config-smoke.mjs /absolute/path/to/opencode
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const setup = process.env.T3_SETUP_DIR || new URL("../docker/setup/", import.meta.url).href;
const { ensureOpencodeConfig } = await import(new URL("opencode-config.mjs", setup));
const { inspectOpenCodeSkills, nativeCommand } = await import(new URL("skills/native.mjs", setup));
const { withNativeProcess } = await import(process.env.T3_NATIVE_PROCESS_MODULE || new URL("../docker/harness/native-process.mjs", import.meta.url).href);
const executable = process.argv[2];
assert.ok(path.isAbsolute(executable || ""), "Pass an absolute OpenCode executable path.");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-opencode-layout-smoke-"));
try {
  const root = path.join(home, ".t3/agents/.config_opencode"), legacyRoot = path.join(home, ".config/opencode");
  const shared = path.join(home, ".t3/agents/.agents_skills");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/TOKEN|API_KEY|OPENCODE_|XDG_|CLAUDE_CONFIG_DIR|CODEX_HOME/.test(key)) delete env[key];
  Object.assign(env, { HOME: home, OPENCODE_CONFIG_DIR: root, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".data"), XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".state") });
  for (const directory of [root, shared, path.dirname(legacyRoot), path.join(home, ".agents"), path.join(home, "own-skills"), path.join(home, "own-agents")]) await fs.mkdir(directory, { recursive: true });
  await fs.symlink(root, legacyRoot);
  await fs.symlink(shared, path.join(home, ".agents/skills"));
  await fs.symlink(path.join(home, "own-skills"), path.join(root, "skills"));
  await fs.symlink(path.join(home, "own-agents"), path.join(root, "agents"));
  for (const [directory, name] of [[path.join(home, "own-skills"), "migration-own"], [shared, "migration-shared"]]) {
    await fs.mkdir(path.join(directory, name));
    await fs.writeFile(path.join(directory, name, "SKILL.md"), `---\nname: ${name}\ndescription: Disposable migration check\n---\nFixture.\n`);
  }
  await fs.writeFile(path.join(home, "own-agents/migration-agent.md"), "---\ndescription: Disposable migration agent\nmode: subagent\n---\nOnly a fixture.\n");
  await fs.writeFile(path.join(root, "opencode.jsonc"), '{"username":"config-migration-check","skills":["old"]}\n');
  await ensureOpencodeConfig({ home, env, legacyRoot });
  assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
  assert.equal((await fs.lstat(path.join(root, "skills"))).isSymbolicLink(), false);
  assert.equal((await fs.lstat(path.join(root, "agents"))).isSymbolicLink(), false);
  await assert.rejects(fs.lstat(legacyRoot), { code: "ENOENT" });
  const options = { executable, home, env, timeoutMs: 20000 };
  const native = await inspectOpenCodeSkills(options);
  const names = native.skills.map((skill) => skill.id || skill.name);
  assert.ok(names.includes("migration-own"), JSON.stringify(native.skills));
  assert.ok(names.includes("migration-shared"), JSON.stringify(native.skills));
  assert.ok(JSON.stringify(native.config).includes("config-migration-check"), "The persisted native config must be loaded.");
  if (native.major === 1) {
    assert.ok((await nativeCommand(options, ["debug", "agent", "migration-agent", "--pure"])).includes("migration-agent"));
    const file = path.join(root, "opencode.jsonc");
    const config = JSON.parse(await fs.readFile(file, "utf8"));
    config.skills = { paths: [path.join(root, "skills")] };
    await fs.writeFile(file, JSON.stringify(config));
    await ensureOpencodeConfig({ home, env });
    const fresh = await inspectOpenCodeSkills(options);
    assert.deepEqual(fresh.config.skills, config.skills, "Valid OpenCode 1 skills settings must remain usable.");
  } else {
    await withNativeProcess({ ...options, env: { ...env, OPENCODE_USERNAME: "opencode", OPENCODE_PASSWORD: "fixture" } }, ["serve", "--stdio", "--port", "0"], async ({ nextLine, signal }) => {
      const ready = JSON.parse(await nextLine()), url = new URL(ready.url);
      assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
      for (;;) {
        const response = await fetch(new URL("/api/agent", url), { signal, headers: { Authorization: "Basic " + Buffer.from("opencode:fixture").toString("base64") } });
        assert.equal(response.ok, true);
        const agents = await response.json();
        if (agents.data?.some((agent) => agent.id === "migration-agent")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
  }
  console.log(`OpenCode ${native.version}: migrated config, own/shared skills and custom agent discovery passed.`);
} finally {
  await fs.rm(home, { recursive: true, force: true });
}
