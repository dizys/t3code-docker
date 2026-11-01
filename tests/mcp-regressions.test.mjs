import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createMcpService } from "../docker/setup/mcp.mjs";
import { applyMcpToml, parseMcpToml } from "../docker/setup/mcp/toml.mjs";
import { readProviderMcp, writeProviderMcpEntry } from "../docker/setup/mcp/adapters.mjs";
import { mcpStorePathFor, validateMcpServer } from "../docker/setup/mcp/store.mjs";
const server = (name, extra = {}) => ({ name, type: "local", command: ["server"], env: {}, ...extra });
async function fixture(t, extraEnv = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-mcp-regression-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), baseDir = path.join(root, "state");
  const env = { HOME: home, ...extraEnv };
  return { root, home, baseDir, env, svc: createMcpService({ home, baseDir, env, io: fs }) };
}

test("Codex edits preserve nested servers, multiline strings and unrelated array tables", () => {
  const unrelated = '# skill policy\n[[skills.config]]\npath = "/tmp/skill"\nenabled = false\n';
  const raw = '# model\nmodel = "test"\n\n[mcp_servers.probe]\ncommand = "node"\nargs = [\n "a,b",\n "\\\\u0041",\n]\n[mcp_servers.probe.env]\nTOKEN = """first\n[mcp_servers.fake]\nlast"""\n\n' + unrelated;
  const parsed = parseMcpToml(raw);
  assert.equal(parsed.size, 1);
  assert.deepEqual(parsed.get("probe").args, ["a,b", "\\u0041"]);
  const removed = applyMcpToml(raw, "probe", null);
  assert.ok(removed.includes(unrelated));
  assert.equal(parseMcpToml(removed).size, 0);
  assert.ok(removed.startsWith('# model\nmodel = "test"'));
  const updated = applyMcpToml(raw, "probe", { command: "other", env: { TOKEN: "a,b\nsecond", EMPTY: "" } });
  assert.deepEqual(parseMcpToml(updated).get("probe"), { command: "other", env: { TOKEN: "a,b\nsecond", EMPTY: "" } });
  assert.ok(updated.includes(unrelated));
});

test("Codex rejects malformed documents before writing and hides parser values", async (t) => {
  const f = await fixture(t), file = path.join(f.home, ".codex/config.toml");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const raw = '[mcp_servers.probe]\ncommand="secret-credential\n';
  await fs.writeFile(file, raw);
  await assert.rejects(writeProviderMcpEntry(fs, "codex", f, "probe", null), (e) => e.code === "unsupported" && !e.message.includes("secret-credential"));
  assert.equal(await fs.readFile(file, "utf8"), raw);
});

test("native OpenCode 2 dictionaries are inventoried, updated and unlinked in place", async (t) => {
  const f = await fixture(t), file = path.join(f.home, ".config/opencode/opencode.jsonc");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{\n// retained\n"mcp":{"timeout":10000,"servers":{"probe":{"type":"local","command":["server"],"disabled":true},"own":{"type":"remote","url":"https://example.test/mcp"}}}\n}\n');
  const created = await f.svc.create(server("probe", { enabled: false }));
  assert.equal((await f.svc.list("opencode")).shared[0].linked, true);
  const saved = await f.svc.save("probe", created.revision, server("probe"));
  await f.svc.setLink("opencode", "probe", true, saved.revision, (await f.svc.list("opencode")).revision, true);
  assert.equal((await f.svc.list("opencode")).shared[0].linked, true);
  assert.match(await fs.readFile(file, "utf8"), /"disabled": false/);
  await f.svc.setLink("opencode", "probe", false, saved.revision, (await f.svc.list("opencode")).revision);
  const read = await readProviderMcp(fs, "opencode", f);
  assert.deepEqual(read.servers.map((r) => r.name), ["own"]);
  const raw = await fs.readFile(file, "utf8");
  assert.match(raw, /retained/); assert.match(raw, /"timeout":\s*10000/);
});

test("concurrent links retain both entries, also through a provider-file symlink", async (t) => {
  for (const provider of ["claude", "codex", "opencode", "cursor"]) {
    const f = await fixture(t);
    const file = provider === "claude" ? path.join(f.home, ".claude.json") : provider === "codex" ? path.join(f.home, ".codex/config.toml") : provider === "cursor" ? path.join(f.home, ".cursor/mcp.json") : path.join(f.home, ".config/opencode/opencode.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const target = path.join(f.root, "persistent-config");
    await fs.writeFile(target, provider === "codex" ? '# retained\nmodel="test"\n' : '{"retained":true}\n', { mode: 0o600 });
    await fs.symlink(target, file);
    await f.svc.create(server("first")); const second = await f.svc.create(server("second"));
    await Promise.all([f.svc.setLink(provider, "first", true, second.revision), f.svc.setLink(provider, "second", true, second.revision)]);
    assert.equal((await fs.lstat(file)).isSymbolicLink(), true, provider);
    const read = await readProviderMcp(fs, provider, f);
    assert.deepEqual(read.servers.map((r) => r.name).sort(), ["first", "second"], provider);
    assert.match(await fs.readFile(target, "utf8"), /retained/);
    const backups = (await fs.readdir(f.root)).filter(n => n.includes('.t3-mcp-backup.'));
    assert.equal(backups.length, 2);
    for (const backup of backups) assert.equal((await fs.stat(path.join(f.root, backup))).mode & 0o777, 0o600);
  }
});

test("provider revisions refuse external edits and retargeted symlinks", async (t) => {
  const f = await fixture(t), created = await f.svc.create(server("probe"));
  const read = await f.svc.list("claude");
  await fs.mkdir(f.home, { recursive: true });
  const file = path.join(f.home, ".claude.json");
  await fs.writeFile(file, '{"retained":true}');
  await assert.rejects(f.svc.setLink("claude", "probe", true, created.revision, read.revision), { code: "conflict" });
  const a = path.join(f.root, 'a'), b = path.join(f.root, 'b');
  await fs.writeFile(a, '{}'); await fs.writeFile(b, '{}'); await fs.rm(file); await fs.symlink(a, file);
  const revision = (await f.svc.list("claude")).revision;
  await fs.rm(file); await fs.symlink(b, file);
  await assert.rejects(f.svc.setLink("claude", "probe", true, created.revision, revision), { code: "conflict" });
  assert.equal(await fs.readFile(b, 'utf8'), '{}');
});

test("legacy shared disable does not change Claude’s native state and removal requires unlink", async (t) => {
  const f = await fixture(t), created = await f.svc.create(server("probe"));
  await f.svc.setLink("claude", "probe", true, created.revision);
  const saved = await f.svc.save("probe", created.revision, server("probe", { enabled: false }));
  const state = (await f.svc.status({ refresh: true })).providers.find(p => p.provider === 'claude');
  assert.deepEqual(state.linked, ['probe']); assert.deepEqual(state.diverged, []); assert.deepEqual(state.unlinked, []);
  await assert.rejects(f.svc.remove("probe", saved.revision), { code: 'conflict' });
  await f.svc.setLink("claude", "probe", false, saved.revision, state.revision);
  assert.equal((await f.svc.remove("probe", saved.revision)).ok, true);
});

test("store limits reject writes and leave a usable previous store", async (t) => {
  const f = await fixture(t), original = await f.svc.create(server("first"));
  const large = Object.fromEntries(Array.from({length:33},(_,i)=>['KEY_'+i,'x'.repeat(8192)]));
  await assert.rejects(f.svc.create(server('large', { env: large })), { code: 'too_large' });
  await assert.rejects(f.svc.save('first', original.revision, server('first', { env: large })), { code: 'too_large' });
  assert.equal((await f.svc.read('first')).revision, original.revision);
  const entries = Array.from({length:128},(_,i)=>server('s'+i));
  await fs.writeFile(mcpStorePathFor(f.baseDir), JSON.stringify({servers:entries}));
  await assert.rejects(f.svc.create(server('extra')), { code: 'too_large' });
  assert.equal((await f.svc.status({refresh:true})).shared.count, 128);
});

test("URLs, headers, unsupported providers and extra provider options are honest", async (t) => {
  const f = await fixture(t);
  for (const url of ['https://user:password@example.test', 'https://', 'https://host\n.test', 'https://[broken']) assert.equal(validateMcpServer({name:'remote',type:'remote',url}).ok, false);
  assert.equal(validateMcpServer({name:'remote',type:'remote',url:'https://example.test',headers:{Authorization:'a',authorization:'b'}}).ok, false);
  await f.svc.create({name:'remote',type:'remote',url:'https://example.test/private-secret-path?token=secret',headers:{Authorization:'secret'}});
  const c = await f.svc.create(server('probe'));
  await f.svc.setLink('codex','probe',true,c.revision);
  const file = path.join(f.home,'.codex/config.toml');
  await fs.writeFile(file, '[mcp_servers.probe]\ncommand="server"\ncwd="/different"\n');
  const status = await f.svc.status({refresh:true});
  assert.equal(status.shared.servers.find(s=>s.name==='remote').url, 'https://example.test');
  assert.equal(JSON.stringify(status).includes('private-secret-path'), false);
  assert.equal(JSON.stringify(status).includes('token=secret'), false);
  assert.deepEqual(status.providers.find(p=>p.provider==='codex').diverged,['probe']);
  await assert.rejects(f.svc.setLink('antigravity','probe',true,c.revision), {code:'unsupported'});
});

test("Claude override roots are honored and duplicate JSON keys cannot be changed", async (t) => {
  const f = await fixture(t, {CLAUDE_CONFIG_DIR:'custom-claude'}), c = await f.svc.create(server('probe'));
  await f.svc.setLink('claude','probe',true,c.revision);
  const file=path.join(f.home,'custom-claude/.claude.json');
  assert.equal(JSON.parse(await fs.readFile(file,'utf8')).mcpServers.probe.command,'server');
  const raw='{"mcpServers":{},"mcpServers":{"probe":{"command":"existing"}}}';
  await fs.writeFile(file,raw);
  await assert.rejects(f.svc.setLink('claude','probe',false,c.revision),{code:'unsupported'});
  assert.equal(await fs.readFile(file,'utf8'),raw);
});

test("mixed transport fields differ and malformed native maps are not recognized", async (t) => {
  for (const provider of ['claude', 'codex', 'opencode', 'cursor']) {
    const f = await fixture(t);
    const created = await f.svc.create({name:'probe',type:'remote',url:'https://example.test/mcp',headers:{}});
    const mixed = provider === 'codex' ? {url:'https://example.test/mcp',command:'extra'}
      : provider === 'opencode' ? {type:'remote',url:'https://example.test/mcp',command:['extra']}
        : {type:'http',url:'https://example.test/mcp',command:'extra'};
    await writeProviderMcpEntry(fs,provider,f,'probe',mixed);
    assert.equal((await f.svc.list(provider)).shared[0].diverged,true,provider);
    await f.svc.setLink(provider,'probe',true,created.revision,(await f.svc.list(provider)).revision);
    assert.equal((await f.svc.list(provider)).shared[0].linked,true,provider);
    const headerKey = provider === 'codex' ? 'http_headers' : 'headers';
    await writeProviderMcpEntry(fs,provider,f,'probe',{...mixed,[headerKey]:'not-an-object'});
    assert.equal((await readProviderMcp(fs,provider,f)).servers[0].canonical,null,provider);
    const local = provider === 'opencode' ? {type:'local',command:['server'],environment:0}
      : {command:'server',env:0};
    await writeProviderMcpEntry(fs,provider,f,'probe',local);
    assert.equal((await readProviderMcp(fs,provider,f)).servers[0].canonical,null,provider);
    if (['claude','cursor'].includes(provider)) {
      await writeProviderMcpEntry(fs,provider,f,'probe',{command:'server',type:'http'});
      assert.equal((await readProviderMcp(fs,provider,f)).servers[0].canonical,null,provider);
    }
  }
});

test("the browser CLI and console can alternate without duplicate TOML or ignored JSONC/V2 entries", async (t) => {
  const f = await fixture(t), bin = path.join(f.root, 'bin');
  await fs.mkdir(bin);
  for (const name of ['playwright-mcp', 'managed']) await fs.writeFile(path.join(bin, name), '#!/bin/sh\nexit 0\n', {mode:0o755});
  const resolver = path.join(f.root, 'resolve.mjs');
  await fs.writeFile(resolver, `console.log(${JSON.stringify(path.join(bin, 'managed'))});`);
  const adapters = new URL('../docker/setup/mcp/adapters.mjs', import.meta.url).href;
  const command = fileURLToPath(new URL('../docker/bin/t3-browser-mcp', import.meta.url));
  const env = {...process.env,...f.env,PATH:bin+path.delimiter+process.env.PATH,T3_INFRA_NODE:process.execPath,T3_PROVIDER_CLI:resolver,T3_MCP_ADAPTERS_MODULE:adapters,CODEX_HOME:path.join(f.home,'.codex'),XDG_CONFIG_HOME:path.join(f.home,'.config'),OPENCODE_CONFIG_DIR:path.join(f.home,'.config/opencode')};
  delete env.CLAUDE_CONFIG_DIR;
  const ocFile=path.join(f.home,'.config/opencode/opencode.jsonc');
  await fs.mkdir(path.dirname(ocFile),{recursive:true});await fs.writeFile(ocFile,'{\n// keep\n"mcp":{"servers":{}}\n}\n');
  const svc=createMcpService({home:f.home,baseDir:f.baseDir,env,io:fs});
  const created=await svc.create(server('playwright'));
  for(const provider of ['codex','opencode']) {
    await svc.setLink(provider,'playwright',true,created.revision);
    for(let i=0;i<2;i++) await promisify(execFile)('bash',[command,'--harness',provider],{env,timeout:15000});
    assert.equal((await readProviderMcp(fs,provider,{home:f.home,env})).servers.filter(r=>r.name==='playwright').length,1);
    await svc.setLink(provider,'playwright',true,created.revision);
    await promisify(execFile)('bash',[command,'--harness',provider,'--remove'],{env,timeout:15000});
    assert.equal((await svc.list(provider)).shared[0].linked,false);
  }
  assert.match(await fs.readFile(ocFile,'utf8'),/keep/);
});


test("Claude HTTP needs an explicit transport while Cursor accepts its URL default", async (t) => {
  const f = await fixture(t);
  const url = 'https://example.test/mcp';
  await f.svc.create({name:'probe',type:'remote',url,headers:{}});
  await writeProviderMcpEntry(fs,'claude',f,'probe',{url});
  assert.equal((await f.svc.list('claude')).shared[0].diverged,true);
  assert.equal((await readProviderMcp(fs,'claude',f)).servers[0].canonical,null);
  await writeProviderMcpEntry(fs,'cursor',f,'probe',{url});
  assert.equal((await f.svc.list('cursor')).shared[0].linked,true);
  await writeProviderMcpEntry(fs,'claude',f,'probe',{type:'streamable-http',url});
  assert.equal((await f.svc.list('claude')).shared[0].linked,true);
});

test("OpenCode V2 global options without servers retain their shape when linking", async (t) => {
  for (const options of [{codemode:false},{protocol:'legacy'},{timeout:{startup:30000}}]) {
    const f = await fixture(t), file = path.join(f.home,'.config/opencode/opencode.jsonc');
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,JSON.stringify({mcp:options}));
    const created = await f.svc.create(server('probe'));
    assert.deepEqual((await readProviderMcp(fs,'opencode',f)).servers,[]);
    await f.svc.setLink('opencode','probe',true,created.revision);
    assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')).mcp,{...options,servers:{probe:{type:'local',command:['server'],disabled:false}}});
    assert.equal((await f.svc.list('opencode')).shared[0].linked,true);
  }
  // V1 servers can use these names; transport-bearing objects are entries.
  const f = await fixture(t);
  for (const name of ['servers','timeout','codemode','protocol']) await writeProviderMcpEntry(fs,'opencode',f,name,{type:'local',command:['server']});
  assert.deepEqual((await readProviderMcp(fs,'opencode',f)).servers.map(s=>s.name),['servers','timeout','codemode','protocol']);
});

test("OpenCode inventory distinguishes V1 enabled and V2 disabled flags", async (t) => {
  for (const v2 of [false, true]) for (const enabled of [false, true]) {
    const f = await fixture(t), file = path.join(f.home,'.config/opencode/opencode.json');
    await fs.mkdir(path.dirname(file),{recursive:true});
    const wrongFlag = v2 ? {enabled} : {disabled:!enabled};
    const entry = {type:'local',command:['server'],...wrongFlag};
    await fs.writeFile(file,JSON.stringify({mcp:v2 ? {servers:{probe:entry}} : {probe:entry}}));
    const created = await f.svc.create(server('probe',{enabled}));
    assert.equal((await f.svc.list('opencode')).shared[0].linked,false);
    assert.equal((await f.svc.list('opencode')).shared[0].diverged,true);
    const native = await readProviderMcp(fs,'opencode',f);
    assert.equal(native.servers[0].extra,true);
    assert.equal(native.servers[0].canonical.enabled,true,'the other format’s flag must not change native state');
    await f.svc.setLink('opencode','probe',true,created.revision,native.revision,enabled);
    const repaired = await readProviderMcp(fs,'opencode',f);
    assert.equal((await f.svc.list('opencode')).shared[0].linked,true);
    assert.equal(repaired.servers[0].canonical.enabled,enabled);
    assert.deepEqual(repaired.servers[0].entry,{type:'local',command:['server'],...(v2 ? {disabled:!enabled} : {enabled})});
  }
});
