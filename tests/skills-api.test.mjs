// The setup HTTP boundary, including reverse-proxy prefixes and arbitrary-path rejection.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("skill endpoints require authentication and only read discovered installations", { timeout: 30000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-skills-api-"));
  const directory = path.join(home, ".claude/skills/one"); await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "SKILL.md");
  const markdown = "---\nname: one\ndescription: Local fixture\n---\nOriginal instructions.\n";
  await fs.writeFile(file, markdown);
  const other = path.join(home, "unrelated.md"); await fs.writeFile(other, "Not a skill");
  const nativeFile = path.join(home, ".codex/skills/native/SKILL.md");
  await fs.mkdir(path.dirname(nativeFile), { recursive: true }); await fs.writeFile(nativeFile, markdown);
  const executable = path.join(home, "fake-codex");
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const config = path.join(process.env.CODEX_HOME, 'config.toml');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line); let result;
 if(m.method === 'initialized') return;
 if(m.method === 'initialize') result = {};
 else if(m.method === 'skills/list') result = {data:[{cwd:process.env.HOME,skills:[{path:${JSON.stringify(nativeFile)},name:'native',description:'Native fixture',scope:'user',enabled:!fs.existsSync(config)||!fs.readFileSync(config,'utf8').includes('enabled = false')}],errors:[]}]};
 else if(m.method === 'skills/config/write') {
  if(m.params.path !== ${JSON.stringify(nativeFile)}) process.exit(10);
  fs.writeFileSync(config, 'enabled = ' + m.params.enabled + '\\n'); result = {effectiveEnabled:m.params.enabled};
 } else if(m.method === 'hooks/list') {
  const content=fs.existsSync(config)?fs.readFileSync(config,'utf8'):'';
  result={data:[{cwd:process.env.HOME,hooks:[{key:'fixture-hook',source:'plugin',sourcePath:config+'.hooks.json',pluginId:'fixture@local',eventName:'sessionStart',handlerType:'command',command:'node fixture.js',currentHash:'sha256:'+'a'.repeat(64),trustStatus:content.includes('trusted_hash')?'trusted':'untrusted',enabled:!content.includes('hook_disabled'),isManaged:false,matcher:null,timeoutSec:15,async:false}],errors:[],warnings:[]}]};
 } else if(m.method === 'config/read') result={layers:[{name:{type:'user',file:config},version:'fixture-hook-version'}]};
 else if(m.method === 'config/batchWrite') {
  if(m.params.filePath!==config||m.params.expectedVersion!=='fixture-hook-version') process.exit(12);
  let content=fs.existsSync(config)?fs.readFileSync(config,'utf8'):'';
  for(const edit of m.params.edits) {
   if(edit.keyPath==='hooks.state."fixture-hook".trusted_hash') content+='\\n# trusted_hash '+edit.value;
   else if(edit.keyPath==='hooks.state."fixture-hook".enabled') content=edit.value?content.replaceAll('# hook_disabled',''):content+'\\n# hook_disabled';
   else process.exit(13);
  }
  fs.writeFileSync(config,content);result={status:'ok',filePath:config};
 } else process.exit(11);
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});
`);
  await fs.chmod(executable, 0o700);
  const claudeExecutable = path.join(home, "fake-claude");
  await fs.writeFile(claudeExecutable, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); const file=path.join(process.env.CLAUDE_CONFIG_DIR,'settings.json');
 const cfg=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
 process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{claude_code_version:'2.1.302',commands:cfg.skillOverrides?.['api-policy']==='off'?[]:[{name:'api-policy'}]}}})+'\\n');
});`); await fs.chmod(claudeExecutable, 0o700);
  const harnessModule = path.join(home, "harness.mjs");
  await fs.writeFile(harnessModule, `export const createHarnessManager = () => ({status:async()=>({harnesses:[{id:'codex',runnable:true,installed:true,executable:${JSON.stringify(executable)}},{id:'claude',runnable:true,installed:true,executable:${JSON.stringify(claudeExecutable)}}],degraded:[]})});`);
  const reservation = createServer().listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../docker/setup/server.mjs", import.meta.url))], { env: {
    ...process.env, HOME: home, T3CODE_HOME: path.join(home, ".t3"), T3_WORKSPACE: path.join(home, "workspace"),
    CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"), XDG_CONFIG_HOME: path.join(home, ".config"),
    MISE_DATA_DIR: path.join(home, ".local/share/mise"), MISE_STATE_DIR: path.join(home, ".local/state/mise"), MISE_CONFIG_DIR: path.join(home, ".config/mise"),
    T3_HARNESS_MODULE: harnessModule, T3_SETUP_PORT: String(port), T3_SETUP_KEY: "skills-fixture-key", T3_SETUP_KEY_SOURCE: "env", T3_INFRA_LAUNCHER: "/bin/false", T3CODE_PORT: "1",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; child.stdout.on("data", (data) => { logs += data; }); child.stderr.on("data", (data) => { logs += data; });
  t.after(async () => {
    if (child.exitCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
    await fs.rm(home, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`, base = origin + "/__setup";
  let ready = false;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base + "/hello")).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(ready, logs);
  const get = (route) => fetch(base + route, { headers: { "x-t3-setup-key": "skills-fixture-key" } });
  const post = (route, body, headers = {}) => fetch(base + route, { method: "POST", headers: { "x-t3-setup-key": "skills-fixture-key", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + "/context/skills?provider=claude")).status, 401);
  assert.equal((await fetch(base + "/context/skills/reach")).status, 401);
  const reach = await (await get("/context/skills/reach")).json();
  assert.equal(reach.ok, true);
  assert.equal(reach.home, home);
  assert.deepEqual(reach.roots.find(root => root.owner === "claude").readers, ["claude", "opencode", "cursor", "grok", "muse"]);
  assert(reach.roots.every(root => !("content" in root)));
  assert.equal((await fetch(base + "/context/skills/read?provider=claude&id=" + "a".repeat(32))).status, 401);
  assert.equal((await get("/context/skills?provider=__proto__")).status, 400);
  assert.equal((await get("/context/skills")).status, 400);
  for (const operation of ["source", "plan", "install", "discard", "check-update", "update/preview", "update"]) {
    assert.equal((await fetch(base + "/context/skills/" + operation, { method: "POST" })).status, 401);
    assert.equal((await post("/context/skills/" + operation, {}, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await post("/context/skills/" + operation, null)).status, 400);
  }
  // Reset the intentional login throttle between authorization groups using
  // the real login route; cumulative guessing delays are tested elsewhere.
  const login = await fetch(base + "/login", { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ key: "skills-fixture-key" }) });
  assert.equal((await login.json()).ok, true);
  assert.equal((await post("/context/skills/source", { source: "file:///etc/passwd" })).status, 400);
  const importSource = path.join(home, "source/imported/SKILL.md");
  await fs.mkdir(path.dirname(importSource), { recursive: true });
  await fs.writeFile(importSource, "---\nname: imported\ndescription: API import\n---\nImport from a snapshot.\n");
  const preview = await (await post("/context/skills/source", { source: path.dirname(importSource) })).json();
  assert.equal(preview.ok, true); assert.equal(preview.skills[0].name, "imported");
  const importPlan = await (await post("/context/skills/plan", { previewId: preview.previewId, skills: ["imported"], providers: ["cursor"] })).json();
  assert.equal(importPlan.canInstall, true);
  assert.equal((await post("/context/skills/install", { previewId: preview.previewId, planId: "forged" })).status, 409);
  const imported = await (await post("/context/skills/install", { previewId: preview.previewId, planId: importPlan.planId, path: other })).json();
  assert.equal(imported.results[0].status, "installed");
  assert.match(await fs.readFile(path.join(home, ".cursor/skills/imported/SKILL.md"), "utf8"), /API import/);
  assert.equal(await fs.readFile(other, "utf8"), "Not a skill");
  await post("/context/skills/discard", { previewId: preview.previewId });
  assert.equal((await post("/context/skills/plan", { previewId: preview.previewId, skills: ["imported"], providers: ["cursor"] })).status, 409);
  const result = await (await get("/context/skills?provider=claude")).json();
  assert.equal(result.coverage, "policy"); assert.equal(result.skills.length, 1);
  const row = result.skills[0]; assert.equal(row.name, "one"); assert.ok(!("content" in row));
  assert.equal((await post("/context/skills/check-update", { provider: "claude", id: row.id })).status, 403);
  assert.equal((await post("/context/skills/update/preview", { provider: "claude", id: row.id, path: other })).status, 403);
  assert.equal((await post("/context/skills/update/preview", { provider: "claude", id: other })).status, 400);
  assert.equal((await post("/context/skills/update", { previewId: other, planId: other, replace: true })).status, 409);
  assert.equal((await post("/context/skills/check-update", { skills: [] })).status, 400);
  assert.equal((await post("/context/skills/check-update", { skills: [{ provider: "claude", id: "/etc/passwd" }] })).status, 400);
  const batch = await (await post("/context/skills/check-update", { skills: [{ provider: "claude", id: row.id }] })).json();
  assert.equal(batch.ok, true); assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0].id, row.id); assert.equal(batch.results[0].provider, "claude");
  assert.equal(batch.results[0].ok, false); assert.equal(batch.results[0].code, "unsupported");
  const readPath = "/context/skills/read?provider=claude&id=" + row.id;
  assert.equal((await (await get(readPath + "&path=" + encodeURIComponent(other))).json()).content, markdown);
  assert.deepEqual((await (await get(readPath)).json()).files.map(file => file.name), ["SKILL.md"]);
  assert.equal((await get("/context/skills/read?provider=claude&id=" + encodeURIComponent(other))).status, 400);
  assert.equal((await get("/context/skills/read?provider=claude&id=" + "0".repeat(32))).status, 404);
  const changed = markdown.replace("name: one", "name: changed"); await fs.writeFile(file, changed);
  assert.equal((await (await get("/context/skills?provider=claude")).json()).skills[0].name, "one");
  assert.equal((await (await get("/context/skills?provider=claude&refresh=1")).json()).skills[0].name, "changed");
  await fs.writeFile(file, "x".repeat(65537));
  assert.equal((await get(readPath)).status, 413);
  await fs.unlink(file); await fs.symlink(other, file);
  assert.equal((await get(readPath)).status, 409);
  assert.equal(await fs.readFile(other, "utf8"), "Not a skill");
  await fs.unlink(file); assert.equal((await get(readPath)).status, 404);
  const draft = "---\nname: local-new\ndescription: A local skill\n---\nUse the project conventions.\n";
  assert.equal((await fetch(base + "/context/skills/create", { method: "POST" })).status, 401);
  assert.equal((await post("/context/skills/create", { provider: "claude", slug: "local-new", content: draft }, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post("/context/skills/create", { provider: "claude", slug: "../escape", content: draft })).status, 400);
  assert.equal((await post("/context/skills/create", { provider: "claude", slug: "local-new", content: draft })).status, 200);
  assert.equal((await post("/context/skills/create", { provider: "claude", slug: "local-new", content: draft })).status, 409);
  const added = (await (await get("/context/skills?provider=claude")).json()).skills.find((skill) => skill.name === "local-new");
  const detailPath = "/context/skills/read?provider=claude&id=" + added.id;
  let detail = await (await get(detailPath)).json();
  assert.equal(detail.canEdit, true); assert.ok(detail.revision); assert.ok(detail.removalRevision);
  const prefix = "---\nname: local-new\ndescription: A local skill\n---\n";
  const boundary = prefix + "\u0001".repeat(65536 - Buffer.byteLength(prefix));
  assert.equal((await post("/context/skills/save", { provider: "claude", id: added.id, revision: detail.revision, content: boundary })).status, 200);
  assert.equal((await (await get(detailPath)).json()).content, boundary);
  assert.equal((await post("/context/skills/save", { provider: "claude", id: added.id, revision: detail.revision, content: draft })).status, 409);
  detail = await (await get(detailPath)).json();
  assert.equal((await post("/context/skills/remove", { provider: "claude", id: added.id, revision: detail.revision })).status, 409);
  assert.equal((await post("/context/skills/remove", { provider: "claude", id: added.id, revision: detail.revision, removalRevision: detail.removalRevision })).status, 200);
  assert.equal((await get(detailPath)).status, 404);
  assert.equal((await post("/context/skills/create", null)).status, 400);
  assert.equal((await fetch(base + "/context/skills/state", { method: "POST" })).status, 401);
  const native = (await (await get("/context/skills?provider=codex")).json()).skills.find((skill) => skill.path === nativeFile);
  assert.ok(native.canToggle);
  const state = { provider: "codex", id: native.id, stateRevision: native.stateRevision, enabled: false };
  assert.equal((await post("/context/skills/state", state, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post("/context/skills/state", { ...state, enabled: "false" })).status, 400);
  assert.equal((await post("/context/skills/state", { ...state, id: other })).status, 400);
  assert.equal((await post("/context/skills/state", { ...state, stateRevision: null })).status, 409);
  assert.equal((await post("/context/skills/state", { ...state, provider: "claude" })).status, 400);
  const disabled = await post("/context/skills/state", { ...state, path: other });
  assert.equal(disabled.status, 200);
  const verified = await disabled.json(); assert.equal(verified.enabled, false);
  const disabledRow = verified.inventory.skills.find((skill) => skill.id === native.id);
  assert.equal(disabledRow.state, "disabled");
  assert.equal((await post("/context/skills/state", { ...state, enabled: true })).status, 409);
  assert.equal((await post("/context/skills/state", { ...state, enabled: true, stateRevision: disabledRow.stateRevision })).status, 200);
  assert.equal(await fs.readFile(other, "utf8"), "Not a skill");
  const policyMarkdown = "---\nname: api-policy\ndescription: API policy fixture\n---\nFixture.\n";
  assert.equal((await post("/context/skills/create", { provider: "claude", slug: "api-policy", content: policyMarkdown })).status, 200);
  let policyRow = (await (await get("/context/skills?provider=claude")).json()).skills.find((row) => row.name === "api-policy");
  assert.equal(policyRow.canSetState, true); assert.equal(policyRow.stateOptions.length, 4);
  const policyInput = { provider: "claude", id: policyRow.id, stateRevision: policyRow.stateRevision, state: "off" };
  assert.equal((await post("/context/skills/state", policyInput, { "sec-fetch-site": "cross-site" })).status, 403);
  const changedPolicy = await post("/context/skills/state", policyInput); assert.equal(changedPolicy.status, 200);
  policyRow = (await changedPolicy.json()).inventory.skills.find((row) => row.id === policyRow.id);
  assert.equal(policyRow.state, "off"); assert.equal(policyRow.effectiveStateText, "Manual command hidden");
  assert.equal((await post("/context/skills/state", { ...policyInput, state: "on" })).status, 409);
  assert.equal((await post("/context/skills/state", { ...policyInput, stateRevision: policyRow.stateRevision, state: "name-only" })).status, 200);
  assert.equal(await fs.readFile(path.join(home, ".claude/skills/api-policy/SKILL.md"), "utf8"), policyMarkdown);
  const sharedMarkdown = "---\nname: shared-api\ndescription: Shared API fixture\n---\nFixture.\n";
  assert.equal((await post("/context/skills/create", { provider: "codex", slug: "shared-api", content: sharedMarkdown, target: "shared" })).status, 200);
  assert.equal(await fs.readFile(path.join(home, ".agents/skills/shared-api/SKILL.md"), "utf8"), sharedMarkdown);
  assert.equal((await fetch(base + '/context/skills/hooks')).status, 401);
  assert.equal((await fetch(base + '/context/skills/hooks/state', { method: 'POST' })).status, 401);
  assert.equal((await post('/context/skills/hooks/state', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post('/context/skills/hooks/state', null)).status, 400);
  const hooks = await (await get('/context/skills/hooks')).json(); assert.equal(hooks.hooks.length, 1);
  const hook = hooks.hooks[0]; assert.equal(hook.command, 'node fixture.js'); assert.equal(hook.currentHash, undefined);
  assert.equal((await post('/context/skills/hooks/state', { id: other, revision: hook.revision, action: 'trust' })).status, 400);
  assert.equal((await post('/context/skills/hooks/state', { id: hook.id, action: 'trust' })).status, 409);
  const trustedHook = await (await post('/context/skills/hooks/state', { id: hook.id, revision: hook.revision, action: 'trust', key: 'forged' })).json();
  assert.equal(trustedHook.hooks[0].trustStatus, 'trusted');
  assert.equal((await post('/context/skills/hooks/state', { id: hook.id, revision: hook.revision, action: 'disable' })).status, 409);
  const disabledHook = await (await post('/context/skills/hooks/state', { id: hook.id, revision: trustedHook.hooks[0].revision, action: 'disable' })).json();
  assert.equal(disabledHook.hooks[0].enabled, false);
  const html = await (await fetch(base)).text();
  assert.ok(!html.includes(markdown), "skill contents are never inlined into the page");
});
