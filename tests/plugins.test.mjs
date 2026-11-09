import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createPluginsService} from '../docker/setup/plugins.mjs';
import {readPluginSource} from '../docker/setup/plugins/sources.mjs';

async function fixture(t) {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'t3-plugin-test-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const source=path.join(home,'source');
  await fs.mkdir(path.join(source,'.codex-plugin'),{recursive:true});
  await fs.writeFile(path.join(source,'.codex-plugin/plugin.json'),JSON.stringify({name:'demo',version:'1.0.0',hooks:'./hooks/hooks.json'}));
  await fs.mkdir(path.join(source,'hooks'));
  await fs.writeFile(path.join(source,'hooks/hooks.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:'touch sentinel'}]}]}}));
  await fs.writeFile(path.join(source,'run.sh'),'touch '+path.join(home,'sentinel'));await fs.chmod(path.join(source,'run.sh'),0o700);
  await fs.mkdir(path.join(home,'.codex'));
  await fs.writeFile(path.join(home,'.codex/config.toml'),'# keep comment\nmodel="keep"\n');
  const calls=[],installed=new Set();
  let rejectAdd=false,marketplacePath;
  const command=async(options,args)=>{
    calls.push(args);
    if(args[0]==='--version')return 'codex-cli 0.167.0';
    if(args[1]==='marketplace'){if(args[2]==='add')marketplacePath=args[3];return '{}';}
    if(args[1]==='add'){if(rejectAdd)throw Error('Fixture add refused');installed.add(args[2]);const [name,market]=args[2].split('@');await fs.mkdir(path.join(home,'.codex/plugins/cache',market,name),{recursive:true});await fs.cp(path.join(marketplacePath,'package'),path.join(home,'.codex/plugins/cache',market,name,'1.0.0'),{recursive:true});return '{}';}
    if(args[1]==='remove'){installed.delete(args[2]);return '{}';}
    if(args[1]==='list')return JSON.stringify({installed:[...installed].map(pluginId=>({pluginId,installed:true}))});
    throw Error('Unexpected command '+args.join(' '));
  };
  const options={home,env:{PATH:process.env.PATH},command,getHarness:async()=>({runnable:true,executable:'/fixture/codex'})};
  const service=createPluginsService(options);
  const preview=()=>service.previewSource(source);
  const prepare=async()=>{const result=await preview();return service.prepare({previewId:result.previewId,prefix:''});};
  const settle=async jobId=>{for(let i=0;i<100;i++){const job=service.job(jobId);if(job.state!=='running')return job;await new Promise(r=>setTimeout(r,10));}throw Error('Job did not settle');};
  return {home,source,service,options,calls,installed,preview,prepare,settle,rejectAdd:()=>{rejectAdd=true;}};
}

test('source review retains hidden manifests, supporting bytes and executable mode without execution',async t=>{
  const f=await fixture(t),snapshot=await readPluginSource(f.source,{home:f.home});
  assert.equal(snapshot.packages.length,1);const p=snapshot.packages[0];
  assert(p.files.some(f=>f.name==='.codex-plugin/plugin.json'));assert(p.files.find(f=>f.name==='run.sh').mode&0o100);
  assert.equal(await fs.stat(path.join(f.home,'sentinel')).catch(()=>null),null);
  const preview=await f.preview();assert.equal(preview.packages[0].hooks[0].command,'touch sentinel');
  assert.equal(f.calls.length,0,'preview never starts the provider');
});

test('source links, special files and unsupported network sources fail before an install',async t=>{
  const f=await fixture(t);await fs.symlink('/etc/passwd',path.join(f.source,'escape'));
  await assert.rejects(readPluginSource(f.source,{home:f.home}),{code:'unsupported'});
  for(const source of ['https://127.0.0.1/a.git','http://github.com/demo/test','https://github.com/a/b?token=secret','git@internal:a/b.git'])await assert.rejects(readPluginSource(source,{home:f.home}));
});

test('plan and apply bind the authenticated owner and immutable reviewed snapshot',async t=>{
  const f=await fixture(t),preview=await f.service.previewSource(f.source,'one');
  await assert.rejects(f.service.prepare({previewId:preview.previewId,prefix:''},'two'),{code:'conflict'});
  const p=await f.service.prepare({previewId:preview.previewId,prefix:''},'one');
  await assert.rejects(f.service.apply(p.planId,'two'),{code:'conflict'});
  await fs.writeFile(path.join(f.source,'run.sh'),'modified after preview');
  const result=await f.service.apply(p.planId,'one');
  for(let i=0;i<100&&f.service.job(result.jobId,'one').state==='running';i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(f.service.job(result.jobId,'one').state,'succeeded');
  const installed=(await f.service.list()).plugins.find(p=>p.owned);
  assert.match(await fs.readFile(path.join(installed.path,'run.sh'),'utf8'),/^touch/);
  assert.throws(()=>f.service.job(result.jobId,'two'),{code:'missing'});
});

test('double apply is idempotent; native success is verified and survives a service restart',async t=>{
  const f=await fixture(t),p=await f.prepare();
  const first=await f.service.apply(p.planId),again=await f.service.apply(p.planId);assert.equal(first.jobId,again.jobId);
  assert.equal((await f.settle(first.jobId)).state,'succeeded');
  assert.equal(f.calls.filter(a=>a[1]==='add').length,1);
  const restarted=createPluginsService(f.options),owned=(await restarted.list()).plugins.filter(p=>p.owned);
  assert.equal(owned.length,1);assert.equal(owned[0].name,'demo');
  assert.match(await fs.readFile(path.join(f.home,'.codex/config.toml'),'utf8'),/keep comment/);
});

test('settings changed after review reject apply without native mutation',async t=>{
  const f=await fixture(t),p=await f.prepare();await fs.appendFile(path.join(f.home,'.codex/config.toml'),'# external\n');
  const j=await f.service.apply(p.planId);assert.equal((await f.settle(j.jobId)).state,'failed');
  assert.equal(f.calls.some(a=>a[0]==='plugin'),false);
});

test('dependency scripts block automatic install; no generic consent bypass',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.source,'package.json'),JSON.stringify({scripts:{postinstall:'touch sentinel'}}));
  const p=await f.prepare();assert.equal(p.canApply,false);
  await assert.rejects(f.service.apply(p.planId),{code:'unsupported'});
  assert.equal(f.calls.some(a=>a[0]==='plugin'),false);
});

test('native failure retains partial state and does not claim installation succeeded',async t=>{
  const f=await fixture(t),p=await f.prepare();f.rejectAdd();
  const j=await f.service.apply(p.planId),done=await f.settle(j.jobId);assert.equal(done.state,'failed');assert.equal(done.partial,true);
  const row=(await f.service.list()).plugins.find(p=>p.owned);assert.equal(row.status,'installing');
  await assert.rejects(f.service.prepare({id:row.id,revision:row.revision,operation:'remove'}),{code:'conflict'});
});

test('expire reviews and reject external package mutations',async t=>{
  const f=await fixture(t);let now=0;const service=createPluginsService({...f.options,now:()=>now});
  const preview=await service.previewSource(f.source),p=await service.prepare({previewId:preview.previewId,prefix:''});now=600001;
  await assert.rejects(service.apply(p.planId),{code:'conflict'});
  await assert.rejects(service.prepare({id:'a'.repeat(32),operation:'remove'}),{code:'unsupported'});
});

test('updates review file changes and preserve disabled state; removal uses native ownership',async t=>{
 const f=await fixture(t),p=await f.prepare();await f.settle((await f.service.apply(p.planId)).jobId);
 let row=(await f.service.list()).plugins.find(p=>p.owned);
 const state=await f.service.prepare({id:row.id,revision:row.revision,operation:'state',enabled:false});
 await f.settle((await f.service.apply(state.planId)).jobId);
 row=(await f.service.list()).plugins.find(p=>p.owned);assert.equal(row.enabled,false);
 await fs.writeFile(path.join(f.source,'run.sh'),'Changed source\n');
 const update=await f.service.prepare({id:row.id,revision:row.revision,operation:'update'});
 assert.equal(update.changes.find(f=>f.name==='run.sh').status,'modified');
 assert.match(update.changes.find(f=>f.name==='run.sh').beforeText,/touch/);
 assert.equal((await f.settle((await f.service.apply(update.planId)).jobId)).state,'succeeded');
 row=(await f.service.list()).plugins.find(p=>p.owned);assert.equal(row.enabled,false);
 const remove=await f.service.prepare({id:row.id,revision:row.revision,operation:'remove'});
 assert.equal((await f.settle((await f.service.apply(remove.planId)).jobId)).state,'succeeded');
 assert.equal((await f.service.list()).plugins.some(p=>p.owned),false);
});

test('external cache edits block both update and removal',async t=>{
 const f=await fixture(t),p=await f.prepare();await f.settle((await f.service.apply(p.planId)).jobId);
 const row=(await f.service.list()).plugins.find(p=>p.owned);
 await fs.writeFile(path.join(row.path,'run.sh'),'Local edits');
 for(const operation of ['update','remove'])await assert.rejects(f.service.prepare({id:row.id,revision:row.revision,operation}),{code:'conflict'});
});

test('Git snapshot materializes only repository-contained links and rejects escapes and cycles',async t=>{
 const f=await fixture(t);
 const read=async target=>{
  const entries=[{name:'plugin/.codex-plugin/plugin.json',mode:'100644',data:JSON.stringify({name:'linked'})},{name:'plugin/lib/shared',mode:'120000',data:target},{name:'shared/code.py',mode:'100644',data:'print("not executed")'}].map((e,i)=>({...e,object:String(i+1).padStart(40,'0')}));
  const run=async(_command,args)=>{
   if(args.includes('rev-parse'))return {stdout:Buffer.from('a'.repeat(40))};
   if(args.includes('ls-tree'))return {stdout:Buffer.from(entries.map(e=>`${e.mode} blob ${e.object} ${Buffer.byteLength(e.data)}\t${e.name}\0`).join(''))};
   if(args.includes('cat-file'))return {stdout:Buffer.from(entries.find(e=>e.object===args.at(-1)).data)};
   return {stdout:Buffer.alloc(0)};
  };
  return readPluginSource('https://github.com/example/plugin',{home:f.home,run});
 };
 const snapshot=await read('../../shared');
 assert(snapshot.packages[0].files.some(f=>f.name==='lib/shared/code.py'));
 assert(snapshot.packages[0].files.every(f=>[0o600,0o700].includes(f.mode)));
 await assert.rejects(read('../../../outside'),{code:'unsupported'});
 await assert.rejects(read('./shared'),{code:'unsupported'});
});

test('missing component references and unsupported hook types cannot be installed',async t=>{
 const f=await fixture(t);
 await fs.writeFile(path.join(f.source,'.codex-plugin/plugin.json'),JSON.stringify({name:'demo',version:'1.0.0',hooks:'../../outside.json'}));
 let p=await f.prepare();assert.equal(p.canApply,false);await assert.rejects(f.service.apply(p.planId),{code:'unsupported'});
 await f.service.discard(p.planId);
 await fs.writeFile(path.join(f.source,'.codex-plugin/plugin.json'),JSON.stringify({name:'demo',version:'1.0.0',hooks:{hooks:{Stop:[{hooks:[{type:'prompt',prompt:'Something to review in Codex'}]}]}}}));
 p=await f.prepare();assert.equal(p.canApply,false);assert(p.hooks.some(h=>h.handlerType==='prompt'));
 await assert.rejects(f.service.apply(p.planId),{code:'unsupported'});
});

test('removal verification accepts a retained native row marked uninstalled',async t=>{
 const f=await fixture(t),plan=await f.prepare();await f.settle((await f.service.apply(plan.planId)).jobId);
 const row=(await f.service.list()).plugins.find(p=>p.owned);
 const service=createPluginsService({...f.options,command:async(options,args)=>{
  const result=await f.options.command(options,args);
  if(args[1]==='list'&&!f.installed.size)return JSON.stringify({installed:[{pluginId:row.nativeId,installed:false}]});
  return result;
 }});
 const remove=await service.prepare({id:row.id,revision:row.revision,operation:'remove'}),{jobId}=await service.apply(remove.planId);
 for(let i=0;i<100&&service.job(jobId).state==='running';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(service.job(jobId).state,'succeeded');assert.equal((await service.list()).plugins.some(p=>p.owned),false);
});

test('update review retains bounded old text for a file removed by its source',async t=>{
 const f=await fixture(t);
 await fs.writeFile(path.join(f.source,'removed.txt'),'Existing instructions being removed.');
 const plan=await f.prepare();await f.settle((await f.service.apply(plan.planId)).jobId);
 const row=(await f.service.list()).plugins.find(p=>p.owned);
 await fs.unlink(path.join(f.source,'removed.txt'));
 const update=await f.service.prepare({id:row.id,revision:row.revision,operation:'update'});
 assert.deepEqual(update.changes.find(f=>f.name==='removed.txt'),{name:'removed.txt',status:'removed',beforeText:'Existing instructions being removed.'});
});
