import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { adapterProviders, skillAdapter, adapterDetection } from "../docker/setup/skills/adapters.mjs";
import { skillRoots, createSkillsService } from "../docker/setup/skills.mjs";

test("adapter registry covers every provider with portable project locations", () => {
  const ids = adapterProviders().map((entry) => entry.id).sort();
  assert.deepEqual(ids, ["antigravity", "claude", "codex", "cursor", "grok", "muse", "opencode", "pi"]);
  for (const { id, name } of adapterProviders()) {
    assert.match(name, /^[A-Za-z ]+$/);
    const adapter = skillAdapter(id, { home: "/home/fixture", env: {} });
    assert.equal(adapter.id, id);
    assert.equal(adapter.label, name);
    assert.ok(path.isAbsolute(adapter.globalDir));
    assert.ok(path.isAbsolute(adapter.detectDir));
    assert.equal(adapter.globalDir, path.join(adapter.detectDir, "skills"));
    if (adapter.projectDir !== null) {
      assert.match(adapter.projectDir, /^(\.[A-Za-z0-9_-]+)(\/[A-Za-z0-9_.-]+)*$/);
      assert.ok(!path.isAbsolute(adapter.projectDir));
    }
  }
  // Codex, Cursor, OpenCode and Antigravity share one project directory.
  for (const id of ["codex", "cursor", "opencode", "antigravity"]) {
    assert.equal(skillAdapter(id, { home: "/home/fixture", env: {} }).projectDir, ".agents/skills");
  }
  assert.equal(skillAdapter("grok", { home: "/home/fixture", env: {} }).projectDir, '.grok/skills');
  assert.equal(skillAdapter("muse", { home: "/home/fixture", env: {} }).projectDir, '.agents/skills');
  assert.equal(skillAdapter("pi", { home: "/home/fixture", env: {} }).projectDir, '.pi/skills');
  assert.throws(() => skillAdapter("unknown", { home: "/home/fixture", env: {} }), /Unknown skill provider/);
});

test("adapter global locations track the scanned primary roots and overrides", () => {
  const home = "/home/fixture";
  for (const { id } of adapterProviders()) {
    const adapter = skillAdapter(id, { home, env: {} });
    assert.equal(adapter.globalDir, skillRoots(id, { home, env: {} })[0].path);
  }
  const env = { CLAUDE_CONFIG_DIR: ".claude-alt", CODEX_HOME: ".codex-alt", GROK_HOME: ".grok-alt", XDG_CONFIG_HOME: ".cfg" };
  assert.equal(skillAdapter("claude", { home, env }).globalDir, path.join(home, ".claude-alt/skills"));
  assert.equal(skillAdapter("codex", { home, env }).globalDir, path.join(home, ".codex-alt/skills"));
  assert.equal(skillAdapter("grok", { home, env }).globalDir, path.join(home, ".grok-alt/skills"));
  assert.equal(skillAdapter("opencode", { home, env }).globalDir, path.join(home, ".cfg/opencode/skills"));
  assert.equal(skillAdapter("muse", { home, env }).globalDir, path.join(home, ".cfg/muse/skills"));
  assert.equal(skillAdapter("cursor", { home, env }).globalDir, path.join(home, ".cursor/skills"));
  assert.equal(skillAdapter("antigravity", { home, env }).globalDir, path.join(home, ".gemini/config/skills"));
});

test("detection reflects the install directory without failing", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-adapter-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const missing = await adapterDetection("claude", { home, env: {}, io: fs });
  assert.equal(missing.detected, false);
  assert.equal(missing.detectDir, path.join(home, ".claude"));
  await fs.mkdir(path.join(home, ".claude"), { recursive: true });
  const present = await adapterDetection("claude", { home, env: {}, io: fs });
  assert.equal(present.detected, true);
  // A broken io still reports undetected instead of throwing.
  const broken = await adapterDetection("codex", { home, env: {}, io: { stat: async () => { throw new Error("denied"); } } });
  assert.equal(broken.detected, false);
});

test("inventory exposes the adapter without gating management", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-adapter-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const service = createSkillsService({ home, env: {}, getHarness: async () => null });
  const undetected = await service.list("cursor", { refresh: true });
  assert.equal(undetected.adapter.id, "cursor");
  assert.equal(undetected.adapter.detected, false);
  assert.equal(undetected.adapter.globalDir, path.join(home, ".cursor/skills"));
  assert.equal(undetected.canCreate, true);
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  const detected = await service.list("cursor", { refresh: true });
  assert.equal(detected.adapter.detected, true);
});
