import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSkillsService } from "../docker/setup/skills.mjs";
import { ORIGIN_FILE } from "../docker/setup/skills/origins.mjs";
import { autoInstallable } from "../docker/setup/skills/update-review.mjs";

async function fixture(t, provider = "claude", io = fs) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-update-review-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const markdown = "---\nname: review\ndescription: Review changes\n---\nOriginal instructions\n";
  let files = [{ name: "SKILL.md", data: Buffer.from(markdown), mode: 0o600 }, { name: "guide.md", data: Buffer.from("Original guide"), mode: 0o600 }];
  let pause = null;
  const options = { home, env: {}, io, resolveSource: async () => {
    if (pause) await pause;
    return { source: "example/skills", sourceType: "git", sourceInfo: { type: "git", source: "example/skills", commit: "a".repeat(40) }, warnings: [],
      skills: [{ name: "review", description: "Review changes", content: files[0].data.toString(), files: structuredClone(files).map(file => ({ ...file, data: Buffer.from(file.data) })) }] };
  } };
  const service = createSkillsService(options);
  const preview = await service.previewSource("example/skills"), plan = await service.planImport(preview.previewId, ["review"], [provider]);
  assert.equal((await service.installImport(preview.previewId, plan.planId)).results[0].status, "installed");
  const row = async () => (await service.list(provider, { refresh: true })).skills.find(row => row.name === "review");
  return { home, service, options, provider, markdown, row,
    files: value => { files = value; },
    change: () => { files = [{ ...files[0], data: Buffer.from(markdown + "Updated instructions\n") }, { name: "scripts/check.sh", data: Buffer.from("echo reviewed\n"), mode: 0o700 }]; },
    pause: value => { pause = value; } };
}
const review = async f => f.service.previewUpdate(f.provider, (await f.row()).id);
const commit = (f, view) => f.service.installUpdate(view.previewId, view.planId, true);

test("update review describes complete folder changes and needs explicit consent", async t => {
  const f = await fixture(t), original = await f.row(); f.change();
  const view = await review(f);
  assert.equal(view.target.directory, path.dirname(original.path));
  assert.equal(view.localChanges, false);
  assert.deepEqual(view.summary, { added: 1, modified: 1, removed: 1, unchanged: 0 });
  assert.equal(view.markdown.before, f.markdown); assert.match(view.markdown.after, /Updated instructions/);
  assert.deepEqual(view.changes.find(file => file.name === "SKILL.md").text, view.markdown);
  assert.deepEqual(view.changes.find(file => file.name === "scripts/check.sh").text, { before: null, after: "echo reviewed\n" });
  assert.deepEqual(view.changes.find(file => file.name === "guide.md").text, { before: "Original guide", after: null });
  assert(!view.changes.some(file => file.name === ORIGIN_FILE));
  await assert.rejects(f.service.installUpdate(view.previewId, view.planId, false), { code: "conflict" });
  await assert.rejects(f.service.planImport(view.previewId, ["review"], ["codex"]), { code: "invalid" });
  const result = await commit(f, view);
  assert.equal(result.results[0].status, "installed");
  assert.equal(result.results[0].installation, undefined);
  assert.deepEqual(await commit(f, view), result, "lost responses retry the same immutable plan");
  assert.match(await fs.readFile(original.path, "utf8"), /Updated instructions/);
  await assert.rejects(fs.stat(path.join(path.dirname(original.path), "guide.md")), { code: "ENOENT" });
  assert((await fs.stat(path.join(path.dirname(original.path), "scripts/check.sh"))).mode & 0o100);
});

test("a tracked shared installation updates in place without creating an agent copy", async t => {
  const f = await fixture(t, "codex"), initial = await f.row();
  const target = path.join(f.home, ".agents/skills/review");
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.rename(path.dirname(initial.path), target); f.change();
  const view = await review(f);
  assert.equal(view.target.directory, target);
  assert.deepEqual([...view.target.readers].sort(), ["codex", "cursor", "grok", "muse", "opencode"]);
  await commit(f, view);
  assert.match(await fs.readFile(path.join(target, "SKILL.md"), "utf8"), /Updated instructions/);
  await assert.rejects(fs.stat(path.dirname(initial.path)), { code: "ENOENT" });
  assert.equal((await f.service.checkUpdate("codex", (await f.row()).id)).update.status, "current");
});

test("a linked skill folder updates its managed target while preserving the link", async t => {
  const f = await fixture(t, "codex"), initial = await f.row();
  const alias = path.dirname(initial.path), target = path.join(f.home, ".agents/skills/review");
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.rename(alias, target); await fs.symlink(target, alias);
  f.change(); const view = await review(f);
  assert.equal(view.target.resolvedDirectory, target);
  await commit(f, view);
  assert((await fs.lstat(alias)).isSymbolicLink());
  assert.match(await fs.readFile(initial.path, "utf8"), /Updated instructions/);
});

test("links outside managed roots cannot authorize a complete folder replacement", async t => {
  const f = await fixture(t), initial = await f.row(), target = path.join(f.home, "unrelated");
  await fs.rename(path.dirname(initial.path), target); await fs.symlink(target, path.dirname(initial.path)); f.change();
  await assert.rejects(review(f), /outside the managed skill folders/);
  assert.equal(await fs.readFile(path.join(target, "SKILL.md"), "utf8"), f.markdown);
});

test("local edits and supporting links are disclosed without following the links", async t => {
  const f = await fixture(t), initial = await f.row(), outside = path.join(f.home, "keep.txt");
  await fs.writeFile(outside, "Keep this file");
  await fs.writeFile(path.join(path.dirname(initial.path), "guide.md"), "My local guide");
  await fs.symlink(outside, path.join(path.dirname(initial.path), "external.txt")); f.change();
  const view = await review(f);
  assert.equal(view.localChanges, true);
  assert.equal(view.changes.find(file => file.name === "external.txt").before.linked, true);
  assert.equal(view.changes.find(file => file.name === "external.txt").text, null);
  assert.equal(view.changes.find(file => file.name === "external.txt").textOmitted, "linked");
  await commit(f, view);
  assert.equal(await fs.readFile(outside, "utf8"), "Keep this file");
});

test("supporting-file previews retain UTF-8 and empty files without text on unchanged entries", async t => {
  const f = await fixture(t);
  f.files([
    { name: "SKILL.md", data: Buffer.from(f.markdown), mode: 0o600 },
    { name: "guide.md", data: Buffer.from("Updated café guide\n"), mode: 0o600 },
    { name: "empty.txt", data: Buffer.alloc(0), mode: 0o600 },
  ]);
  const view = await review(f);
  assert.deepEqual(view.changes.find(file => file.name === "guide.md").text, { before: "Original guide", after: "Updated café guide\n" });
  assert.deepEqual(view.changes.find(file => file.name === "empty.txt").text, { before: null, after: "" });
  assert.equal(view.changes.find(file => file.name === "SKILL.md").text, null);
  assert.equal(view.changes.find(file => file.name === "SKILL.md").textOmitted, "unchanged");
});

test("binary, invalid UTF-8 and oversized supporting files explain omitted text", async t => {
  for (const [name, data, reason] of [
    ["binary", Buffer.from([65, 0, 66]), "binary"],
    ["invalid", Buffer.from([0xc3, 0x28]), "binary"],
    ["large", Buffer.alloc(65537, 65), "large"],
  ]) {
    const f = await fixture(t), initial = await f.row();
    await fs.writeFile(path.join(path.dirname(initial.path), "guide.md"), data);
    f.files([
      { name: "SKILL.md", data: Buffer.from(f.markdown), mode: 0o600 },
      { name: "guide.md", data: Buffer.from("Valid incoming text"), mode: 0o600 },
      { name: name + ".txt", data, mode: 0o600 },
    ]);
    const view = await review(f);
    for (const file of ["guide.md", name + ".txt"]) {
      const change = view.changes.find(entry => entry.name === file);
      assert.equal(change.text, null); assert.equal(change.textOmitted, reason);
    }
    assert.equal(view.localChanges, true);
  }
});

test("the 64 KiB text boundary is inclusive", async t => {
  const f = await fixture(t), text = "a".repeat(65536);
  f.files([{ name: "SKILL.md", data: Buffer.from(f.markdown), mode: 0o600 }, { name: "boundary.txt", data: Buffer.from(text), mode: 0o600 }]);
  const view = await review(f);
  assert.deepEqual(view.changes.find(file => file.name === "boundary.txt").text, { before: null, after: text });
});

test("the complete preview text stays within 1 MiB without omitting any replacement files", async t => {
  const f = await fixture(t), initial = await f.row(), text = "a".repeat(32768), next = "b".repeat(32768);
  const names = Array.from({ length: 20 }, (_, i) => "text-" + String(i).padStart(2, "0") + ".txt");
  for (const name of names) await fs.writeFile(path.join(path.dirname(initial.path), name), text);
  f.files([{ name: "SKILL.md", data: Buffer.from(f.markdown), mode: 0o600 }, ...names.map(name => ({ name, data: Buffer.from(next), mode: 0o600 }))]);
  const view = await review(f);
  const bytes = [view.markdown.before, view.markdown.after, ...view.changes.flatMap(file => file.text ? [file.text.before, file.text.after] : [])]
    .reduce((total, text) => total + Buffer.byteLength(text || ""), 0);
  assert(bytes <= 1024 * 1024);
  const omitted = view.changes.find(file => file.textOmitted === "budget");
  assert(omitted); assert.equal(omitted.status, "modified");
  assert.equal((await commit(f, view)).results[0].status, "installed");
  assert.equal(await fs.readFile(path.join(path.dirname(initial.path), omitted.name), "utf8"), next);
});

test("edits, removals and provenance changes after review reject publication", async t => {
  for (const action of ["edit", "remove", "origin"]) {
    const f = await fixture(t), initial = await f.row(); f.change(); const view = await review(f);
    if (action === "edit") await fs.writeFile(path.join(path.dirname(initial.path), "guide.md"), "External edit");
    if (action === "remove") await fs.rm(path.dirname(initial.path), { recursive: true });
    if (action === "origin") await fs.writeFile(path.join(path.dirname(initial.path), ORIGIN_FILE), "{}");
    await assert.rejects(commit(f, view));
    if (action !== "remove") assert.equal(await fs.readFile(initial.path, "utf8"), f.markdown);
  }
});

test("retargeted aliases and newly reading agents require a fresh review", async t => {
  const f = await fixture(t), initial = await f.row(); f.change(); const view = await review(f);
  const alias = path.join(f.home, ".codex/skills/review");
  await fs.mkdir(path.dirname(alias), { recursive: true }); await fs.symlink(path.dirname(initial.path), alias);
  await assert.rejects(commit(f, view), /agents reading this folder changed/);
  assert.equal(await fs.readFile(initial.path, "utf8"), f.markdown);
});

test("edits during a slow repository read do not produce an actionable review", async t => {
  const f = await fixture(t), initial = await f.row(); f.change();
  let release, began; const started = new Promise(resolve => { began = resolve; });
  const service = createSkillsService({ ...f.options, resolveSource: async (...args) => { began(); await new Promise(resolve => { release = resolve; }); return f.options.resolveSource(...args); } });
  const pending = service.previewUpdate(f.provider, initial.id); await started;
  await fs.writeFile(initial.path, f.markdown + "Concurrent edit\n"); release();
  await assert.rejects(pending, { code: "conflict" });
});

test("publication failures restore the entire previous installation", async t => {
  let failPublish = false;
  const io = { ...fs, rename: async (from, to) => {
    if (failPublish && path.basename(from).startsWith(".t3-skill-import-")) throw Object.assign(Error("Write failed"), { code: "EIO" });
    return fs.rename(from, to);
  } };
  const f = await fixture(t, "claude", io), initial = await f.row(); f.change(); const view = await review(f);
  const origin = await fs.readFile(path.join(path.dirname(initial.path), ORIGIN_FILE), "utf8"); failPublish = true;
  const result = await commit(f, view); assert.equal(result.results[0].status, "failed");
  assert.equal(await fs.readFile(initial.path, "utf8"), f.markdown);
  assert.equal(await fs.readFile(path.join(path.dirname(initial.path), "guide.md"), "utf8"), "Original guide");
  assert.equal(await fs.readFile(path.join(path.dirname(initial.path), ORIGIN_FILE), "utf8"), origin);
});

test("reviewed updates work for all seven managed global skill folders", async t => {
  for (const provider of ["claude", "codex", "opencode", "cursor", "grok", "muse", "antigravity"]) {
    const f = await fixture(t, provider), initial = await f.row(); f.change();
    const view = await review(f); assert.equal(view.target.provider, provider);
    assert(view.target.readers.includes(provider));
    assert.equal((await commit(f, view)).results[0].status, "installed");
    assert.match(await fs.readFile(initial.path, "utf8"), /Updated instructions/);
  }
});

test("large local additions are disclosed without reading their contents", async t => {
  let oversizedReads = 0;
  const io = { ...fs, open: async (file, ...args) => {
    if (path.basename(file) === "large-local.bin") oversizedReads++;
    return fs.open(file, ...args);
  } };
  const f = await fixture(t, "claude", io), initial = await f.row();
  const large = path.join(path.dirname(initial.path), "large-local.bin");
  await fs.writeFile(large, ""); await fs.truncate(large, 8 * 1024 * 1024); f.change();
  const view = await review(f); assert.equal(view.localChanges, true);
  assert.equal(view.changes.find(file => file.name === "large-local.bin").status, "removed");
  assert.equal(oversizedReads, 0);
});

test("retargeting the selected skill link after review preserves both targets", async t => {
  const f = await fixture(t), initial = await f.row(), alias = path.dirname(initial.path);
  const moved = path.join(f.home, ".agents/skills/review"), other = path.join(f.home, ".agents/skills/other");
  await fs.mkdir(path.dirname(moved), { recursive: true }); await fs.rename(alias, moved); await fs.symlink(moved, alias);
  f.change(); const view = await review(f);
  await fs.mkdir(other); await fs.writeFile(path.join(other, "SKILL.md"), f.markdown);
  await fs.unlink(alias); await fs.symlink(other, alias);
  await assert.rejects(commit(f, view), { code: "conflict" });
  for (const directory of [moved, other]) assert.equal(await fs.readFile(path.join(directory, "SKILL.md"), "utf8"), f.markdown);
});

test("idle auto-installs require an update without local edits", async t => {
  assert.equal(autoInstallable(null), false);
  assert.equal(autoInstallable({}), false);
  assert.equal(autoInstallable({ canUpdate: true }), false);
  assert.equal(autoInstallable({ canUpdate: false, localChanges: false }), false);
  const f = await fixture(t);
  const seen = async () => { const view = await review(f); const result = autoInstallable(view); await f.service.discardImport(view.previewId); return result; };
  assert.equal(await seen(), false, "nothing to install yet");
  f.change();
  const clean = await review(f);
  assert.equal(clean.localChanges, false);
  assert.equal(autoInstallable(clean), true);
  await f.service.discardImport(clean.previewId);
  // Local edits block the idle pass but stay reviewable manually.
  await fs.writeFile(path.join(path.dirname((await f.row()).path), "guide.md"), "Local edits");
  assert.equal(await seen(), false);
});
