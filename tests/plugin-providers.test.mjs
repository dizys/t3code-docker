import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createPluginsService} from '../docker/setup/plugins.mjs';
import {readPluginSource} from '../docker/setup/plugins/sources.mjs';

async function fixture(t,provider='pi'){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'t3-plugin-provider-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const source=path.join(home,'source');await fs.mkdir(path.join(source,'.claude-plugin'),{recursive:true});await fs.mkdir(path.join(source,'.codex-plugin'));
 for(const agent of ['claude','codex'])await fs.writeFile(path.join(source,'.'+agent+'-plugin/plugin.json'),JSON.stringify({name:'demo',version:'1.0.0'}));
 await fs.writeFile(path.join(source,'package.json'),JSON.stringify({name:'demo',version:'1.0.0',private:true,pi:{extensions:['./extension.ts']}}));
 await fs.writeFile(path.join(source,'extension.ts'),'throw new Error("must never execute during install")');
 const calls=[],installed=new Map(),marketplaces=new Map();
 const config=path.join(home,provider==='pi'?'.pi/agent':'.claude','settings.json');await fs.mkdir(path.dirname(config),{recursive:true});await fs.writeFile(config,JSON.stringify({unrelated:{keep:'yes'},packages:['npm:unrelated'],enabledPlugins:{'unrelated@native':false}}));
 const command=async(options,args)=>{
  calls.push(args);
  if(args[0]==='--version')return '2.1.300 (Claude Code)';
  if(args.includes('--help'))return '--keep-data --json';
  if(args[1]==='list')return JSON.stringify([...installed.values()]);
  const cfg=JSON.parse(await fs.readFile(config,'utf8'));
  if(args[1]==='marketplace'){
   if(args[2]==='add'){const catalog=JSON.parse(await fs.readFile(path.join(args[3],'.claude-plugin/marketplace.json'),'utf8'));marketplaces.set(catalog.name,args[3]);}
   return JSON.stringify({outcome:'ok'});
  }
  const id=args[2];
  if(['install','update'].includes(args[1])){
   const [name,market]=id.split('@'),directory=marketplaces.get(market),catalog=JSON.parse(await fs.readFile(path.join(directory,'.claude-plugin/marketplace.json'),'utf8'));
   const packageDir=path.resolve(directory,catalog.plugins[0].source),manifest=JSON.parse(await fs.readFile(path.join(packageDir,'.claude-plugin/plugin.json'),'utf8'));
   const installPath=path.join(home,'.claude/plugins/cache',market,name,manifest.version);await fs.mkdir(path.dirname(installPath),{recursive:true});await fs.cp(packageDir,installPath,{recursive:true});
   // Claude retains previous cache versions after a successful update.

   installed.set(id,{id,scope:'user',enabled:true,version:manifest.version,installPath});cfg.enabledPlugins[id]=true;
  }else if(args[1]==='uninstall'){installed.delete(id);delete cfg.enabledPlugins[id];}
  else if(['enable','disable'].includes(args[1])){cfg.enabledPlugins[id]=args[1]==='enable';installed.get(id).enabled=cfg.enabledPlugins[id];}
  else throw Error('Unexpected native call '+args.join(' '));
  const registry=path.join(home,'.claude/plugins/installed_plugins.json');await fs.mkdir(path.dirname(registry),{recursive:true});await fs.writeFile(registry,JSON.stringify({version:2,plugins:Object.fromEntries([...installed].map(([id,row])=>[id,[{scope:row.scope,installPath:row.installPath,version:row.version}]]))}));
  await fs.writeFile(config,JSON.stringify(cfg));return 'A human progress line\n'+JSON.stringify({outcome:'ok'});
 };
 const options={home,env:{PATH:process.env.PATH},command,getHarness:async()=>({runnable:true,executable:'/fixture/claude'})};
 const service=createPluginsService(options);
 const prepare=async()=>{const preview=await service.previewSource(source);return service.prepare({previewId:preview.previewId,prefix:'',provider});};
 const settle=async plan=>{const{jobId}=await service.apply(plan.planId);for(let i=0;i<200;i++){const result=service.job(jobId);if(result.state!=='running')return result;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Timed out');};
 const owned=async()=> (await service.list()).plugins.find(row=>row.owned);
 return{home,source,service,prepare,settle,owned,calls,config,options,installed};
}

test('one passive source read discovers distinct provider formats and explicit compatibility',async t=>{
 const f=await fixture(t),source=await readPluginSource(f.source,{home:f.home,provider:'all'});
 assert.equal(source.packages.length,1);assert.deepEqual(Object.keys(source.packages[0].variants),['codex','claude','pi','grok']);
 const preview=await f.service.previewSource(f.source);assert.equal(preview.packages[0].providers.filter(p=>p.compatible).length,3);assert.equal(f.calls.length,0);
 const list=await f.service.list();assert(list.providers.find(p=>p.id==='pi').installSupported);assert.equal(list.providers.find(p=>p.id==='opencode').installSupported,true);
});

test('Pi frozen local install, disable/enable, update and removal preserve other settings and snapshots',async t=>{
 const f=await fixture(t),plan=await f.prepare();assert.equal(plan.provider,'pi');assert.match(plan.effects.join(' '),/no Codex per-hook trust/);
 assert.equal((await f.settle(plan)).state,'succeeded');let row=await f.owned();assert.equal(row.enabled,true);const oldPath=row.path;
 const restarted=createPluginsService(f.options);assert.equal((await restarted.list()).plugins.find(p=>p.owned).provider,'pi');
 for(const enabled of [false,true,false]){assert.equal((await f.settle(await f.service.prepare({id:row.id,revision:row.revision,operation:'state',enabled}))).state,'succeeded');row=await f.owned();assert.equal(row.enabled,enabled);}
 const reconcile=await f.service.prepare({id:row.id,revision:row.revision,operation:'reconcile'});assert.equal((await f.settle(reconcile)).state,'succeeded');row=await f.owned();assert(row,'disabled Pi registration remains owned after reconcile');assert.equal(row.enabled,false);
 await fs.writeFile(path.join(f.source,'extension.ts'),'updated source');
 const update=await f.service.prepare({id:row.id,revision:row.revision,operation:'update'});assert.equal((await f.settle(update)).state,'succeeded');row=await f.owned();assert.equal(row.enabled,false);assert.notEqual(row.path,oldPath);
 assert.equal((await f.settle(await f.service.prepare({id:row.id,revision:row.revision,operation:'remove'}))).state,'succeeded');assert.equal(await f.owned(),undefined);
 const cfg=JSON.parse(await fs.readFile(f.config,'utf8'));assert.deepEqual(cfg.packages,['npm:unrelated']);assert.deepEqual(cfg.unrelated,{keep:'yes'});assert(await fs.stat(oldPath));assert.equal(f.calls.length,0,'Pi is never started');
});

test('Pi refuses changed settings, edited snapshots and native resource filters',async t=>{
 const f=await fixture(t),plan=await f.prepare();await fs.writeFile(f.config,JSON.stringify({packages:[],external:true}));
 assert.equal((await f.settle(plan)).state,'failed');assert.deepEqual(JSON.parse(await fs.readFile(f.config,'utf8')),{packages:[],external:true});
 assert.equal((await f.settle(await f.prepare())).state,'succeeded');let row=await f.owned();
 await fs.writeFile(f.config,JSON.stringify({packages:[{source:row.path,extensions:[]}]}));
 const setting=await f.service.prepare({id:row.id,revision:row.revision,operation:'state',enabled:false});assert.equal((await f.settle(setting)).state,'failed');
 await fs.writeFile(path.join(row.path,'extension.ts'),'user edits');
 await assert.rejects(f.service.prepare({id:row.id,revision:row.revision,operation:'remove'}),{code:'conflict'});
});

test('Claude uses scoped native JSON operations, versioned update, exact settings and keep-data removal',async t=>{
 const f=await fixture(t,'claude'),plan=await f.prepare();assert.equal(plan.provider,'claude');assert.equal((await f.settle(plan)).state,'succeeded');let row=await f.owned();assert.equal(row.enabled,true);
 assert.equal((await f.settle(await f.service.prepare({id:row.id,revision:row.revision,operation:'state',enabled:false}))).state,'succeeded');row=await f.owned();
 await fs.writeFile(path.join(f.source,'.claude-plugin/plugin.json'),JSON.stringify({name:'demo',version:'1.1.0'}));
 assert.equal((await f.settle(await f.service.prepare({id:row.id,revision:row.revision,operation:'update'}))).state,'succeeded');row=await f.owned();assert.equal(row.enabled,false);assert.equal(row.version,'1.1.0');
 assert.equal((await f.settle(await f.service.prepare({id:row.id,revision:row.revision,operation:'remove'}))).state,'succeeded');assert.equal(await f.owned(),undefined);
 assert(f.calls.find(args=>args[1]==='uninstall'&&!args.includes('--help')).includes('--keep-data'));assert(!f.calls.flat().includes('--yes'));assert(f.calls.find(args=>args[1]==='update').includes('--scope'));
 assert.equal(JSON.parse(await fs.readFile(f.config,'utf8')).unrelated.keep,'yes');
});

test('provider and source mismatches, unknown providers and old Claude releases fail before mutation',async t=>{
 const f=await fixture(t);await fs.rm(path.join(f.source,'.claude-plugin'),{recursive:true});
 const preview=await f.service.previewSource(f.source);
 await assert.rejects(f.service.prepare({previewId:preview.previewId,prefix:'',provider:'claude'}),{code:'unsupported'});
 await assert.rejects(f.service.prepare({previewId:preview.previewId,prefix:'',provider:'cursor'}),{code:'unsupported'});
 const service=createPluginsService({...f.options,command:async()=> '2.1.200'});const source=await service.previewSource(f.source);
 await assert.rejects(service.prepare({previewId:source.previewId,prefix:'',provider:'claude'}),{code:'unsupported'});
});

test('Claude refuses implicit dependency installation from existing native plugins',async t=>{
 const f=await fixture(t,'claude'),unrelated=path.join(f.home,'other');await fs.mkdir(path.join(unrelated,'.claude-plugin'),{recursive:true});
 await fs.writeFile(path.join(unrelated,'.claude-plugin/plugin.json'),JSON.stringify({name:'other',dependencies:['unreviewed@source']}));
 f.installed.set('other@native',{id:'other@native',scope:'user',installPath:unrelated});
 await assert.rejects(f.prepare(),{code:'unsupported'});assert.equal(f.calls.some(args=>args[1]==='marketplace'),false);
});

test('a later target must be reviewed again after a successful install changes shared tracking',async t=>{
 const f=await fixture(t),first=await f.prepare(),second=await f.prepare();
 assert.equal((await f.settle(first)).state,'succeeded');
 const failed=await f.settle(second);assert.equal(failed.state,'failed');assert.match(failed.error,/changed after review/);
 assert.equal((await f.service.list()).plugins.filter(p=>p.owned).length,1);
});

test('Claude binds registry/catalog revisions and refuses same-version file replacement',async t=>{
 const f=await fixture(t,'claude');assert.equal((await f.settle(await f.prepare())).state,'succeeded');let row=await f.owned();
 await fs.writeFile(path.join(f.source,'extension.ts'),'changed under same version');
 let review=await f.service.prepare({id:row.id,revision:row.revision,operation:'update'});assert.equal(review.canApply,false);assert.match(review.blocked.join(' '),/upstream version/);await f.service.discard(review.planId);
 review=await f.service.prepare({id:row.id,revision:row.revision,operation:'state',enabled:false});
 const tracking=path.join(f.home,'.claude/plugins/installed_plugins.json');await fs.writeFile(tracking,'{"plugins":{}}');
 let result=await f.settle(review);assert.equal(result.state,'failed');assert.match(result.error,/registrations changed/);assert.equal((await f.owned()).enabled,true);
 review=await f.service.prepare({id:row.id,revision:row.revision,operation:'state',enabled:false});
 const record=JSON.parse(await fs.readFile(path.join(f.home,'.t3/setup/plugins/installed.json'),'utf8')).records[0];
 await fs.appendFile(path.join(record.marketplaceDir,'.claude-plugin/marketplace.json'),' ');
 result=await f.settle(review);assert.equal(result.state,'failed');assert.match(result.error,/marketplace changed/);
});
