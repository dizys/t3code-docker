import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { agentsMdTargets, agentsMdPathFor, validateAgentsMd, readAgentsMd, writeAgentsMd, reconcileAgentsMd, contextStatus, readProviderAgentsMd, writeProviderAgentsMd, providerInstructionState, setProviderInstructionMode, deleteAgentsMd } from "../docker/setup/context.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "t3-context-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, baseDir: path.join(root, ".t3"), home: path.join(root, "home") };
}

test("native instruction targets respect provider environment overrides", () => {
  assert.deepEqual(agentsMdTargets({}, "/home/t3"), [
    { provider: "claude", path: "/home/t3/.claude/CLAUDE.md" },
    { provider: "codex", path: "/home/t3/.codex/AGENTS.md" },
    { provider: "opencode", path: "/home/t3/.config/opencode/AGENTS.md" },
  ]);
  assert.deepEqual(agentsMdTargets({ CLAUDE_CONFIG_DIR: "/claude", CODEX_HOME: "/codex", XDG_CONFIG_HOME: "/config" }).map((t) => t.path),
    ["/claude/CLAUDE.md", "/codex/AGENTS.md", "/config/opencode/AGENTS.md"]);
  assert.deepEqual(agentsMdTargets({ OPENCODE_CONFIG_DIR: "/state/opencode" }, "/home/t3").map((t) => t.path),
    ["/home/t3/.claude/CLAUDE.md", "/home/t3/.codex/AGENTS.md", "/state/opencode/AGENTS.md"]);
  assert.equal(agentsMdTargets({ OPENCODE_CONFIG_DIR: ".custom/opencode" }, "/home/t3")[2].path, "/home/t3/.custom/opencode/AGENTS.md");
  assert.equal(agentsMdTargets({ XDG_CONFIG_HOME: ".cfg" }, "/home/t3")[2].path, "/home/t3/.cfg/opencode/AGENTS.md");
});

test("validation rejects blank and oversized UTF-8 content", () => {
  assert.equal(validateAgentsMd("  ").ok, false);
  assert.equal(validateAgentsMd("é".repeat(32769)).ok, false);
  assert.equal(validateAgentsMd("é".repeat(32768)).bytes, 65536);
});

test("oversized shared files and provider symlink targets are never opened, including on repeated polls", async (t) => {
  const f = await fixture(t);
  const shared = agentsMdPathFor(f.baseDir);
  const targets = agentsMdTargets({}, f.home);
  await fs.mkdir(path.dirname(shared), { recursive: true });
  await fs.writeFile(shared, 'x'.repeat(65537));
  for (const target of targets) await fs.mkdir(path.dirname(target.path), { recursive: true });
  await fs.symlink(shared, targets[0].path);
  await fs.writeFile(targets[1].path, 'é'.repeat(32769));
  const external = path.join(f.root, 'external.md');
  await fs.writeFile(external, 'x'.repeat(1024 * 1024));
  await fs.symlink(path.relative(path.dirname(targets[2].path), external), targets[2].path);
  let opens = 0;
  const guarded = { ...fs, open: async () => { opens++; throw new Error('oversized instructions must not be opened'); },
    readFile: async () => { throw new Error('unbounded reads must not be used'); } };
  for (let poll = 0; poll < 2; poll++) {
    const status = await contextStatus(guarded, f);
    assert.equal(status.agentsMd.present, true);
    assert.equal(status.agentsMd.bytes, 65537);
    assert.match(status.agentsMd.error, /too large to edit/);
    assert.deepEqual(status.providers.map((p) => p.mode), ['shared', 'separate', 'separate']);
    assert.ok(status.providers.every((p) => /too large to edit/.test(p.error) && p.sourceRevision === null));
    assert.ok(!JSON.stringify(status).includes('content'));
  }
  const read = await readAgentsMd(guarded, f.baseDir);
  assert.equal(read.code, 'too_large');
  assert.equal(read.content, null);
  assert.equal(read.revision, null);
  for (const target of targets) {
    const read = await readProviderAgentsMd(guarded, target.provider, f);
    assert.equal(read.code, 'too_large');
    assert.equal(read.content, null);
    assert.equal(read.revision, null);
    assert.equal(read.bytes, (await fs.stat(target.path)).size);
    assert.equal((await writeProviderAgentsMd(guarded, target.provider, '# Replacement', null, f)).ok, false);
    assert.equal((await setProviderInstructionMode(guarded, f.baseDir, target.provider, 'none', null, f)).ok, false);
  }
  assert.equal((await writeAgentsMd(guarded, f.baseDir, '# Replacement')).ok, false);
  assert.equal((await deleteAgentsMd(guarded, f.baseDir, null, f)).ok, false);
  assert.equal((await reconcileAgentsMd(guarded, f.baseDir, f)).ok, false);
  assert.equal(opens, 0);
  assert.equal((await fs.stat(shared)).size, 65537);
  assert.equal((await fs.stat(targets[1].path)).size, 65538);
  assert.equal((await fs.stat(external)).size, 1024 * 1024);
  assert.equal(await fs.readlink(targets[0].path), shared);
  assert.equal(await fs.readlink(targets[2].path), path.relative(path.dirname(targets[2].path), external));
});

test("exactly 64 KiB of UTF-8 instructions loads through shared and provider editors", async (t) => {
  const f = await fixture(t);
  const content = 'é'.repeat(32768);
  await writeAgentsMd(fs, f.baseDir, content);
  await reconcileAgentsMd(fs, f.baseDir, f);
  for (const read of [await readAgentsMd(fs, f.baseDir), await readProviderAgentsMd(fs, 'codex', f)]) {
    assert.equal(read.content, content);
    assert.equal(read.bytes, 65536);
    assert.ok(read.revision);
  }
});

test("instruction reads remain bounded across short reads when a file grows after stat", async (t) => {
  const f = await fixture(t);
  await writeAgentsMd(fs, f.baseDir, '# Small');
  await reconcileAgentsMd(fs, f.baseDir, f);
  const file = agentsMdPathFor(f.baseDir);
  for (const provider of [null, 'codex']) {
    await fs.writeFile(file, '# Small');
    let bytesRead = 0, closed = false;
    const growing = { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      return {
        stat: () => handle.stat(),
        read: async (buffer, offset, length, position) => {
          if (position === 0) await fs.appendFile(file, 'x'.repeat(1024 * 1024));
          assert.equal(buffer.length, 65537);
          const result = await handle.read(buffer, offset, Math.min(length, 4096), position);
          bytesRead += result.bytesRead;
          return result;
        },
        close: async () => { closed = true; await handle.close(); },
      };
    } };
    const read = provider ? await readProviderAgentsMd(growing, provider, f) : await readAgentsMd(growing, f.baseDir);
    assert.equal(read.code, 'too_large');
    assert.equal(read.content, null);
    assert.equal(read.revision, null);
    assert.equal(bytesRead, 65537);
    assert.equal(closed, true);
  }
});

test("the opened file is checked again before reading and closed if it grew", async (t) => {
  const f = await fixture(t);
  await writeAgentsMd(fs, f.baseDir, '# Small');
  const file = agentsMdPathFor(f.baseDir);
  let closed = false;
  const growing = { ...fs, open: async (...args) => {
    await fs.appendFile(file, 'x'.repeat(65536));
    const handle = await fs.open(...args);
    return {
      stat: () => handle.stat(),
      read: () => { assert.fail('the grown file must not be read'); },
      close: async () => { closed = true; await handle.close(); },
    };
  } };
  assert.equal((await readAgentsMd(growing, f.baseDir)).code, 'too_large');
  assert.equal(closed, true);
});

test("saving twice updates existing provider links without replacing them", async (t) => {
  const f = await fixture(t);
  assert.equal((await readAgentsMd(fs, f.baseDir)).present, false);
  await writeAgentsMd(fs, f.baseDir, "# First\n");
  assert.equal((await reconcileAgentsMd(fs, f.baseDir, f)).linked.length, 3);
  await writeAgentsMd(fs, f.baseDir, "# Second\n", (await readAgentsMd(fs, f.baseDir)).revision);
  const again = await reconcileAgentsMd(fs, f.baseDir, f);
  assert.ok(again.linked.every((target) => target.state === "exists"));
  for (const target of agentsMdTargets({}, f.home)) {
    assert.ok((await fs.lstat(target.path)).isSymbolicLink());
    assert.equal(await fs.readFile(target.path, "utf8"), "# Second\n");
  }
  assert.equal((await fs.stat(agentsMdPathFor(f.baseDir))).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(path.join(f.home, ".claude/AGENTS.md")), { code: "ENOENT" });
  let reads = 0;
  const status = await contextStatus({ ...fs, open: (...args) => {
    reads++;
    return fs.open(...args);
  } }, f);
  assert.equal(reads, 1, "shared provider files are read once per status snapshot");
  assert.deepEqual(Object.keys(status), ["agentsMd", "providers"]);
  assert.deepEqual(status.providers.map((entry) => entry.mode), ['shared', 'shared', 'shared']);
  assert.equal(status.agentsMd.bytes, 9);
  assert.ok(!("content" in status.agentsMd));
});

test("global reconciliation preserves real files and absolute, relative and dangling user symlinks", async (t) => {
  const f = await fixture(t);
  await writeAgentsMd(fs, f.baseDir, "# Shared");
  const userFile = path.join(f.root, "user.md");
  await fs.writeFile(userFile, "# User");
  for (const kind of ["file", "absolute", "relative", "dangling"]) {
    for (const target of agentsMdTargets({}, f.home)) {
      await fs.mkdir(path.dirname(target.path), { recursive: true });
      if (kind === "file") await fs.writeFile(target.path, "# Existing");
      else await fs.symlink(kind === "relative" ? path.relative(path.dirname(target.path), userFile) : kind === "dangling" ? path.join(f.root, "missing.md") : userFile, target.path);
    }
    const result = await reconcileAgentsMd(fs, f.baseDir, f);
    assert.equal(result.skipped.length, 3, kind);
    assert.ok(result.skipped.every((entry) => entry.preserved));
    for (const target of agentsMdTargets({}, f.home)) {
      if (kind === "file") assert.equal(await fs.readFile(target.path, "utf8"), "# Existing");
      else {
        assert.ok((await fs.lstat(target.path)).isSymbolicLink());
        assert.notEqual(await fs.readlink(target.path), agentsMdPathFor(f.baseDir));
      }
      await fs.unlink(target.path);
    }
  }
  assert.equal(await fs.readFile(userFile, "utf8"), "# User");
});

test("canonical symlinks and invalid saves preserve existing instructions", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, "user.md"), canonical = agentsMdPathFor(f.baseDir);
  await fs.mkdir(path.dirname(canonical), { recursive: true });
  await fs.writeFile(target, "# User");
  await fs.symlink(target, canonical);
  const revision = (await readAgentsMd(fs, f.baseDir)).revision;
  assert.match((await writeAgentsMd(fs, f.baseDir, "# Replacement", revision)).error, /symlink/);
  assert.equal(await fs.readlink(canonical), target);
  assert.equal(await fs.readFile(target, "utf8"), "# User");
  await fs.unlink(canonical);
  await writeAgentsMd(fs, f.baseDir, "# Original");
  assert.equal((await writeAgentsMd(fs, f.baseDir, "")).ok, false);
  assert.equal((await readAgentsMd(fs, f.baseDir)).content, "# Original");
});

test("a failed atomic rename preserves instructions and cleans up its temporary file", async (t) => {
  const f = await fixture(t);
  await writeAgentsMd(fs, f.baseDir, "# Original");
  const broken = { ...fs, rename: async () => { throw new Error("rename failed"); } };
  await assert.rejects(writeAgentsMd(broken, f.baseDir, "# Replacement", (await readAgentsMd(fs, f.baseDir)).revision), /rename failed/);
  assert.equal((await readAgentsMd(fs, f.baseDir)).content, "# Original");
  assert.deepEqual(await fs.readdir(path.dirname(agentsMdPathFor(f.baseDir))), ["AGENTS.md"]);
});

test("read errors remain visible in instruction status", async (t) => {
  const f = await fixture(t);
  const broken = { ...fs, stat: async () => { throw new Error("permission denied"); } };
  assert.match((await contextStatus(broken, f)).agentsMd.error, /permission denied/);
});

const ctx = vm.createContext({ URL });
vm.runInContext(`${readFileSync(new URL("../docker/setup/client/model.js", import.meta.url), "utf8")}\nthis.M = T3Model;`, ctx);
const M = ctx.M;
const ui = { busy: new Map(), pending: new Map(), notices: new Map() };

test("Context offers only global instructions and never adds attention", () => {
  const status = { server: { ok: true }, harnesses: [], toolchains: [], sessions: [], pairings: [], operations: {} };
  assert.equal(M.contextView(status).present, false);
  assert.equal(M.navBadges(status, null, ui).instructions, null);
  const row = M.contextAgentsMdRow(status);
  assert.equal(row.action.cmd, "context.edit");
  assert.equal(row.attention, false);
  const items = M.paletteItems(status, null, ui, Date.now()).filter((i) => i.group === "Instructions & skills");
  assert.ok(M.paletteItems(status, null, ui, Date.now()).some((i) => i.label === "Edit the shared AGENTS.md…"));
  assert.equal(row.action.label, "Write", "a file not written yet is written, not edited");
  assert.match(row.status.text, /^Not written yet/);
  assert.ok(items.every((i) => !/skill|setup|project/i.test(i.label)));
});

test("oversized instructions remain visible without editor or delete actions", () => {
  const error = 'Instructions are too large to edit (64 KiB maximum).';
  const status = { context: { agentsMd: { present: true, bytes: 65537, error },
    providers: [{ provider: 'codex', mode: 'separate', error }] } };
  const row = M.contextAgentsMdRow(status);
  assert.equal(row.status.text, error);
  assert.equal(row.badge.text, 'Unavailable');
  assert.equal(row.action, null);
  assert.equal(row.menu.length, 0);
  assert.equal(M.contextProviderRows(status)[0].mode, 'separate');
  assert.equal(M.contextProviderRows(status)[0].error, error);
  assert.equal(M.paletteItems(status, null, ui, Date.now()).filter((i) => i.group === 'Instructions & skills').length, 0);
});

test("existing provider files appear in Context and edits preserve their permissions and separation", async (t) => {
  const f = await fixture(t);
  for (const target of agentsMdTargets({}, f.home)) {
    await fs.mkdir(path.dirname(target.path), { recursive: true });
    await fs.writeFile(target.path, `# Existing ${target.provider}`, { mode: 0o664 });
    await fs.chmod(target.path, 0o664);
  }
  const before = await contextStatus(fs, f);
  assert.equal(before.agentsMd.present, false);
  assert.deepEqual(before.providers.map((p) => p.provider), ["claude", "codex", "opencode"]);
  assert.ok(before.providers.every((p) => !('content' in p)));
  for (const target of agentsMdTargets({}, f.home)) {
    const read = await readProviderAgentsMd(fs, target.provider, f);
    assert.equal(read.content, `# Existing ${target.provider}`);
    const saved = await writeProviderAgentsMd(fs, target.provider, `# Edited ${target.provider}`, read.revision, f);
    assert.equal(saved.ok, true);
    assert.equal(await fs.readFile(target.path, "utf8"), `# Edited ${target.provider}`);
    assert.equal((await fs.stat(target.path)).mode & 0o777, 0o664);
  }
  assert.equal((await readAgentsMd(fs, f.baseDir)).present, false);
});

test("editing an existing provider symlink writes through its chain, including with custom config paths", async (t) => {
  const f = await fixture(t);
  const options = { home: f.home, env: { CODEX_HOME: path.join(f.root, 'custom-codex'), CLAUDE_CONFIG_DIR: path.join(f.root, 'custom-claude'), XDG_CONFIG_HOME: path.join(f.root, 'custom-config') } };
  const shared = path.join(f.root, "user-shared.md");
  const middle = path.join(f.root, "middle.md");
  await fs.writeFile(shared, "# Existing user instructions");
  await fs.symlink(path.basename(shared), middle);
  for (const target of agentsMdTargets(options.env, f.home)) {
    await fs.mkdir(path.dirname(target.path), { recursive: true });
    await fs.symlink(path.relative(path.dirname(target.path), middle), target.path);
  }
  await writeAgentsMd(fs, f.baseDir, "# Managed shared file");
  assert.equal((await reconcileAgentsMd(fs, f.baseDir, options)).skipped.length, 3);
  for (const target of agentsMdTargets(options.env, f.home)) {
    const link = await fs.readlink(target.path);
    const read = await readProviderAgentsMd(fs, target.provider, options);
    assert.equal(read.resolvedPath, shared);
    assert.equal((await writeProviderAgentsMd(fs, target.provider, `# Edited ${target.provider}`, read.revision, options)).ok, true);
    assert.equal(await fs.readlink(target.path), link);
    assert.equal(await fs.readlink(middle), path.basename(shared));
    assert.equal(await fs.readFile(shared, "utf8"), `# Edited ${target.provider}`);
    assert.equal((await readAgentsMd(fs, f.baseDir)).content, "# Managed shared file");
  }
});

test("provider edits reject external changes, link retargeting and simultaneous saves from the same revision", async (t) => {
  const f = await fixture(t);
  const target = agentsMdTargets({}, f.home)[0].path;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "# Original");
  let read = await readProviderAgentsMd(fs, 'claude', f);
  await fs.writeFile(target, "# Changed outside Context");
  assert.equal((await writeProviderAgentsMd(fs, 'claude', '# Draft', read.revision, f)).code, 'conflict');
  assert.equal(await fs.readFile(target, 'utf8'), '# Changed outside Context');
  read = await readProviderAgentsMd(fs, 'claude', f);
  const saves = await Promise.all(['# A', '# B'].map((content) => writeProviderAgentsMd(fs, 'claude', content, read.revision, f)));
  assert.equal(saves.filter((save) => save.ok).length, 1);
  assert.equal(saves.filter((save) => save.code === 'conflict').length, 1);
  const other = path.join(f.root, 'other.md');
  await fs.writeFile(other, await fs.readFile(target));
  read = await readProviderAgentsMd(fs, 'claude', f);
  await fs.unlink(target);
  await fs.symlink(other, target);
  assert.equal((await writeProviderAgentsMd(fs, 'claude', '# Draft', read.revision, f)).code, 'conflict');
});

test("unknown, absent, dangling and directory provider targets cannot be overwritten", async (t) => {
  const f = await fixture(t);
  assert.equal((await readProviderAgentsMd(fs, '../escape', f)).ok, false);
  assert.equal((await writeProviderAgentsMd(fs, '../escape', '# Draft', 'fake', f)).ok, false);
  assert.equal((await readProviderAgentsMd(fs, 'codex', f)).code, 'missing');
  const target = agentsMdTargets({}, f.home).find((p) => p.provider === 'codex').path;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const missing = path.join(f.root, 'missing.md');
  await fs.symlink(missing, target);
  assert.match((await contextStatus(fs, f)).providers.find((p) => p.provider === 'codex').error, /no longer exists/);
  assert.equal((await writeProviderAgentsMd(fs, 'codex', '# Draft', 'fake', f)).ok, false);
  assert.equal(await fs.readlink(target), missing);
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
  await fs.unlink(target);
  await fs.mkdir(target);
  assert.equal((await writeProviderAgentsMd(fs, 'codex', '# Draft', 'fake', f)).ok, false);
  assert.deepEqual(await fs.readdir(target), []);
});

test("provider view rows and palette expose each discovered file", () => {
  const status = { context: { providers: [{ provider: 'claude', path: '/custom/CLAUDE.md', mode: 'separate' }] } };
  const row = M.contextProviderRows(status)[0];
  assert.equal(row.name, 'Claude Code');
  assert.equal(row.mark, 'claude');
  assert.equal(row.badge, null);
  assert.equal(row.status.text, 'Reads its own CLAUDE.md');
  assert.equal(row.path, '/custom/CLAUDE.md');
  assert.equal(M.contextProviderRows({ context: { providers: [{ provider: 'codex', mode: 'shared' }] } })[0].status.text, 'Reads the shared AGENTS.md');
  assert.equal(M.contextProviderRows({ context: { providers: [{ provider: 'codex', mode: null }] } })[0].status.text, 'Reads no global instructions');
  assert.ok(M.paletteItems(status, null, ui, Date.now()).some((i) => i.cmd.cmd === 'context.provider.edit' && i.cmd.id === 'claude'));
});

test("shared instructions reject stale editors and concurrent initial creation", async (t) => {
  const f = await fixture(t);
  const empty = await readAgentsMd(fs, f.baseDir);
  assert.equal(empty.revision, null);
  const created = await Promise.all(['# A', '# B'].map((content) => writeAgentsMd(fs, f.baseDir, content, empty.revision)));
  assert.equal(created.filter((result) => result.ok).length, 1);
  assert.equal(created.filter((result) => result.code === 'conflict').length, 1);
  const current = await readAgentsMd(fs, f.baseDir);
  assert.equal((await writeAgentsMd(fs, f.baseDir, '# Without reading')).code, 'conflict');
  const updated = await Promise.all(['# C', '# D'].map((content) => writeAgentsMd(fs, f.baseDir, content, current.revision)));
  assert.equal(updated.filter((result) => result.ok).length, 1);
  assert.equal(updated.filter((result) => result.code === 'conflict').length, 1);
  const changed = await readAgentsMd(fs, f.baseDir);
  await fs.writeFile(agentsMdPathFor(f.baseDir), '# Changed externally');
  assert.equal((await writeAgentsMd(fs, f.baseDir, '# Stale editor', changed.revision)).code, 'conflict');
  assert.equal((await readAgentsMd(fs, f.baseDir)).content, '# Changed externally');
});

test("shared and provider saves to the same managed file use one revision queue", async (t) => {
  const f = await fixture(t);
  await writeAgentsMd(fs, f.baseDir, '# Original');
  await reconcileAgentsMd(fs, f.baseDir, f);
  const shared = await readAgentsMd(fs, f.baseDir);
  const provider = await readProviderAgentsMd(fs, 'codex', f);
  assert.equal(shared.revision, provider.revision);
  const saves = await Promise.all([
    writeAgentsMd(fs, f.baseDir, '# Shared editor', shared.revision),
    writeProviderAgentsMd(fs, 'codex', '# Provider editor', provider.revision, f),
  ]);
  assert.equal(saves.filter((result) => result.ok).length, 1);
  assert.equal(saves.filter((result) => result.code === 'conflict').length, 1);
});

test("providers can use shared instructions or detach an independent copy", async (t) => {
  const f = await fixture(t);
  await writeAgentsMd(fs, f.baseDir, '# Shared v1');
  for (const target of agentsMdTargets({}, f.home)) {
    let state = await providerInstructionState(fs, f.baseDir, target.provider, f);
    assert.equal(state.mode, null);
    assert.equal((await setProviderInstructionMode(fs, f.baseDir, target.provider, 'shared', state.sourceRevision, f)).ok, true);
    assert.equal(await fs.readFile(target.path, 'utf8'), '# Shared v1');
    state = await providerInstructionState(fs, f.baseDir, target.provider, f);
    assert.equal(state.mode, 'shared');
    assert.equal((await setProviderInstructionMode(fs, f.baseDir, target.provider, 'separate', state.sourceRevision, f)).ok, true);
    assert.equal((await fs.lstat(target.path)).isSymbolicLink(), false);
    assert.equal(await fs.readFile(target.path, 'utf8'), '# Shared v1');
  }
  await writeAgentsMd(fs, f.baseDir, '# Shared v2', (await readAgentsMd(fs, f.baseDir)).revision);
  await reconcileAgentsMd(fs, f.baseDir, f);
  assert.deepEqual((await contextStatus(fs, f)).providers.map((p) => p.mode), ['separate', 'separate', 'separate']);
  for (const target of agentsMdTargets({}, f.home)) assert.equal(await fs.readFile(target.path, 'utf8'), '# Shared v1');
});

test("switching to shared backs up separate files and restores their permissions and relative symlinks", async (t) => {
  const f = await fixture(t);
  await writeAgentsMd(fs, f.baseDir, '# Shared');
  const original = path.join(f.root, 'original.md');
  await fs.writeFile(original, '# User symlink target');
  for (const [i, target] of agentsMdTargets({}, f.home).entries()) {
    await fs.mkdir(path.dirname(target.path), { recursive: true });
    const link = path.relative(path.dirname(target.path), original);
    if (i === 0) await fs.symlink(link, target.path);
    else { await fs.writeFile(target.path, '# Separate ' + target.provider); await fs.chmod(target.path, 0o640); }
    const state = await providerInstructionState(fs, f.baseDir, target.provider, f);
    assert.equal((await setProviderInstructionMode(fs, f.baseDir, target.provider, 'shared', state.sourceRevision, f)).ok, true);
    assert.equal(await fs.readFile(target.path, 'utf8'), '# Shared');
    const backup = target.path + '.t3-context-backup';
    if (i === 0) assert.equal(await fs.readlink(backup), link);
    else assert.equal(await fs.readFile(backup, 'utf8'), '# Separate ' + target.provider);
    const shared = await providerInstructionState(fs, f.baseDir, target.provider, f);
    assert.equal((await setProviderInstructionMode(fs, f.baseDir, target.provider, 'separate', shared.sourceRevision, f)).ok, true);
    if (i === 0) assert.equal(await fs.readlink(target.path), link);
    else {
      assert.equal(await fs.readFile(target.path, 'utf8'), '# Separate ' + target.provider);
      assert.equal((await fs.stat(target.path)).mode & 0o777, 0o640);
    }
    await assert.rejects(fs.lstat(backup), { code: 'ENOENT' });
  }
  assert.equal(await fs.readFile(original, 'utf8'), '# User symlink target');
});

test("mode changes reject stale selections and existing backups and roll back failed switches", async (t) => {
  const f = await fixture(t);
  await writeAgentsMd(fs, f.baseDir, '# Shared');
  const target = agentsMdTargets({}, f.home)[0];
  await fs.mkdir(path.dirname(target.path), { recursive: true });
  await fs.writeFile(target.path, '# Separate');
  let state = await providerInstructionState(fs, f.baseDir, target.provider, f);
  await fs.writeFile(target.path, '# New separate');
  assert.equal((await setProviderInstructionMode(fs, f.baseDir, target.provider, 'shared', state.sourceRevision, f)).code, 'conflict');
  state = await providerInstructionState(fs, f.baseDir, target.provider, f);
  const backup = target.path + '.t3-context-backup';
  await fs.writeFile(backup, '# Existing backup');
  assert.equal((await setProviderInstructionMode(fs, f.baseDir, target.provider, 'shared', state.sourceRevision, f)).code, 'conflict');
  assert.equal(await fs.readFile(backup, 'utf8'), '# Existing backup');
  assert.equal(await fs.readFile(target.path, 'utf8'), '# New separate');
  await fs.unlink(backup);
  const broken = { ...fs, rename: async (from, to) => {
    if (from.includes('.tmp.')) throw new Error('switch rename failed');
    return fs.rename(from, to);
  } };
  await assert.rejects(setProviderInstructionMode(broken, f.baseDir, target.provider, 'shared', state.sourceRevision, f), /switch rename failed/);
  assert.equal(await fs.readFile(target.path, 'utf8'), '# New separate');
  await assert.rejects(fs.lstat(backup), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.dirname(target.path)), ['CLAUDE.md']);
});

test("separate mode can start before a shared file exists; unknown modes cannot change files", async (t) => {
  const f = await fixture(t);
  const state = await providerInstructionState(fs, f.baseDir, 'codex', f);
  assert.equal((await setProviderInstructionMode(fs, f.baseDir, 'codex', 'shared', state.sourceRevision, f)).ok, false);
  assert.equal((await setProviderInstructionMode(fs, f.baseDir, '../escape', 'shared', state.sourceRevision, f)).ok, false);
  assert.equal((await setProviderInstructionMode(fs, f.baseDir, 'codex', 'other', state.sourceRevision, f)).ok, false);
  assert.equal((await setProviderInstructionMode(fs, f.baseDir, 'codex', 'separate', state.sourceRevision, f)).ok, true);
  assert.match((await readProviderAgentsMd(fs, 'codex', f)).content, /codex instructions/);
});


test("None preserves separate files for restoration and rejects occupied backups", async (t) => {
  const f = await fixture(t);
  let state = await providerInstructionState(fs, f.baseDir, 'codex', f);
  assert.equal((await setProviderInstructionMode(fs, f.baseDir, 'codex', 'separate', state.sourceRevision, f)).ok, true);
  const target = agentsMdTargets({}, f.home).find((entry) => entry.provider === 'codex').path;
  await fs.writeFile(target, '# Keep my instructions');
  await fs.chmod(target, 0o640);
  state = await providerInstructionState(fs, f.baseDir, 'codex', f);
  assert.equal((await setProviderInstructionMode(fs, f.baseDir, 'codex', 'none', state.sourceRevision, f)).ok, true);
  await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
  assert.equal(await fs.readFile(target + '.t3-context-backup', 'utf8'), '# Keep my instructions');
  state = await providerInstructionState(fs, f.baseDir, 'codex', f);
  assert.equal((await setProviderInstructionMode(fs, f.baseDir, 'codex', 'separate', state.sourceRevision, f)).ok, true);
  assert.equal(await fs.readFile(target, 'utf8'), '# Keep my instructions');
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
  await fs.writeFile(target + '.t3-context-backup', '# Previous backup');
  state = await providerInstructionState(fs, f.baseDir, 'codex', f);
  assert.equal((await setProviderInstructionMode(fs, f.baseDir, 'codex', 'none', state.sourceRevision, f)).code, 'conflict');
  assert.equal(await fs.readFile(target, 'utf8'), '# Keep my instructions');
});

test("global deletion checks revisions, removes shared links and preserves separate files and backups", async (t) => {
  const f = await fixture(t);
  await writeAgentsMd(fs, f.baseDir, '# Shared');
  await reconcileAgentsMd(fs, f.baseDir, f);
  const targets = agentsMdTargets({}, f.home);
  const codex = await providerInstructionState(fs, f.baseDir, 'codex', f);
  await setProviderInstructionMode(fs, f.baseDir, 'codex', 'separate', codex.sourceRevision, f);
  await fs.writeFile(targets[0].path + '.t3-context-backup', '# Original');
  assert.equal((await deleteAgentsMd(fs, f.baseDir, 'stale', f)).code, 'conflict');
  const read = await readAgentsMd(fs, f.baseDir);
  assert.equal((await deleteAgentsMd(fs, f.baseDir, read.revision, f)).unlinked, 2);
  assert.equal((await readAgentsMd(fs, f.baseDir)).present, false);
  assert.equal(await fs.readFile(targets[1].path, 'utf8'), '# Shared');
  assert.equal(await fs.readFile(targets[0].path + '.t3-context-backup', 'utf8'), '# Original');
  for (const target of [targets[0], targets[2]]) await assert.rejects(fs.lstat(target.path), { code: 'ENOENT' });
});

test("the shared file says which agents read it", () => {
  const status = { context: { agentsMd: { present: true, bytes: 1200 }, providers: [
    { provider: 'claude', mode: 'shared' }, { provider: 'codex', mode: 'shared' }, { provider: 'opencode', mode: 'separate' }] } };
  const row = M.contextAgentsMdRow(status);
  assert.equal(row.status.text, '1 kB · read by Claude Code and Codex');
  assert.equal(row.action.label, 'Edit');
  assert.equal(row.menu.map((m) => m.cmd).join(), 'context.delete');
  const unread = M.contextAgentsMdRow({ context: { agentsMd: { present: true, bytes: 10 }, providers: [{ provider: 'codex', mode: 'separate' }] } });
  assert.equal(unread.status.text, '10 B · no agent reads it yet');
});
