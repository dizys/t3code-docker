import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSkillsService } from "../docker/setup/skills.mjs";
import { ORIGIN_FILE } from "../docker/setup/skills/origins.mjs";
import { resolveSkillSource } from "../docker/setup/skills/sources.mjs";
import { autoUpdateCandidate } from "../docker/setup/skills/update-review.mjs";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-skill-updates-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let pause = null;
  let guide = "Original guide", executable = false, failure = false, removed = false, calls = 0;
  const source = "https://github.com/example/skills/tree/main/skills/review";
  const content = "---\nname: review\ndescription: Review changes\n---\nInstructions\n";
  const resolveSource = async (value) => {
    assert.equal(value, source); calls++;
    if (pause) await pause;
    if (failure) throw Error("Repository unavailable");
    return { source, sourceType: "git", sourceInfo: { ref: "main", commit: "a".repeat(40) }, warnings: [], skills: removed ? [] : [{ name: "review", description: "Review changes", content, files: [
      { name: "SKILL.md", data: Buffer.from(content), mode: 0o600 },
      { name: "references/guide.md", data: Buffer.from(guide), mode: executable ? 0o700 : 0o600 },
    ] }] };
  };
  const options = { home, env: {}, resolveSource };
  const service = createSkillsService(options);
  const install = async (replace = false) => {
    const preview = await service.previewSource(source);
    const plan = await service.planImport(preview.previewId, ["review"], ["claude"]);
    return service.installImport(preview.previewId, plan.planId, replace);
  };
  await install();
  const row = async () => (await service.list("claude", { refresh: true })).skills[0];
  return { home, service, options, source, install, row, pause: (promise) => { pause = promise; }, calls: () => calls,
    change: () => { guide = "New upstream guide"; }, chmod: () => { executable = true; }, fail: () => { failure = true; }, remove: () => { removed = true; } };
}

test("repository origins survive restarts; checks detect supporting-file updates without writing skills", async (t) => {
  const f = await fixture(t), row = await f.row(), calls = f.calls();
  assert.equal(row.origin.source, f.source);
  const restarted = createSkillsService(f.options);
  assert.equal((await restarted.list("claude")).skills[0].origin.source, f.source);
  assert.equal(f.calls(), calls, "inventory never contacts the repository");
  assert.equal((await f.service.checkUpdate("claude", row.id)).update.status, "current");
  const local = path.join(path.dirname(row.path), "references/guide.md");
  await fs.writeFile(local, "Local edits");
  assert.equal((await f.service.checkUpdate("claude", row.id)).update.status, "current", "local changes do not masquerade as upstream updates");
  f.change();
  assert.equal((await f.service.checkUpdate("claude", row.id)).update.status, "available");
  assert.equal((await f.row()).update.status, "available");
  assert.equal(await fs.readFile(local, "utf8"), "Local edits");
  await assert.rejects(f.install(), /Confirm replacement/);
  assert.equal((await f.install(true)).results[0].status, "installed");
  assert.equal((await f.row()).update, undefined, "the old check does not attach to the new snapshot");
  assert.equal((await f.service.checkUpdate("claude", row.id)).update.status, "current");
  assert.equal(await fs.readFile(local, "utf8"), "New upstream guide");
});

test("file executability changes count as updates; unavailable and removed sources report errors", async (t) => {
  const f = await fixture(t), row = await f.row();
  f.chmod(); assert.equal((await f.service.checkUpdate("claude", row.id)).update.status, "available");
  f.remove(); assert.match((await f.service.checkUpdate("claude", row.id)).update.error, /renamed or removed/);
  f.fail(); assert.match((await f.service.checkUpdate("claude", row.id)).update.error, /Repository unavailable/);
});

test("pinned source metadata is retained on current, available and missing-skill results", async t => {
  const f = await fixture(t), row = await f.row();
  for (const status of ["current", "available", "error"]) {
    if (status === "available") f.change();
    if (status === "error") f.remove();
    const result = await f.service.checkUpdate("claude", row.id);
    assert.equal(result.update.status, status);
    assert.equal(result.update.ref, "main"); assert.equal(result.update.commit, "a".repeat(40));
    assert.equal((await f.row()).update.commit, "a".repeat(40), "inventory retains checked source metadata until service restart");
  }
  f.fail();
  const failed = await f.service.checkUpdate("claude", row.id);
  assert.equal(failed.update.ref, null); assert.equal(failed.update.commit, null);
});

test("untracked, malformed and linked provenance cannot trigger repository checks", async (t) => {
  const f = await fixture(t), row = await f.row();
  const file = path.join(path.dirname(row.path), ORIGIN_FILE), calls = f.calls();
  await fs.writeFile(file, JSON.stringify({ version: 1, source: "/etc", name: "review", fingerprint: "a".repeat(64) }));
  assert.equal((await f.row()).origin, undefined);
  await assert.rejects(f.service.checkUpdate("claude", row.id), /no tracked repository/);
  await fs.rm(file); await fs.symlink("/etc/passwd", file);
  assert.equal((await f.row()).origin, undefined);
  assert.equal(f.calls(), calls);
});


test("concurrent checks share a fetch and discard results for a removed installation", { timeout: 3000 }, async (t) => {
  const f = await fixture(t), row = await f.row(), before = f.calls();
  let release;
  f.pause(new Promise((resolve) => { release = resolve; }));
  const first = f.service.checkUpdate("claude", row.id);
  const second = f.service.checkUpdate("claude", row.id);
  // Both reads share the inventory; wait until the source fetch starts.
  while (f.calls() === before) await new Promise((resolve) => setTimeout(resolve, 5));
  await fs.rm(path.join(path.dirname(row.path), ORIGIN_FILE));
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(f.calls(), before + 1);
  assert.ok(results.every((entry) => entry.status === "rejected"));
  assert.equal((await f.row()).update, undefined);
});


test("copying an imported skill keeps local files without inheriting repository tracking", async (t) => {
  const f = await fixture(t), row = await f.row();
  const guide = path.join(path.dirname(row.path), "references/guide.md");
  await fs.writeFile(guide, "Local changes to copy"); await fs.chmod(guide, 0o700);
  const local = createSkillsService({ home: f.home, env: {} });
  const preview = await local.previewSource(path.dirname(row.path));
  assert.equal(preview.skills[0].files.some(file => file.name === ORIGIN_FILE), false);
  const plan = await local.planImport(preview.previewId, ["review"], ["cursor"]);
  const result = await local.installImport(preview.previewId, plan.planId);
  assert.equal(result.results[0].status, "installed");
  const copied = (await local.list("cursor")).skills.find(skill => skill.source === "Provider");
  assert.equal(copied.origin, undefined);
  const directory = path.dirname(copied.path);
  await assert.rejects(fs.stat(path.join(directory, ORIGIN_FILE)), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(directory, "references/guide.md"), "utf8"), "Local changes to copy");
  assert.ok((await fs.stat(path.join(directory, "references/guide.md"))).mode & 0o100);
  assert.equal((await f.row()).origin.source, f.source);
});

test("a Git source cannot supply its own tracking metadata", async (t) => {
  const f = await fixture(t);
  const service = createSkillsService({ ...f.options, resolveSource: async (...args) => {
    const source = await f.options.resolveSource(...args);
    source.skills[0].files.push({ name: ORIGIN_FILE, data: Buffer.from("{}"), mode: 0o600 });
    return source;
  } });
  const preview = await service.previewSource(f.source), plan = await service.planImport(preview.previewId, ["review"], ["cursor"]);
  const result = await service.installImport(preview.previewId, plan.planId);
  assert.equal(result.results[0].status, "failed"); assert.match(result.results[0].error, /reserved skill tracking metadata/);
});

test("a batch checks one repository once, refreshes on the next batch, and isolates missing installations", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-skill-batch-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let calls = 0, nativeCalls = 0, failure = false;
  const source = "example/library", skills = Array.from({ length: 20 }, (_, i) => {
    const name = "skill-" + i, content = `---\nname: ${name}\ndescription: Example skill\n---\nOriginal\n`;
    return { name, content, files: [{ name: "SKILL.md", data: Buffer.from(content), mode: 0o600 }] };
  });
  const service = createSkillsService({ home, env: {}, getHarness: async () => ({ runnable: true, executable: "/fixture/codex" }),
    nativeCodex: async () => { nativeCalls++; return { skills: [], errors: [] }; }, resolveSource: async () => {
    calls++; if (failure) throw Error("Repository unavailable");
    return { source, sourceType: "git", warnings: [], skills };
  } });
  const preview = await service.previewSource(source), plan = await service.planImport(preview.previewId, skills.map(skill => skill.name), ["codex"]);
  await service.installImport(preview.previewId, plan.planId);
  const rows = (await service.list("codex")).skills, entries = rows.map(row => ({ provider: "codex", id: row.id }));
  calls = nativeCalls = 0;
  let result = await service.checkUpdates(entries);
  assert.equal(calls, 1); assert.equal(result.results.length, 20);
  assert.equal(nativeCalls, 0, "batch checks reuse the inventory instead of starting Codex for every skill");
  assert.equal((await service.list("codex")).skills[0].update.status, "current", "finished checks invalidate the cached inventory");
  assert.ok(result.results.every(row => row.ok && row.update.status === "current"));
  skills[0].files[0].data = Buffer.from(skills[0].content + "Upstream change\n");
  await fs.rm(path.dirname(rows[1].path), { recursive: true });
  result = await service.checkUpdates(entries);
  assert.equal(calls, 2);
  assert.equal(result.results.find(row => row.id === rows[1].id).ok, false);
  assert.equal(result.results.find(row => row.id === rows.find(row => row.name === "skill-0").id).update.status, "available");
  assert.equal(result.results.filter(row => row.ok).length, 19);
  failure = true; result = await service.checkUpdates(entries);
  assert.equal(calls, 3);
  assert.ok(result.results.filter(row => row.ok).every(row => row.update.status === "error"));
  for (const bad of [[], null, [null], [{ provider: "unknown", id: "a".repeat(32) }], [{ provider: "claude", id: "/etc" }], [entries[0], entries[0]], Array(1793).fill(entries[0])]) {
    await assert.rejects(service.checkUpdates(bad), { code: "invalid" });
  }
});

test("duplicate-source precedence is preserved through tracked update checks and replacement", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-source-updates-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const markdown = body => "---\nname: review\ndescription: Review changes\n---\n" + body + "\n";
  const files = [
    { path: ".example-agent/skills/review/SKILL.md", object: "a".repeat(40), data: markdown("Agent variant") },
    { path: "skills/review/SKILL.md", object: "b".repeat(40), data: markdown("Published instructions") },
    { path: "skills/review/guide.md", object: "c".repeat(40), data: "Original published guide" },
  ];
  const run = async (command, args) => {
    if (args.includes("clone")) return { stdout: Buffer.alloc(0) };
    if (args.includes("rev-parse")) return { stdout: Buffer.from("d".repeat(40)) };
    if (args.includes("ls-tree")) return { stdout: Buffer.from(files.map(file => `100644 blob ${file.object} ${Buffer.byteLength(file.data)}\t${file.path}\0`).join("")) };
    return { stdout: Buffer.from(files.find(file => file.object === args.at(-1)).data) };
  };
  const service = createSkillsService({ home, env: {}, resolveSource: (source, options) => resolveSkillSource(source, { ...options, run }) });
  const source = "example/library";
  const preview = await service.previewSource(source);
  assert.deepEqual(preview.skills.map(skill => skill.name), ["review"]);
  assert.equal(preview.skills[0].content, files[1].data);
  const plan = await service.planImport(preview.previewId, ["review"], ["claude"]);
  assert.equal((await service.installImport(preview.previewId, plan.planId)).results[0].status, "installed");
  const row = (await service.list("claude", { refresh: true })).skills[0];
  assert.equal(row.origin.source, source);
  const checked = await service.checkUpdate("claude", row.id);
  assert.equal(checked.update.ref, null, "a shorthand repository retains its default-branch selection");
  assert.equal(checked.update.commit, "d".repeat(40));
  files[0].data = markdown("Changed agent variant");
  assert.equal((await service.checkUpdate("claude", row.id)).update.status, "current");
  files[2].data = "Updated published guide";
  assert.equal((await service.checkUpdate("claude", row.id)).update.status, "available");
  const update = await service.previewSource(source), replacement = await service.planImport(update.previewId, ["review"], ["claude"]);
  await assert.rejects(service.installImport(update.previewId, replacement.planId), /Confirm replacement/);
  assert.equal((await service.installImport(update.previewId, replacement.planId, true)).results[0].status, "installed");
  assert.equal(await fs.readFile(path.join(path.dirname(row.path), "guide.md"), "utf8"), "Updated published guide");
  assert.equal((await service.checkUpdate("claude", row.id)).update.status, "current");
});

test("links default to manual-only; tracked replacements carry opt-in flags over", async (t) => {
  const f = await fixture(t), row = await f.row();
  assert.equal(row.origin.autoUpdate, false);
  assert.equal(row.origin.manual, false);
  await f.service.linkSource("claude", row.id, f.source);
  assert.equal((await f.row()).origin.autoUpdate, false, "links default to manual-only");
  assert.equal((await f.row()).origin.manual, true);
  await f.service.linkSource("claude", row.id, f.source, { autoUpdate: true });
  assert.equal((await f.row()).origin.autoUpdate, true, "explicit opt-in sticks");
  f.change();
  const view = await f.service.previewUpdate("claude", row.id);
  assert.equal(view.localChanges, false);
  await f.service.installUpdate(view.previewId, view.planId, true);
  const updated = await f.row();
  assert.equal(updated.origin.autoUpdate, true, "a tracked update carries the opt-in over");
  assert.equal(updated.origin.manual, true);
});

test("linking a single differently named skill requires confirmation", async (t) => {
  const f = await fixture(t), row = await f.row();
  const skills = (name) => [{ name, description: name, content: `---\nname: ${name}\ndescription: ${name}\n---\n`,
    files: [{ name: "SKILL.md", data: Buffer.from(`---\nname: ${name}\ndescription: ${name}\n---\n`), mode: 0o600 }] }];
  const service = (list) => createSkillsService({ home: f.home, env: {}, resolveSource: async () =>
    ({ source: "example/other", sourceType: "git", sourceInfo: null, warnings: [], skills: list }) });
  await assert.rejects(service(skills("other")).linkSource("claude", row.id, "example/other"), { code: "mismatch" });
  await assert.rejects(service([skills("a")[0], skills("b")[0]]).linkSource("claude", row.id, "example/other"), { code: "missing" });
  const linked = await service(skills("other")).linkSource("claude", row.id, "example/other", { allowNameMismatch: true });
  assert.equal(linked.origin.name, "other");
  assert.equal(linked.origin.autoUpdate, false, "confirmed links still default to manual-only");
});

test("the idle pass installs only checked, opted-in updates", () => {
  const entry = (origin, update) => ({ origin: { autoUpdate: true, ...origin }, update });
  assert.equal(autoUpdateCandidate(entry({}, { status: "available" })), true);
  assert.equal(autoUpdateCandidate(entry({}, undefined)), false, "no scheduled check result yet");
  assert.equal(autoUpdateCandidate(entry({}, { status: "current" })), false);
  assert.equal(autoUpdateCandidate(entry({}, { status: "error" })), false);
  assert.equal(autoUpdateCandidate(entry({ autoUpdate: false }, { status: "available" })), false);
  assert.equal(autoUpdateCandidate(entry({ reviewFirst: true }, { status: "available" })), false);
  assert.equal(autoUpdateCandidate(null), false);
});

test("a link from a copy that differs from its source waits for one reviewed update", async (t) => {
  const f = await fixture(t), row = await f.row();
  await f.service.linkSource("claude", row.id, f.source, { autoUpdate: true });
  assert.equal((await f.row()).origin.reviewFirst, false, "a copy that matches its source can update by itself");
  await fs.writeFile(path.join(path.dirname(row.path), "references/guide.md"), "Customized before linking");
  await f.service.linkSource("claude", row.id, f.source, { autoUpdate: true });
  assert.equal((await f.row()).origin.reviewFirst, true);
  f.change();
  await f.service.checkUpdates([{ provider: "claude", id: row.id }]);
  const [tracked] = await f.service.listTracked();
  assert.equal(tracked.update.status, "available");
  assert.equal(autoUpdateCandidate(tracked), false, "the idle pass leaves it for a person to review");
  const view = await f.service.previewUpdate("claude", row.id);
  assert.equal((await f.service.installUpdate(view.previewId, view.planId, true)).results[0].status, "installed");
  const updated = await f.row();
  assert.equal(updated.origin.reviewFirst, false, "after one reviewed update it can update by itself");
  assert.equal(updated.origin.autoUpdate, true);
});

test("reinstalling a skill from a different source starts opted out", async (t) => {
  const f = await fixture(t), row = await f.row();
  await f.service.setSourceAuto("claude", row.id, true);
  assert.equal((await f.row()).origin.autoUpdate, true);
  const content = "---\nname: review\ndescription: Review changes\n---\nFork\n";
  const other = createSkillsService({ home: f.home, env: {}, resolveSource: async () => ({ source: "example/fork", sourceType: "git", sourceInfo: null, warnings: [],
    skills: [{ name: "review", description: "Review changes", content, files: [{ name: "SKILL.md", data: Buffer.from(content), mode: 0o600 }] }] }) });
  const preview = await other.previewSource("example/fork");
  const plan = await other.planImport(preview.previewId, ["review"], ["claude"]);
  assert.equal((await other.installImport(preview.previewId, plan.planId, true)).results[0].status, "installed");
  const replaced = (await other.list("claude", { refresh: true })).skills[0];
  assert.equal(replaced.origin.source, "example/fork");
  assert.equal(replaced.origin.autoUpdate, false);
});
