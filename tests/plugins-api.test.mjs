import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';

test('plugin API protects reads, reviews and writes and never executes inventory content', {timeout:30000},async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'t3-plugins-api-'));
 const source=path.join(home,'.codex/plugins/cache/fixture/sample/1.0.0');
 await fs.mkdir(path.join(source,'.codex-plugin'),{recursive:true});
 await fs.writeFile(path.join(source,'.codex-plugin/plugin.json'),JSON.stringify({name:'sample',version:'1.0.0'}));
 const sentinel=path.join(home,'executed');
 await fs.writeFile(path.join(source,'index.mjs'),`require('fs').writeFileSync(${JSON.stringify(sentinel)},'ran')`);
 const harness=path.join(home,'harness.mjs');
 await fs.writeFile(harness,'export const createHarnessManager = () => ({status:async()=>({harnesses:[],degraded:[]})});');
 const socket=createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const child=spawn(process.execPath,['docker/setup/server.mjs'],{env:{...process.env,PATH:'/usr/bin:/bin',MISE_DATA_DIR:path.join(home,'.local/share/mise'),MISE_CONFIG_DIR:path.join(home,'.config/mise'),MISE_STATE_DIR:path.join(home,'.local/state/mise'),HOME:home,T3CODE_HOME:path.join(home,'.t3'),CODEX_HOME:path.join(home,'.codex'),XDG_CONFIG_HOME:path.join(home,'.config'),T3_HARNESS_MODULE:harness,T3_SETUP_PORT:String(port),T3_SETUP_KEY:'plugins-fixture',T3_SETUP_KEY_SOURCE:'env',T3_WORKSPACE:path.join(home,'workspace'),T3_INFRA_LAUNCHER:'/bin/false',T3CODE_PORT:'1'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 t.after(async()=>{if(child.exitCode===null){const exit=once(child,'exit');child.kill();await exit;}await fs.rm(home,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
 const base=`http://127.0.0.1:${port}/__setup`,headers={'x-t3-setup-key':'plugins-fixture'};
 for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/hello')).ok)break;}catch{}await new Promise(r=>setTimeout(r,20));}
 const post=(route,body,extra={})=>fetch(base+route,{method:'POST',headers:{...headers,'content-type':'application/json',...extra},body:JSON.stringify(body)});
 for(const route of ['/context/plugins','/context/plugins/read','/context/plugins/job'])assert.equal((await fetch(base+route)).status,401);
 for(const route of ['/context/plugins/source','/context/plugins/plan','/context/plugins/apply','/context/plugins/discard']){
  assert.equal((await fetch(base+route,{method:'POST'})).status,401);
  assert.equal((await post(route,{}, {'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await post(route,null)).status,400);
 }
 const response=await fetch(base+'/context/plugins',{headers});assert.equal(response.status,200);
 const data=await response.json();assert(data.plugins.some(p=>p.name==='sample'));
 assert.equal(await fs.stat(sentinel).catch(()=>null),null);
 assert.equal((await fetch(base+'/context/plugins/read?id=/etc/passwd',{headers})).status,400);
 assert.equal((await fetch(base+'/context/plugins/apply',{headers})).status,405);
 const preview=await (await post('/context/plugins/source',{source})).json();assert.equal(preview.ok,true);
 const refused=await post('/context/plugins/plan',{previewId:preview.previewId,prefix:''});assert.equal(refused.status,403);
 assert.equal((await post('/context/plugins/apply',{planId:'forged'})).status,409);
 assert.equal(await fs.stat(sentinel).catch(()=>null),null);
});
