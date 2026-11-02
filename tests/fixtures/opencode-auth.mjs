// Disposable HTTP/CLI boundary for credential regressions and browser audits.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function authFixture({ port = 0, version = '2.0.32', executable: nativeExecutable } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 't3-opencode-auth-api-'));
  const stateFile = path.join(home, 'accounts.json'), modeFile = path.join(home, 'mode.json'), factsFile = path.join(home, 'facts.json');
  const executable = nativeExecutable || path.join(home, 'opencode.mjs');
  await fs.writeFile(stateFile, '[]'); await fs.writeFile(modeFile, '{}'); await fs.writeFile(factsFile, '{}');
  if (!nativeExecutable) await fs.writeFile(executable, `#!${process.execPath}
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
const root=${JSON.stringify(home)}, args=process.argv.slice(2), action=args[1];
if(args[0]==='--version'){console.log('opencode v${version}');process.exit(0)}
const read=async(name)=>JSON.parse(await fs.readFile(root+'/'+name,'utf8'));
if(args[0]==='serve'){
 const server=createServer(async(req,res)=>{
  if(req.headers.authorization!=='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_PASSWORD).toString('base64')){res.writeHead(401).end();return}
  const route=/^\\/api\\/integration\\/([^/]+)(\\/connect\\/key)?$/.exec(req.url);
  const mode=await read('mode.json');
  if(route&&req.method==='GET'){
   const rows=await read('accounts.json');const row=rows.find(r=>r.id===route[1])||{id:route[1],connections:[]};
   res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({data:{...row,methods:[{type:'key'}]}}));return;
  }
  if(req.method==='POST'&&/^\\/api\\/credential\\/[^/]+\\/activate$/.test(req.url)){res.writeHead(204).end();return}
  if(req.method!=='POST'||!route?.[2]){res.writeHead(404).end();return}
  let text='';for await(const chunk of req)text+=chunk;
  const entry=JSON.parse(text);
  await fs.writeFile(root+'/import-started','yes');
  while((await read('mode.json')).gateImport)await new Promise(r=>setTimeout(r,10));
  if(mode.failImport){res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:entry.key}));return}
  const rows=await read('accounts.json');let row=rows.find(r=>r.id===route[1]);
  if(!row){row={id:route[1],name:route[1],connections:[]};rows.push(row)}
  row.connections.push({type:'credential',id:'cred_fixture_'+Date.now(),label:entry.label,method:'key'});
  await fs.writeFile(root+'/accounts.next',JSON.stringify(rows));await fs.rename(root+'/accounts.next',root+'/accounts.json');
  res.writeHead(204).end();
 });
 server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port})));
 process.stdin.resume();process.stdin.on('end',()=>server.close(()=>process.exit(0)));
 process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
 await new Promise(()=>{});
}
const mode=await read('mode.json');
await fs.appendFile(root+'/calls',action+'\\n');
if(action==='list'){
 await fs.writeFile(root+'/list-started','yes');
 while((await read('mode.json')).gateList) await new Promise(r=>setTimeout(r,10));
 if(mode.failList)process.exit(1);
 console.log(mode.malformedList?'[broken':JSON.stringify(mode.failSwitch?[]:await read('accounts.json')));process.exit(0);
}
let rows=await read('accounts.json');
if(action==='logout'){
 await fs.writeFile(root+'/logout-started','yes');
 while((await read('mode.json')).gateLogout) await new Promise(r=>setTimeout(r,10));
 if(mode.failLogout)process.exit(1);
 if(!mode.ignoreLogout)for(const row of rows)if(row.id===args[2])row.connections=row.connections.filter(c=>c.id!==args[3]);
}else process.exit(1);
await fs.writeFile(root+'/accounts.next',JSON.stringify(rows));await fs.rename(root+'/accounts.next',root+'/accounts.json');
`, { mode: 0o700 });
  const harness = path.join(home, 'harness.mjs');
  const source = new URL('../../docker/harness/index.mjs', import.meta.url).href;
  await fs.writeFile(harness, `export * from ${JSON.stringify(source)};
import {readFile} from 'node:fs/promises';
const row={id:'opencode',name:'OpenCode',installed:true,configured:true,runnable:true,installedVersion:${JSON.stringify(version)},executable:${JSON.stringify(executable)},authenticated:true};
export const createHarnessManager=()=>({
 resolve:async(id)=>{
  const facts=JSON.parse(await readFile(${JSON.stringify(factsFile)},'utf8'));
  if(id==='codex'&&facts.codex)return facts.codex;
  if(id!=='opencode')return {id,runnable:false,installed:false};
  if(facts.resolveFails)throw new Error('fixture resolver unavailable');
  return {...row,...facts};
 },
 status:async()=>{
  const {codex}=JSON.parse(await readFile(${JSON.stringify(factsFile)},'utf8'));
  return {harnesses:[row,...(codex?[codex]:[])],degraded:[]};
 },invalidateAuth(){},
 latestRelease:async()=>({version:'2.0.32'}),
 toolchains:{status:async()=>({toolchains:[],degraded:[]}),latestRelease:async()=>({version:'1'})},
 packages:{status:async()=>({packages:[],degraded:[]})},paths:{stateDir:${JSON.stringify(home)}}
});`);
  const preload = path.join(home, 'catalogue.mjs');
  await fs.writeFile(preload, `const original=globalThis.fetch;
globalThis.fetch=(input,init)=>String(input)==='https://models.dev/api.json'
 ? Promise.resolve(Response.json({anthropic:{name:'Anthropic'},openai:{name:'OpenAI'}})) : original(input,init);`);
  const reservation = createServer().listen(port, '127.0.0.1');
  await once(reservation, 'listening'); port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const env = { ...process.env, HOME: home, T3CODE_HOME: path.join(home, '.t3'), T3_WORKSPACE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    MISE_CONFIG_DIR: path.join(home, '.config/mise'), MISE_DATA_DIR: path.join(home, '.local/share/mise'),
    MISE_STATE_DIR: path.join(home, '.local/state/mise'), MISE_CACHE_DIR: path.join(home, '.cache/mise'),
    T3_RUN_DIR: path.join(home, '.run'), T3_HARNESS_MODULE: harness,
    T3_RUNTIME_MODULE: new URL('../../docker/runtime/manager.mjs', import.meta.url).href,
    T3_PROVIDER_MODULE: new URL('../../docker/provider-integration/index.mjs', import.meta.url).href,
    T3_SETUP_PORT: String(port), T3_SETUP_KEY: 'auth-fixture', T3_SETUP_KEY_SOURCE: 'env',
    T3_INFRA_LAUNCHER: '/bin/false', T3CODE_PORT: '1', T3_PUBLIC_URL: '' };
  for (const key of Object.keys(env)) if (/TOKEN|API_KEY|^OPENCODE/.test(key)) delete env[key];
  const child = spawn(process.execPath, ['--import', preload, fileURLToPath(new URL('../../docker/setup/server.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close'); let logs = '';
  child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-10000); });
  child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-10000); });
  const base = `http://127.0.0.1:${port}/__setup`;
  const request = (route, body, headers = {}) => fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-t3-setup-key': 'auth-fixture', 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const mode = async (value) => { await fs.writeFile(modeFile + '.next', JSON.stringify(value)); await fs.rename(modeFile + '.next', modeFile); };
  const facts = (value) => fs.writeFile(factsFile, JSON.stringify(value));
  const close = async () => {
    await mode({});
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  try {
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(logs);
      try { if ((await request('/hello')).ok) return { home, env, base, request, mode, facts, close, executable, stateFile }; } catch {}
      await pause(20);
    }
    throw new Error('Credential fixture did not start: ' + logs);
  } catch (error) { await close(); throw error; }
}
