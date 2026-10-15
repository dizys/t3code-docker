// Real HTTP service with gated CLI processes: an unfinished read must never
// become an empty verdict or multiply when several browsers poll together.
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test('status shares slow auth reads, warms later polls, and invalidates revoked devices', { timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-auth-lists-'));
  const launcher = path.join(root, 't3');
  await fs.writeFile(launcher, `#!${process.execPath}
import fs from 'node:fs/promises';
const root=${JSON.stringify(root)};
const [auth,kind,action]=process.argv.slice(2);
if(auth!=='auth') process.exit(1);
if(action==='list') {
 await fs.appendFile(root+'/calls',kind+'\\n');
 while(true){try{await fs.access(root+'/release');break}catch{await new Promise(r=>setTimeout(r,20))}}
 let revoked=false;try{await fs.access(root+'/revoked');revoked=true}catch{}
 console.log(JSON.stringify(kind==='session'&&!revoked?[{sessionId:'phone',subject:'device',createdAt:new Date().toISOString()}]:[]));
} else if(action==='revoke') await fs.writeFile(root+'/revoked','yes');
`, { mode: 0o700 });
  // Use .mjs semantics even on older Node versions without syntax detection.
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
  const home = path.join(root, 'home'); await fs.mkdir(home);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../docker/setup/server.mjs', import.meta.url))], { env: {
    ...process.env, HOME: home, T3CODE_HOME: path.join(home, '.t3'), T3_WORKSPACE: root,
    MISE_DATA_DIR: path.join(root, 'mise-data'), MISE_STATE_DIR: path.join(root, 'mise-state'), MISE_CONFIG_DIR: path.join(root, 'mise-config'),
    T3_HARNESS_MODULE: fileURLToPath(new URL('../docker/harness/index.mjs', import.meta.url)),
    T3_SETUP_KEY: 'fixture', T3_SETUP_KEY_SOURCE: 'env', T3_SETUP_PORT: String(port), T3CODE_PORT: '1', T3_INFRA_LAUNCHER: launcher,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', (x) => { logs += x; }); child.stderr.on('data', (x) => { logs += x; });
  t.after(async () => { if(child.exitCode===null){const exit=once(child,'exit');child.kill();await exit;} await fs.rm(root,{recursive:true,force:true}); });
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body ? 'POST' : 'GET', headers: { 'x-t3-setup-key': 'fixture', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, 200); return response.json();
  };
  for(let i=0;i<200;i++){if(child.exitCode!==null)throw new Error(logs);try{await fetch(`http://127.0.0.1:${port}/hello`);break}catch{await pause(20)}}
  const initial = await Promise.all([request('/status'),request('/status')]);
  for(const s of initial){assert.equal(s.authLists.session.available,false);assert.equal(s.authLists.session.refreshing,true);assert.ok(!s.degraded.some(d=>/pairing|devices/.test(d.what)));}
  assert.deepEqual((await fs.readFile(path.join(root,'calls'),'utf8')).trim().split('\n').sort(), ['pairing','session']);
  await fs.writeFile(path.join(root,'release'),'yes');
  let warm;
  for(let i=0;i<100;i++){warm=await request('/status');if(warm.authLists.session.available)break;await pause(20)}
  assert.equal(warm.sessions[0].sessionId,'phone');assert.equal(warm.authLists.session.stale,false);
  assert.deepEqual(warm.pairings,[]);assert.equal(warm.authLists.pairing.available,true);
  await request('/revoke',{kind:'session',id:'phone'});
  // A fast refresh may already have completed; either way the revoked row
  // must disappear from the first status response after the mutation.
  const invalidated=await request('/status');assert.deepEqual(invalidated.sessions,[]);
  for(let i=0;i<100;i++){warm=await request('/status');if(warm.authLists.session.available)break;await pause(20)}
  assert.equal(warm.authLists.session.available,true);assert.deepEqual(warm.sessions,[]);
});
