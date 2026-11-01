import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import * as fs from "node:fs/promises";
import { opencodeConfigRoot, ensureOpencodeLayout, normalizeOpencodeConfig, ensureOpencodeConfig } from "../docker/setup/opencode-config.mjs";
import { skillRoots } from "../docker/setup/skills.mjs";
import { writeProviderMcpEntry, readProviderMcp } from "../docker/setup/mcp/adapters.mjs";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-opencode-config-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, env: {} };
}

test("opencode config root follows OPENCODE_CONFIG_DIR and XDG_CONFIG_HOME", () => {
  assert.equal(opencodeConfigRoot("/home/t3", {}), "/home/t3/.config/opencode");
  assert.equal(opencodeConfigRoot("/home/t3", { XDG_CONFIG_HOME: ".cfg" }), "/home/t3/.cfg/opencode");
  assert.equal(opencodeConfigRoot("/home/t3", { XDG_CONFIG_HOME: "/cfg" }), "/cfg/opencode");
  assert.equal(opencodeConfigRoot("/home/t3", { OPENCODE_CONFIG_DIR: ".custom/oc" }), "/home/t3/.custom/oc");
  assert.equal(opencodeConfigRoot("/home/t3", { OPENCODE_CONFIG_DIR: "/custom/oc" }), "/custom/oc");
  assert.equal(opencodeConfigRoot("/home/t3", { OPENCODE_CONFIG_DIR: "  ", XDG_CONFIG_HOME: ".cfg" }), "/home/t3/.cfg/opencode");
});

test("layout replaces symlinked config, skills and agents dirs with real dirs", async (t) => {
  const f = await fixture(t);
  const store = path.join(f.home, "store");
  await fs.mkdir(store, { recursive: true });
  await fs.writeFile(path.join(store, "opencode.json"), '{"mcp":{}}');
  const root = opencodeConfigRoot(f.home, f.env);
  await fs.mkdir(path.dirname(root), { recursive: true });
  await fs.symlink(store, root);
  const before = await fs.lstat(root);
  assert.equal(before.isSymbolicLink(), true);
  const result = await ensureOpencodeLayout(f);
  assert.equal(result.root, root);
  assert.ok(result.fixed.some((entry) => entry.path === root));
  assert.ok(result.fixed.some((entry) => entry.path === path.join(root, "skills")));
  assert.ok(result.fixed.some((entry) => entry.path === path.join(root, "agents")));
  assert.equal((await fs.lstat(root)).isDirectory(), true);
  assert.equal((await fs.lstat(path.join(root, "skills"))).isDirectory(), true);
  assert.equal((await fs.lstat(path.join(root, "agents"))).isDirectory(), true);
  // Preserved config file from symlinked target, but not skills symlink contents.
  assert.equal(await fs.readFile(path.join(root, "opencode.json"), "utf8"), '{"mcp":{}}');
  // Idempotent second run changes nothing.
  const again = await ensureOpencodeLayout(f);
  assert.equal(again.fixed.length, 0);
});

test("layout replaces symlinked skills/agents children without copying shared contents", async (t) => {
  const f = await fixture(t);
  const root = opencodeConfigRoot(f.home, f.env);
  const shared = path.join(f.home, ".agents/skills/shared");
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, "SKILL.md"), "---\nname: shared\ndescription: Shared.\n---\n");
  await fs.mkdir(root, { recursive: true });
  await fs.symlink(path.join(f.home, ".agents/skills"), path.join(root, "skills"));
  await fs.mkdir(path.join(f.home, ".agents_agents"), { recursive: true });
  await fs.symlink(path.join(f.home, ".agents_agents"), path.join(root, "agents"));
  const result = await ensureOpencodeLayout(f);
  assert.ok(result.fixed.some((entry) => entry.path === path.join(root, "skills")));
  assert.ok(result.fixed.some((entry) => entry.path === path.join(root, "agents")));
  assert.equal((await fs.lstat(path.join(root, "skills"))).isDirectory(), true);
  assert.deepEqual(await fs.readdir(path.join(root, "skills")), []);
  // Shared skills remain intact and discoverable through native roots.
  assert.ok((await fs.stat(path.join(shared, "SKILL.md"))).isFile());
  const roots = skillRoots("opencode", f).map((entry) => entry.path);
  assert.ok(roots.includes(path.join(root, "skills")));
  assert.ok(roots.includes(path.join(f.home, ".agents/skills")));
});

test("layout honors OPENCODE_CONFIG_DIR override and legacy singular links", async (t) => {
  const f = await fixture(t);
  const env = { OPENCODE_CONFIG_DIR: ".custom/oc" };
  const root = opencodeConfigRoot(f.home, env);
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(f.home, ".config/opencode/skills"), { recursive: true });
  await fs.symlink(path.join(f.home, ".agents/skills"), path.join(root, "skills"));
  // Legacy singular symlink also normalized when present.
  await fs.mkdir(path.join(f.home, "shared-skill"), { recursive: true });
  await fs.symlink(path.join(f.home, "shared-skill"), path.join(root, "skill"));
  const result = await ensureOpencodeLayout({ home: f.home, env });
  assert.equal(result.root, root);
  assert.equal((await fs.lstat(path.join(root, "skills"))).isDirectory(), true);
  assert.equal((await fs.lstat(path.join(root, "skill"))).isDirectory(), true);
  // Default location untouched when override is set.
  assert.ok(((await fs.stat(path.join(f.home, ".config/opencode/skills"))).isDirectory()));
  assert.equal(skillRoots("opencode", { home: f.home, env })[0].path, path.join(root, "skills"));
});

test("normalize removes invalid top-level skills key and preserves the rest", async (t) => {
  const f = await fixture(t);
  const root = opencodeConfigRoot(f.home, f.env);
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, "opencode.json");
  await fs.writeFile(file, '{\n  "$schema": "https://opencode.ai/config.json",\n  "skills": ["/home/t3/.t3/agents/.agents_skills"],\n  "instructions": ["/home/t3/.t3/setup/context/AGENTS.md"],\n  "mcp": {}\n}\n', { mode: 0o600 });
  const result = await normalizeOpencodeConfig(f);
  assert.deepEqual(result.fixed, [file]);
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  assert.ok(!Object.hasOwn(parsed, "skills"));
  assert.deepEqual(parsed.instructions, ["/home/t3/.t3/setup/context/AGENTS.md"]);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  // Second run is a no-op.
  assert.deepEqual((await normalizeOpencodeConfig(f)).fixed, []);
});

test("normalize preserves JSONC comments and handles both json and jsonc", async (t) => {
  const f = await fixture(t);
  const root = opencodeConfigRoot(f.home, f.env);
  await fs.mkdir(root, { recursive: true });
  const jsonc = path.join(root, "opencode.jsonc");
  await fs.writeFile(jsonc, '{\n// keep\n"permission": {"skill": {"review": "allow"}},\n"skills": ["./shared"]\n}\n');
  const result = await normalizeOpencodeConfig(f);
  assert.deepEqual(result.fixed, [jsonc]);
  const content = await fs.readFile(jsonc, "utf8");
  assert.match(content, /keep/);
  assert.ok(!content.includes('"skills"'));
  assert.match(content, /permission/);
});

test("normalize leaves valid configs and missing files alone", async (t) => {
  const f = await fixture(t);
  const root = opencodeConfigRoot(f.home, f.env);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "opencode.json"), '{"permission":{"skill":{"review":"allow"}}}\n');
  assert.deepEqual((await normalizeOpencodeConfig(f)).fixed, []);
  const empty = await fixture(t);
  assert.deepEqual((await normalizeOpencodeConfig(empty)).fixed, []);
});

test("normalize preserves file symlinks while stripping the invalid key", async (t) => {
  const f = await fixture(t);
  const root = opencodeConfigRoot(f.home, f.env);
  await fs.mkdir(root, { recursive: true });
  const target = path.join(f.home, "store.json");
  await fs.writeFile(target, '{"skills":["./shared"],"mcp":{}}\n', { mode: 0o600 });
  await fs.symlink(target, path.join(root, "opencode.json"));
  const result = await normalizeOpencodeConfig(f);
  assert.deepEqual(result.fixed, [path.join(root, "opencode.json")]);
  assert.ok((await fs.lstat(path.join(root, "opencode.json"))).isSymbolicLink());
  const parsed = JSON.parse(await fs.readFile(target, "utf8"));
  assert.ok(!Object.hasOwn(parsed, "skills"));
});

test("MCP writes strip the invalid top-level skills key without touching permissions", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.home, ".config/opencode/opencode.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{"skills":["/shared"],"permission":{"skill":{"review":"allow"}},"mcp":{}}');
  await writeProviderMcpEntry(fs, "opencode", f, "probe", { type: "local", command: ["server"], enabled: true });
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  assert.ok(!Object.hasOwn(parsed, "skills"));
  assert.deepEqual(parsed.permission, { skill: { review: "allow" } });
  assert.ok(parsed.mcp.probe);
  assert.equal((await readProviderMcp(fs, "opencode", f)).servers[0].name, "probe");
});

test("ensure combines layout and normalize, keeping Claude/Codex shared roots", async (t) => {
  const f = await fixture(t);
  const root = opencodeConfigRoot(f.home, f.env);
  await fs.mkdir(path.dirname(root), { recursive: true });
  const store = path.join(f.home, "store");
  await fs.mkdir(store);
  await fs.symlink(store, root);
  await fs.mkdir(path.join(f.home, ".agents/skills"), { recursive: true });
  await fs.writeFile(path.join(root, "opencode.json"), '{"skills":["x"]}\n');
  const result = await ensureOpencodeConfig(f);
  assert.equal(result.root, root);
  assert.ok((await fs.lstat(root)).isDirectory());
  assert.ok((await fs.lstat(path.join(root, "skills"))).isDirectory());
  assert.ok((await fs.lstat(path.join(root, "agents"))).isDirectory());
  // Shared .agents/skills behavior unchanged for Codex/OpenCode (Claude uses only its own folder).
  for (const provider of ["codex", "opencode"]) {
    assert.ok(skillRoots(provider, f).some((entry) => entry.path === path.join(f.home, ".agents/skills")));
  }
  assert.ok(skillRoots("claude", f).some((entry) => entry.path === path.join(f.home, ".claude/skills")));
  // Agents dir is real and empty (zero agents expected).
  assert.deepEqual(await fs.readdir(path.join(root, "agents")), []);
});

test("migration preserves complete config trees and relative instruction links", async (t) => {
  const { home } = await fixture(t);
  const legacyRoot = path.join(home, ".config/opencode");
  const root = path.join(home, "state/agents/.config_opencode");
  await fs.mkdir(path.join(legacyRoot, "plugins"), { recursive: true });
  await fs.mkdir(path.join(legacyRoot, "skills/own/references"), { recursive: true });
  await fs.mkdir(path.join(home, "custom-agents"));
  await fs.writeFile(path.join(home, "custom-agents/review.md"), "Agent instructions");
  await fs.symlink("../../custom-agents", path.join(legacyRoot, "agents"));
  await fs.writeFile(path.join(legacyRoot, "opencode.jsonc"), '{"skills":["old"]}\n');
  await fs.writeFile(path.join(legacyRoot, "plugins/local.js"), "local plugin");
  await fs.writeFile(path.join(legacyRoot, "skills/own/SKILL.md"), "My skill");
  await fs.writeFile(path.join(legacyRoot, "skills/own/references/guide.md"), "Supporting file");
  await fs.writeFile(path.join(legacyRoot, "own.md"), "Private instructions", { mode: 0o640 });
  await fs.symlink("own.md", path.join(legacyRoot, "AGENTS.md"));
  await fs.symlink(path.join(legacyRoot, "own.md"), path.join(legacyRoot, "AGENTS.md.t3-context-backup"));
  const options = { home, env: { OPENCODE_CONFIG_DIR: root }, legacyRoot };
  await ensureOpencodeConfig(options);
  assert.equal(await fs.readFile(path.join(root, "plugins/local.js"), "utf8"), "local plugin");
  assert.equal(await fs.readFile(path.join(root, "agents/review.md"), "utf8"), "Agent instructions");
  assert.equal(await fs.readFile(path.join(root, "skills/own/references/guide.md"), "utf8"), "Supporting file");
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "Private instructions");
  assert.equal(await fs.realpath(path.join(root, "AGENTS.md.t3-context-backup")), path.join(root, "own.md"));
  assert.equal((await fs.stat(path.join(root, "own.md"))).mode & 0o777, 0o640);
  assert.equal((await fs.lstat(path.join(root, "agents"))).isSymbolicLink(), false);
  assert.equal(await fs.readFile(path.join(home, "custom-agents/review.md"), "utf8"), "Agent instructions");
  await assert.rejects(fs.lstat(legacyRoot), { code: "ENOENT" });
  assert.ok((await fs.lstat(`${legacyRoot}.t3-migrated`)).isDirectory());
  assert.deepEqual((await ensureOpencodeConfig(options)).fixedDirs, []);
});

test("materializing a config symlink keeps plugins, agents, skills and backups", async (t) => {
  const f = await fixture(t);
  const store = path.join(f.home, "store"), root = opencodeConfigRoot(f.home);
  await fs.mkdir(path.join(store, "agents"), { recursive: true });
  await fs.mkdir(path.join(store, "plugins"));
  await fs.writeFile(path.join(store, "agents/review.md"), "Keep my agent");
  await fs.writeFile(path.join(store, "plugins/tool.js"), "Keep my plugin");
  await fs.writeFile(path.join(store, "own.md"), "Keep instructions");
  await fs.symlink("own.md", path.join(store, "AGENTS.md.t3-context-backup"));
  await fs.mkdir(path.dirname(root), { recursive: true });
  await fs.symlink(store, root);
  await ensureOpencodeLayout(f);
  assert.equal(await fs.readFile(path.join(root, "agents/review.md"), "utf8"), "Keep my agent");
  assert.equal(await fs.readFile(path.join(root, "plugins/tool.js"), "utf8"), "Keep my plugin");
  assert.equal(await fs.realpath(path.join(root, "AGENTS.md.t3-context-backup")), path.join(root, "own.md"));
});

test("a failed config copy preserves the original directory link and target", async (t) => {
  const f = await fixture(t);
  const store = path.join(f.home, "store"), root = opencodeConfigRoot(f.home);
  await fs.mkdir(store); await fs.mkdir(path.dirname(root), { recursive: true });
  await fs.writeFile(path.join(store, "opencode.json"), '{"username":"keep"}');
  await fs.symlink(store, root);
  const io = { ...fs, cp: async () => { throw Object.assign(new Error("Disk full"), { code: "ENOSPC" }); } };
  await assert.rejects(ensureOpencodeLayout({ ...f, io }), { code: "ENOSPC" });
  assert.ok((await fs.lstat(root)).isSymbolicLink());
  assert.equal(await fs.readFile(path.join(root, "opencode.json"), "utf8"), '{"username":"keep"}');
  assert.deepEqual((await fs.readdir(path.dirname(root))).filter((name) => name.includes("t3-migrate-")), []);
});

test("normalization and MCP saves preserve valid OpenCode 1 skills objects", async (t) => {
  const f = await fixture(t);
  const root = opencodeConfigRoot(f.home), file = path.join(root, "opencode.jsonc");
  const skills = { paths: ["/custom/skills"], urls: ["https://example.com/skills/"] };
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(file, "// keep settings\n" + JSON.stringify({ skills, mcp: {} }));
  assert.deepEqual((await normalizeOpencodeConfig(f)).fixed, []);
  await writeProviderMcpEntry(fs, "opencode", f, "probe", { type: "local", command: ["server"], enabled: true });
  const content = await fs.readFile(file, "utf8");
  assert.ok(content.includes("// keep settings"));
  assert.deepEqual(JSON.parse(content.slice(content.indexOf("{"))).skills, skills);
});

test("legacy arrays with trailing commas are repaired without changing comments", async (t) => {
  const f = await fixture(t), root = opencodeConfigRoot(f.home);
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, "opencode.jsonc");
  await fs.writeFile(file, '{\r\n// keep\r\n"skills": ["old",],\r\n"username": "keep",\r\n}\r\n');
  assert.deepEqual((await normalizeOpencodeConfig(f)).fixed, [file]);
  const content = await fs.readFile(file, "utf8");
  assert.match(content, /\/\/ keep\r\n/);
  assert.match(content, /"username": "keep"/);
  assert.doesNotMatch(content, /"skills"/);
});
