// Check the actual authenticated HTTP boundary in a disposable agent home.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("global instruction API discovers existing files and changes them only on explicit provider saves", { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-context-api-"));
  const home = path.join(root, "home"), codex = path.join(home, ".codex"), config = path.join(home, ".config");
  await fs.mkdir(codex, { recursive: true });
  await fs.writeFile(path.join(codex, "AGENTS.md"), "# User-owned Codex instructions");
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../docker/setup/server.mjs", import.meta.url))], { env: {
    ...process.env, HOME: home, T3CODE_HOME: path.join(home, ".t3"), T3_WORKSPACE: path.join(root, "workspace"),
    CODEX_HOME: codex, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), XDG_CONFIG_HOME: config, OPENCODE_CONFIG_DIR: path.join(config, "opencode"),
    MISE_DATA_DIR: path.join(home, ".local/share/mise"), MISE_STATE_DIR: path.join(home, ".local/state/mise"),
    MISE_CONFIG_DIR: path.join(config, "mise"), T3_SETUP_PORT: String(port), T3_SETUP_KEY: "fixture-key",
    T3_SETUP_KEY_SOURCE: "env", T3_INFRA_LAUNCHER: "/bin/false", T3CODE_PORT: "1",
  }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    // Native status probes can finish filesystem work during shutdown. Drain
    // their stdio and allow bounded cleanup retries, as other API fixtures do.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base + "/hello")).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(ready, logs);
  const api = (body, headers = {}) => fetch(base + "/context/agents-md", { method: body === undefined ? "GET" : "POST",
    headers: { "x-t3-setup-key": "fixture-key", "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await fetch(base + "/context/agents-md")).status, 401);
  assert.equal((await (await api()).json()).present, false);
  assert.equal((await api({ content: "# Ignore" }, { "sec-fetch-site": "cross-site" })).status, 403);
  const save = await api({ content: "# Shared instructions\n" });
  assert.equal(save.status, 200);
  const result = await save.json();
  assert.equal(result.reconcile.skipped[0].provider, "codex");
  assert.equal(result.reconcile.linked.length, 2);
  for (const target of [".claude/CLAUDE.md", ".config/opencode/AGENTS.md"]) assert.equal(await fs.readFile(path.join(home, target), "utf8"), "# Shared instructions\n");
  assert.equal(await fs.readFile(path.join(codex, "AGENTS.md"), "utf8"), "# User-owned Codex instructions");
  const status = await (await fetch(base + '/status', { headers: { 'x-t3-setup-key': 'fixture-key' } })).json();
  assert.deepEqual(status.context.providers.filter((file) => file.mode === 'separate').map((file) => file.provider), ['codex']);
  assert.ok(!('content' in status.context.providers[0]));
  // Existing instructions load into their own editor and save to that file.
  const readProvider = (provider) => fetch(base + '/context/agents-md?provider=' + provider, { headers: { 'x-t3-setup-key': 'fixture-key' } });
  assert.equal((await fetch(base + '/context/agents-md?provider=codex')).status, 401);
  let providerRead = await (await readProvider('codex')).json();
  assert.equal(providerRead.content, '# User-owned Codex instructions');
  assert.equal((await api({ provider: 'codex', content: '# Edited Codex', revision: providerRead.revision })).status, 200);
  assert.equal(await fs.readFile(path.join(codex, 'AGENTS.md'), 'utf8'), '# Edited Codex');
  assert.equal((await api({ provider: 'codex', content: '# Stale draft', revision: providerRead.revision })).status, 409);
  assert.equal((await api({ provider: '../escape', content: '# Draft', revision: 'fake' })).status, 400);
  assert.equal((await readProvider('../escape')).status, 400);
  assert.equal((await api({ provider: 'codex', content: '# No revision' })).status, 409);
  assert.equal((await api({ provider: 'codex', content: '' })).status, 400);
  assert.equal((await api({ provider: 'codex', content: '# Cross-site' }, { 'sec-fetch-site': 'cross-site' })).status, 403);

  // Existing user symlinks are followed on explicit saves, preserving the link.
  const linked = path.join(home, '.claude', 'CLAUDE.md');
  await fs.unlink(linked);
  const source = path.join(root, 'user-claude.md');
  await fs.writeFile(source, '# Existing Claude');
  await fs.symlink(path.relative(path.dirname(linked), source), linked);
  providerRead = await (await readProvider('claude')).json();
  assert.equal(providerRead.content, '# Existing Claude');
  assert.equal((await api({ provider: 'claude', content: '# Edited Claude', revision: providerRead.revision })).status, 200);
  assert.ok((await fs.lstat(linked)).isSymbolicLink());
  assert.equal(await fs.readFile(source, 'utf8'), '# Edited Claude');
  // A provider request cannot use an arbitrary path supplied by the client.
  providerRead = await (await readProvider('codex')).json();
  assert.equal((await api({ provider: 'codex', path: source, content: '# Codex only', revision: providerRead.revision })).status, 200);
  assert.equal(await fs.readFile(source, 'utf8'), '# Edited Claude');
  // Source switching is authenticated, revision-checked and preserves separate files.
  const context = async () => (await (await fetch(base + '/status', { headers: { 'x-t3-setup-key': 'fixture-key' } })).json()).context;
  let codexState = (await context()).providers.find((file) => file.provider === 'codex');
  assert.equal(codexState.mode, 'separate');
  assert.equal((await api({ provider:'codex', mode:'shared', sourceRevision:codexState.sourceRevision }, { 'sec-fetch-site':'cross-site' })).status,403);
  assert.equal((await api({ provider:'codex', mode:'shared', sourceRevision:codexState.sourceRevision })).status,200);
  assert.ok((await fs.lstat(path.join(codex,'AGENTS.md'))).isSymbolicLink());
  assert.equal(await fs.readFile(path.join(codex,'AGENTS.md.t3-context-backup'),'utf8'),'# Codex only');
  assert.equal((await api({ provider:'codex', mode:'separate', sourceRevision:codexState.sourceRevision })).status,409);
  codexState = (await context()).providers.find((file) => file.provider === 'codex');
  assert.equal(codexState.mode,'shared');
  assert.equal((await api({ provider:'codex', mode:'separate', sourceRevision:codexState.sourceRevision })).status,200);
  assert.equal(await fs.readFile(path.join(codex,'AGENTS.md'),'utf8'),'# Codex only');
  assert.equal((await fs.lstat(path.join(codex,'AGENTS.md'))).isSymbolicLink(),false);
  assert.equal((await api({ provider:'codex', mode:'unknown', sourceRevision:codexState.sourceRevision })).status,400);
  // Stale shared editors receive the same conflict response as provider editors.
  const firstShared = await (await api()).json();
  const secondShared = await (await api()).json();
  assert.equal((await api({ content: '# New shared content', revision: firstShared.revision })).status, 200);
  assert.equal((await api({ content: '# Stale shared content', revision: secondShared.revision })).status, 409);
  assert.equal((await (await api()).json()).content, '# New shared content');

  // Saving shared edits must not undo an explicit None selection.
  const openCodeState = (await context()).providers.find((file) => file.provider === 'opencode');
  assert.equal((await api({ provider: 'opencode', mode: 'none', sourceRevision: openCodeState.sourceRevision })).status, 200);
  const beforeEdit = await (await api()).json();
  assert.equal((await api({ content: '# Keep None disconnected', revision: beforeEdit.revision })).status, 200);
  assert.equal((await context()).providers.find((file) => file.provider === 'opencode').mode, null);
  await assert.rejects(fs.lstat(path.join(config, 'opencode/AGENTS.md')), { code: 'ENOENT' });

  // JSON escaping and metadata must not reduce the 64 KiB Markdown allowance.
  const boundaryFiles = [
    'x'.repeat(65536),
    '# Line breaks\n' + '\n'.repeat(65522),
    '# Escaped bytes\n' + '\u0001'.repeat(65520),
    'é'.repeat(32768),
  ];
  for (const content of boundaryFiles) {
    assert.equal(Buffer.byteLength(content), 65536);
    const read = await (await api()).json();
    const saved = await api({ content, revision: read.revision });
    assert.equal(saved.status, 200, JSON.stringify(await saved.json()));
    assert.equal((await (await api()).json()).content, content);
    const codexRead = await (await readProvider('codex')).json();
    assert.equal((await api({ provider: 'codex', content, revision: codexRead.revision })).status, 200);
    assert.equal(await fs.readFile(path.join(codex, 'AGENTS.md'), 'utf8'), content);
  }
  const final = await (await api()).json();
  for (const content of ['', 'x'.repeat(65537), 'é'.repeat(32769)]) {
    assert.equal((await api({ content, revision: final.revision })).status, 400);
  }
  assert.equal((await api({ content: '# Small', revision: final.revision, padding: 'x'.repeat(400000) })).status, 400);
  assert.equal((await (await api()).json()).content, final.content);

  // Existing oversized files are reported without editor contents or revisions.
  const oversized = 'x'.repeat(65537);
  await fs.writeFile(path.join(home, '.t3/setup/context/AGENTS.md'), oversized);
  const sharedResponse = await api();
  assert.equal(sharedResponse.status, 400);
  const sharedRead = await sharedResponse.json();
  assert.equal(sharedRead.present, true);
  assert.equal(sharedRead.code, 'too_large');
  assert.equal(sharedRead.bytes, 65537);
  assert.equal(sharedRead.content, null);
  assert.equal(sharedRead.revision, null);
  assert.equal((await api({ content: '# Replacement', revision: final.revision })).status, 400);
  for (const symlink of [false, true]) {
    const file = path.join(codex, 'AGENTS.md');
    await fs.unlink(file);
    if (symlink) await fs.symlink(path.join(home, '.t3/setup/context/AGENTS.md'), file);
    else await fs.writeFile(file, oversized);
    const response = await readProvider('codex');
    assert.equal(response.status, 400);
    const read = await response.json();
    assert.equal(read.code, 'too_large');
    assert.equal(read.content, null);
    assert.equal(read.revision, null);
    assert.match(read.error, /too large to edit/);
    const status = await context();
    assert.equal(status.agentsMd.present, true);
    assert.equal(status.providers.find((p) => p.provider === 'codex').mode, symlink ? 'shared' : 'separate');
    assert.match(status.providers.find((p) => p.provider === 'codex').error, /too large to edit/);
    assert.equal((await api({ provider: 'codex', content: '# Replacement', revision: null })).status, 400);
    assert.equal(await fs.readFile(file, 'utf8'), oversized);
  }
});
