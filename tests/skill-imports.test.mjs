import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSkillsService, skillRoots, skillMetadata } from "../docker/setup/skills.mjs";
import { createSkillImporter } from "../docker/setup/skills/imports.mjs";
import { localSkillPolicy } from "../docker/setup/skills/files.mjs";
const markdown = (body = "Use the reviewed workflow.") => `---\nname: review\ndescription: Review changes\n---\n${body}\n`;
async function fixture(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-import-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const put = async (name, content) => { const file = path.join(home, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); return file; };
  const source = await put("source/review/SKILL.md", markdown()); await put("source/review/references/guide.md", "Source reference");
  const script = await put("source/review/check.sh", "#!/bin/sh\nexit 0\n"); await fs.chmod(script, 0o755);
  const service = createSkillsService({ home, env: {}, ...options });
  const preview = () => service.previewSource(path.dirname(source));
  const plan = (previewId, providers = ["claude"]) => service.planImport(previewId, ["review"], providers);
  return { home, put, source, service, preview, plan };
}

test("preview and destination review do not write provider homes; install uses the exact preview and supports every provider", async (t) => {
  const f = await fixture(t, { env: { OPENCODE_CONFIG_DIR: "custom-opencode", CODEX_HOME: "custom-codex", CLAUDE_CONFIG_DIR: "custom-claude", GROK_HOME: "custom-grok", XDG_CONFIG_HOME: "custom-config" } });
  const preview = await f.preview(); assert.ok(preview.previewId); assert.equal(preview.skills[0].files.length, 3);
  const providers = ["claude", "codex", "opencode", "cursor", "grok", "muse", "antigravity", "pi"], plan = await f.plan(preview.previewId, providers);
  assert.equal(plan.canInstall, true); assert.equal(plan.destinations.length, 8);
  await assert.rejects(fs.stat(path.join(f.home, ".cursor")), { code: "ENOENT" });
  await fs.writeFile(f.source, markdown("Changed after preview"));
  const result = await f.service.installImport(preview.previewId, plan.planId);
  for (const entry of result.results) {
    assert.equal(entry.status, "installed"); assert.equal(await fs.readFile(path.join(entry.directory, "SKILL.md"), "utf8"), markdown());
    assert.equal(await fs.readFile(path.join(entry.directory, "references/guide.md"), "utf8"), "Source reference");
    assert.equal((await fs.stat(path.join(entry.directory, "check.sh"))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(entry.directory, "SKILL.md"))).mode & 0o777, 0o600);
  }
  assert.ok(plan.destinations.find((entry) => entry.provider === "opencode").directory.includes("custom-opencode"));
  assert.deepEqual(await f.service.installImport(preview.previewId, plan.planId), result, "retry is idempotent");
  await assert.rejects(fs.stat(path.join(f.home, ".agents/.skill-lock.json")), { code: "ENOENT" });
});

test("a partial result can review failed destinations again using the same immutable snapshot", async (t) => {
  let failCodex = true;
  const io = { ...fs, rename: async (from, to) => {
    if (failCodex && path.basename(from).startsWith(".t3-skill-import-") && to.includes(".codex")) throw new Error("Temporary write failure");
    return fs.rename(from, to);
  } };
  const f = await fixture(t, { io });
  const preview = await f.preview(), plan = await f.plan(preview.previewId, ["claude", "codex"]);
  assert(preview.expiresAt > preview.createdAt);
  const result = await f.service.installImport(preview.previewId, plan.planId);
  assert.deepEqual(result.results.map(entry => entry.status), ["installed", "failed"]);
  assert.deepEqual(await f.service.installImport(preview.previewId, plan.planId), result, "an unreviewed retry never repeats successful writes");
  await fs.writeFile(f.source, markdown("Later source changes must not be used"));
  failCodex = false;
  const retry = await f.plan(preview.previewId, ["codex"]);
  assert.notEqual(retry.planId, plan.planId);
  await assert.rejects(f.service.installImport(preview.previewId, plan.planId), { code: "conflict" });
  const installed = await f.service.installImport(preview.previewId, retry.planId);
  assert.equal(installed.results[0].status, "installed");
  assert.equal(await fs.readFile(path.join(f.home, ".codex/skills/review/SKILL.md"), "utf8"), markdown());
  assert.equal(await fs.readFile(path.join(f.home, ".claude/skills/review/SKILL.md"), "utf8"), markdown());
  await assert.rejects(f.plan(preview.previewId), { code: "conflict" });
});

test("reimport explicitly replaces the whole folder and supports stale-content rejection", async (t) => {
  const f = await fixture(t); let preview = await f.preview(), plan = await f.plan(preview.previewId);
  await f.service.installImport(preview.previewId, plan.planId);
  const directory = plan.destinations[0].directory;
  await f.put(".claude/skills/review/obsolete.md", "Old supporting file");
  preview = await f.preview(); plan = await f.plan(preview.previewId);
  assert.equal(plan.destinations[0].action, "replace");
  await assert.rejects(f.service.installImport(preview.previewId, plan.planId), { code: "conflict" });
  await fs.writeFile(path.join(directory, "references/guide.md"), "Concurrent edit");
  await assert.rejects(f.service.installImport(preview.previewId, plan.planId, true), { code: "conflict" });
  assert.equal(await fs.readFile(path.join(directory, "references/guide.md"), "utf8"), "Concurrent edit");
  plan = await f.plan(preview.previewId); assert.equal((await f.service.installImport(preview.previewId, plan.planId, true)).results[0].status, "installed");
  await assert.rejects(fs.stat(path.join(directory, "obsolete.md")), { code: "ENOENT" });
  const row = (await f.service.list("claude", { refresh: true })).skills.find((row) => row.name === "review");
  const detail = await f.service.read("claude", row.id); assert.equal(detail.canRemove, true);
  await f.service.remove("claude", row.id, detail.revision, detail.removalRevision);
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("package ownership, user links, non-skill folders and plugin roots stay protected", async (t) => {
  const f = await fixture(t); const preview = await f.preview();
  await f.put(".agents/.skill-lock.json", JSON.stringify({ version: 3, skills: { review: { source: "upstream/repo" } } }));
  let plan = await f.plan(preview.previewId); assert.equal(plan.canInstall, false); assert.match(plan.destinations[0].error, /package manager/);
  await assert.rejects(f.service.installImport(preview.previewId, plan.planId, true), { code: "unsupported" });
  await fs.rm(path.join(f.home, ".agents/.skill-lock.json"));
  await fs.mkdir(path.join(f.home, ".claude/skills"), { recursive: true }); await fs.symlink(path.dirname(f.source), path.join(f.home, ".claude/skills/review"));
  plan = await f.plan(preview.previewId); assert.equal(plan.canInstall, false); assert.match(plan.destinations[0].error, /linked skill/);
  await fs.rm(path.join(f.home, ".claude/skills/review")); await f.put(".claude/skills/review/notes", "Unrelated");
  plan = await f.plan(preview.previewId); assert.equal(plan.canInstall, false); assert.match(plan.destinations[0].error, /not an ordinary/);
  await fs.rm(path.join(f.home, ".claude/skills"), { recursive: true });
  const plugin = path.join(f.home, ".claude/plugins/package/skills"); await fs.mkdir(plugin, { recursive: true }); await fs.symlink(plugin, path.join(f.home, ".claude/skills"));
  plan = await f.plan(preview.previewId); assert.equal(plan.canInstall, false);
});

test("destination aliases deduplicate, root retargeting conflicts and unavailable locks fail closed", async (t) => {
  const f = await fixture(t); const shared = path.join(f.home, "shared"); await fs.mkdir(shared);
  await fs.mkdir(path.join(f.home, ".claude")); await fs.mkdir(path.join(f.home, ".codex"));
  await fs.symlink(shared, path.join(f.home, ".claude/skills")); await fs.symlink(shared, path.join(f.home, ".codex/skills"));
  const preview = await f.preview(); let plan = await f.plan(preview.previewId, ["claude", "codex"]);
  assert.equal(plan.destinations.length, 1); assert.deepEqual(plan.destinations[0].also, ["codex"]);
  await fs.unlink(path.join(f.home, ".claude/skills")); await fs.symlink(path.dirname(f.source), path.join(f.home, ".claude/skills"));
  await assert.rejects(f.service.installImport(preview.previewId, plan.planId), { code: "conflict" });
  await f.put(".agents/.skill-lock.json", "Invalid JSON"); plan = await f.plan(preview.previewId); assert.equal(plan.canInstall, false);
});

test("failed directory publication restores the original and reports each partial result accurately", async (t) => {
  const io = { ...fs, rename: async (from, to) => {
    if (path.basename(from).startsWith(".t3-skill-import-") && to.includes(".claude")) throw new Error("Simulated publication failure");
    return fs.rename(from, to);
  } };
  const f = await fixture(t, { io }); await f.put(".claude/skills/review/SKILL.md", markdown("Original"));
  const preview = await f.preview(), plan = await f.plan(preview.previewId, ["claude", "codex"]);
  const result = await f.service.installImport(preview.previewId, plan.planId, true);
  assert.equal(result.results[0].status, "failed"); assert.equal(result.results[1].status, "installed");
  assert.equal(await fs.readFile(path.join(f.home, ".claude/skills/review/SKILL.md"), "utf8"), markdown("Original"));
  assert.deepEqual(await fs.readdir(path.join(f.home, ".claude/skills")), ["review"]);
});

test("moved-entry changes roll back, preserving newly added supporting files", async (t) => {
  let changed = false;
  const io = { ...fs, rename: async (from, to) => { await fs.rename(from, to); if (!changed && path.basename(to).startsWith(".t3-skill-backup-")) { changed = true; await fs.writeFile(path.join(to, "concurrent.md"), "Keep this"); } } };
  const f = await fixture(t, { io }); await f.put(".claude/skills/review/SKILL.md", markdown("Original"));
  const preview = await f.preview(), plan = await f.plan(preview.previewId);
  const result = await f.service.installImport(preview.previewId, plan.planId, true);
  assert.equal(result.results[0].status, "failed");
  assert.equal(await fs.readFile(path.join(f.home, ".claude/skills/review/concurrent.md"), "utf8"), "Keep this");
});

test("preview IDs, selection, expiry, disposal and concurrent requests are bounded", async (t) => {
  const f = await fixture(t); let now = 0;
  const service = createSkillImporter({ home: f.home, env: {}, io: fs, metadata: skillMetadata, now: () => now, ttlMs: 10,
    policyFor: (provider) => localSkillPolicy({ provider, roots: skillRoots(provider, { home: f.home }), home: f.home, env: {}, io: fs }), invalidate: () => {} });
  const preview = await service.previewSource(path.dirname(f.source));
  for (const [names, providers] of [[[], ["claude"]], [["not-in-preview"], ["claude"]], [["review"], []], [["review"], ["claude", "claude"]]]) await assert.rejects(service.planImport(preview.previewId, names, providers), { code: "invalid" });
  await assert.rejects(service.installImport(preview.previewId, "forged"), { code: "conflict" });
  now = 11; await assert.rejects(service.planImport(preview.previewId, ["review"], ["claude"]), /expired/);
  const next = await service.previewSource(path.dirname(f.source)); await service.discardImport(next.previewId);
  await assert.rejects(service.planImport(next.previewId, ["review"], ["claude"]), /expired/);
  for (let i = 0; i < 3; i++) await service.previewSource(path.dirname(f.source));
  await assert.rejects(service.previewSource(path.dirname(f.source)), /Close another/);
});


test("parallel destination review cannot supersede an installing plan, and duplicate installs share one write", async (t) => {
  const f = await fixture(t); let paused = false, entered, release, writes = 0;
  const io = { ...fs, writeFile: async (...args) => { writes++; return fs.writeFile(...args); } };
  const service = createSkillImporter({ home: f.home, env: {}, io, metadata: skillMetadata, invalidate: () => {},
    policyFor: async (provider) => { if (paused) { entered(); await new Promise((resolve) => { release = resolve; }); paused = false; }
      return localSkillPolicy({ provider, roots: skillRoots(provider, { home: f.home }), home: f.home, env: {}, io }); },
  });
  const preview = await service.previewSource(path.dirname(f.source));
  const plan = await service.planImport(preview.previewId, ["review"], ["claude"]);
  paused = true; const started = new Promise((resolve) => { entered = resolve; });
  const reviewing = service.planImport(preview.previewId, ["review"], ["claude"]); await started;
  await assert.rejects(service.installImport(preview.previewId, plan.planId), { code: "conflict" });
  await assert.rejects(service.discardImport(preview.previewId), { code: "conflict" });
  await assert.rejects(service.planImport(preview.previewId, ["review"], ["claude"]), { code: "conflict" });
  release(); const current = await reviewing;
  const results = await Promise.all([service.installImport(preview.previewId, current.planId), service.installImport(preview.previewId, current.planId)]);
  assert.deepEqual(results[0], results[1]); assert.equal(writes, 3);
});


test("a failed backup move reports the actual failure without inventing a recovery path", async (t) => {
  const io = { ...fs, rename: async (from, to) => {
    if (path.basename(to).startsWith(".t3-skill-backup-")) throw Object.assign(new Error("The original folder is mounted"), { code: "EBUSY" });
    return fs.rename(from, to);
  } };
  const f = await fixture(t, { io }); await f.put(".claude/skills/review/SKILL.md", markdown("Original"));
  const preview = await f.preview(), plan = await f.plan(preview.previewId);
  const result = await f.service.installImport(preview.previewId, plan.planId, true);
  assert.equal(result.results[0].status, "failed"); assert.equal(result.results[0].error, "The original folder is mounted");
  assert.deepEqual(await fs.readdir(path.join(f.home, ".claude/skills")), ["review"]);
  assert.equal(await fs.readFile(path.join(f.home, ".claude/skills/review/SKILL.md"), "utf8"), markdown("Original"));
});

test("a failed restore identifies the real preserved backup", async (t) => {
  const io = { ...fs, rename: async (from, to) => {
    if (path.basename(from).startsWith(".t3-skill-import-") || path.basename(from).startsWith(".t3-skill-backup-")) throw new Error("Simulated publication/restore failure");
    return fs.rename(from, to);
  } };
  const f = await fixture(t, { io }); await f.put(".claude/skills/review/SKILL.md", markdown("Original"));
  const preview = await f.preview(), plan = await f.plan(preview.previewId);
  const result = await f.service.installImport(preview.previewId, plan.planId, true);
  assert.equal(result.results[0].status, "failed");
  const entries = await fs.readdir(path.join(f.home, ".claude/skills")), backup = entries.find((entry) => entry.startsWith(".t3-skill-backup-"));
  assert.ok(backup); assert.ok(result.results[0].error.includes(backup));
  assert.equal(await fs.readFile(path.join(f.home, ".claude/skills", backup, "SKILL.md"), "utf8"), markdown("Original"));
});

test("replacement detects supporting-file edits with restored mtimes and retargeted secondary aliases", async (t) => {
  const f = await fixture(t); await f.put(".claude/skills/review/SKILL.md", markdown("Original"));
  const supporting = await f.put(".claude/skills/review/guide.md", "one"), before = await fs.stat(supporting);
  const preview = await f.preview(), plan = await f.plan(preview.previewId);
  await fs.writeFile(supporting, "two"); await fs.utimes(supporting, before.atime, before.mtime);
  await assert.rejects(f.service.installImport(preview.previewId, plan.planId, true), { code: "conflict" });
  assert.equal(await fs.readFile(supporting, "utf8"), "two");

  const g = await fixture(t); const shared = path.join(g.home, "shared"), moved = path.join(g.home, "moved");
  await fs.mkdir(shared); await fs.mkdir(moved); await fs.mkdir(path.join(g.home, ".claude")); await fs.mkdir(path.join(g.home, ".codex"));
  await fs.symlink(shared, path.join(g.home, ".claude/skills")); const alias = path.join(g.home, ".codex/skills"); await fs.symlink(shared, alias);
  let retargeted = false;
  const io = { ...fs, writeFile: async (...args) => { await fs.writeFile(...args); if (!retargeted) { retargeted = true; await fs.unlink(alias); await fs.symlink(moved, alias); } } };
  const service = createSkillsService({ home: g.home, env: {}, io });
  const other = await service.previewSource(path.dirname(g.source)), targets = await service.planImport(other.previewId, ["review"], ["claude", "codex"]);
  const result = await service.installImport(other.previewId, targets.planId);
  assert.equal(result.results[0].status, "failed"); assert.deepEqual(await fs.readdir(shared), []); assert.deepEqual(await fs.readdir(moved), []);
});
