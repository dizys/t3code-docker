import test from 'node:test';import assert from 'node:assert/strict';import * as fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createPluginsService} from '../docker/setup/plugins.mjs';

async function fixture(t,env={}){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'t3-plugin-opencode-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const source=path.join(home,'source');await fs.mkdir(path.join(source,'opencode'),{recursive:true});await fs.mkdir(path.join(source,'scripts'));
 await fs.writeFile(path.join(source,'package.json'),JSON.stringify({name:'module-test',version:'1.0.0',private:true,pi:{extensions:[]}}));
 await fs.writeFile(path.join(source,'opencode/module.ts'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(path.join(home,'sentinel'))},'unsafe');export default {id:'module-test',setup(){}};`);
 await fs.writeFile(path.join(source,'scripts/helper.sh'),'supporting file preserved');
 const calls=[],options={home,env:{PATH:process.env.PATH,...env},getHarness:async()=>({runnable:true,executable:'/fixture/opencode'}),command:async(_options,args)=>{calls.push(args);assert.deepEqual(args,['--version']);return 'opencode v2.2.6';}};
 const service=createPluginsService(options),prepare=async()=>{const preview=await service.previewSource(source);return service.prepare({previewId:preview.previewId,prefix:'',provider:'opencode'});};
 const settle=async plan=>{const {jobId}=await service.apply(plan.planId);for(let i=0;i<200;i++){const job=service.job(jobId);if(job.state!=='running')return job;await new Promise(r=>setTimeout(r,5));}throw Error('job timeout');};
 const owned=async()=> (await service.list()).plugins.find(p=>p.owned);
 return{home,source,service,options,calls,prepare,settle,owned};
}

test('OpenCode detection is distinct from installer capability; preview executes nothing',async t=>{
 const f=await fixture(t),preview=await f.service.previewSource(f.source),row=preview.packages[0].providers.find(p=>p.id==='opencode');
 assert.equal(row.detected,true);assert.equal(row.compatible,true);assert.equal(row.experimental,true);assert.equal(f.calls.length,0);assert.equal(await fs.stat(path.join(f.home,'sentinel')).catch(()=>null),null);
 const plan=await f.prepare();assert.equal(plan.activation,'provider-reload');assert.equal(plan.hooks.length,0);assert.deepEqual(plan.components,[{type:'extensions',name:'opencode/module.ts'}]);assert.match(plan.effects.join(' '),/immediately.*running sessions/);
});

test('OpenCode install, disable, enable, disabled update, reconciliation and removal preserve full snapshots and native settings',async t=>{
 const f=await fixture(t),config=path.join(f.home,'.config/opencode/opencode.jsonc');await fs.mkdir(path.dirname(config),{recursive:true});const text='// keep comments and secret-bearing native settings\n{"unrelated":"keep", "plugins":["native-package"],}\n';await fs.writeFile(config,text);
 assert.equal((await f.settle(await f.prepare())).state,'succeeded');let row=await f.owned();assert.equal(row.enabled,true);assert.equal(row.stateCoverage,'discovery-links');assert.equal(row.status,'installed');const oldPath=row.path;
 const record=JSON.parse(await fs.readFile(path.join(f.home,'.t3/setup/plugins/installed.json'),'utf8')).records[0];assert.equal(await fs.readlink(record.link.path),path.join(row.path,'opencode/module.ts'));
 const restarted=createPluginsService(f.options);assert.equal((await restarted.list()).plugins.find(p=>p.owned).enabled,true);
 for(const enabled of [false,true,false]){assert.equal((await f.settle(await f.service.prepare({id:row.id,revision:row.revision,operation:'state',enabled}))).state,'succeeded');row=await f.owned();assert.equal(row.enabled,enabled);}
 await fs.writeFile(path.join(f.source,'scripts/helper.sh'),'new supporting source');
 assert.equal((await f.settle(await f.service.prepare({id:row.id,revision:row.revision,operation:'update'}))).state,'succeeded');row=await f.owned();assert.equal(row.enabled,false);assert.notEqual(row.path,oldPath);assert.equal(await fs.readFile(path.join(row.path,'scripts/helper.sh'),'utf8'),'new supporting source');
 assert.equal((await f.settle(await f.service.prepare({id:row.id,revision:row.revision,operation:'reconcile'}))).state,'succeeded');row=await f.owned();assert.equal(row.enabled,false);
 assert.equal((await f.settle(await f.service.prepare({id:row.id,revision:row.revision,operation:'remove'}))).state,'succeeded');assert.equal(await f.owned(),undefined);assert(await fs.stat(oldPath));assert.equal(await fs.readFile(config,'utf8'),text);assert.equal(await fs.stat(path.join(f.home,'sentinel')).catch(()=>null),null);
 assert(f.calls.every(args=>args.length===1&&args[0]==='--version'),'no native service, package manager or loader starts');
});

test('OpenCode enabled update atomically retargets only its own registration and keeps siblings',async t=>{
 const f=await fixture(t);assert.equal((await f.settle(await f.prepare())).state,'succeeded');let row=await f.owned();let record=JSON.parse(await fs.readFile(path.join(f.home,'.t3/setup/plugins/installed.json'),'utf8')).records[0];
 const sibling=path.join(path.dirname(record.link.path),'personal.ts');await fs.writeFile(sibling,'personal module');await fs.writeFile(path.join(f.source,'scripts/helper.sh'),'updated');
 assert.equal((await f.settle(await f.service.prepare({id:row.id,revision:row.revision,operation:'update'}))).state,'succeeded');row=await f.owned();assert.equal(row.enabled,true);assert.equal(await fs.readlink(record.link.path),path.join(row.path,'opencode/module.ts'));assert.equal(await fs.readFile(sibling,'utf8'),'personal module');
});

test('OpenCode refuses replacement links, files and changed discovery paths before mutations',async t=>{
 const f=await fixture(t);assert.equal((await f.settle(await f.prepare())).state,'succeeded');let row=await f.owned();const record=JSON.parse(await fs.readFile(path.join(f.home,'.t3/setup/plugins/installed.json'),'utf8')).records[0];
 const plan=await f.service.prepare({id:row.id,revision:row.revision,operation:'remove'});await fs.unlink(record.link.path);await fs.writeFile(record.link.path,'personal replacement');
 const result=await f.settle(plan);assert.equal(result.state,'failed');assert.match(result.error,/personal file/);assert.equal(await fs.readFile(record.link.path,'utf8'),'personal replacement');
 await assert.rejects(f.service.prepare({id:row.id,revision:row.revision,operation:'state',enabled:false}),{code:'conflict'});
 await fs.unlink(record.link.path);await fs.symlink('/tmp/not-owned.ts',record.link.path);await assert.rejects(f.service.prepare({id:row.id,revision:row.revision,operation:'remove'}),{code:'conflict'});
});

test('OpenCode binds JSONC/config revisions and blocks edited snapshots before enabling',async t=>{
 const f=await fixture(t),plan=await f.prepare(),config=path.join(f.home,'.config/opencode/opencode.jsonc');await fs.mkdir(path.dirname(config),{recursive:true});await fs.writeFile(config,'// external\n{}');
 assert.equal((await f.settle(plan)).state,'failed');assert.equal(await f.owned(),undefined);
 assert.equal((await f.settle(await f.prepare())).state,'succeeded');let row=await f.owned();assert.equal((await f.settle(await f.service.prepare({id:row.id,revision:row.revision,operation:'state',enabled:false}))).state,'succeeded');row=await f.owned();
 await fs.writeFile(path.join(row.path,'scripts/helper.sh'),'native edits');await assert.rejects(f.service.prepare({id:row.id,revision:row.revision,operation:'state',enabled:true}),{code:'conflict'});
});

test('OpenCode supports configured home roots and rejects unverified releases and ambiguous entrypoints',async t=>{
 const f=await fixture(t,{OPENCODE_CONFIG_DIR:'custom-opencode'});assert.equal((await f.settle(await f.prepare())).state,'succeeded');const record=JSON.parse(await fs.readFile(path.join(f.home,'.t3/setup/plugins/installed.json'),'utf8')).records[0];assert.equal(path.dirname(record.link.path),path.join(f.home,'custom-opencode/plugins'));
 const other=createPluginsService({...f.options,command:async()=> 'opencode v1.19.5'}),preview=await other.previewSource(f.source);await assert.rejects(other.prepare({previewId:preview.previewId,prefix:'',provider:'opencode'}),{code:'unsupported'});
 await fs.writeFile(path.join(f.source,'opencode/helper.ts'),'export const helper=1');const extra=await f.service.previewSource(f.source);assert.equal(extra.packages[0].providers.find(p=>p.id==='opencode').detected,true);assert.equal(extra.packages[0].providers.find(p=>p.id==='opencode').compatible,false);
});

test('OpenCode discovery ancestor replacement after review cannot redirect registration outside the home',async t=>{
 const f=await fixture(t),plan=await f.prepare();const outside=await fs.mkdtemp(path.join(os.tmpdir(),'t3-opencode-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
 await fs.symlink(outside,path.join(f.home,'.config'));
 const result=await f.settle(plan);assert.equal(result.state,'failed');assert.match(result.error,/discovery must resolve inside|directory moved/);assert.deepEqual(await fs.readdir(outside),[]);assert.equal(await f.owned(),undefined);
});

test('OpenCode reconciliation finishes an interrupted removal without resurrecting a disabled installation',async t=>{
 const f=await fixture(t);assert.equal((await f.settle(await f.prepare())).state,'succeeded');
 const file=path.join(f.home,'.t3/setup/plugins/installed.json'),registry=JSON.parse(await fs.readFile(file,'utf8')),record=registry.records[0];
 record.state='removing';await fs.writeFile(file,JSON.stringify(registry));await fs.unlink(record.link.path);
 const row=await f.owned();assert.equal(row.status,'removing');assert.equal(row.enabled,false);
 assert.equal((await f.settle(await f.service.prepare({id:row.id,revision:row.revision,operation:'reconcile'}))).state,'succeeded');assert.equal(await f.owned(),undefined);assert((await fs.stat(record.packageDir)).isDirectory(),'Snapshots remain retained.');
});

test('OpenCode reconciliation restores the exact previous reviewed snapshot when update interrupted before link replacement',async t=>{
 const f=await fixture(t);assert.equal((await f.settle(await f.prepare())).state,'succeeded');let row=await f.owned();
 const registry=path.join(f.home,'.t3/setup/plugins/installed.json'),old=JSON.parse(await fs.readFile(registry,'utf8')).records[0];await fs.writeFile(path.join(f.source,'scripts/helper.sh'),'incoming update');
 const failing=createPluginsService({...f.options,io:{...fs,rename:async(from,to)=>{if(to===old.link.path)throw Object.assign(Error('fixture interrupted link replacement'),{code:'EIO'});return fs.rename(from,to);}}});
 const plan=await failing.prepare({id:row.id,revision:row.revision,operation:'update'}),{jobId}=await failing.apply(plan.planId);
 for(let i=0;i<200&&failing.job(jobId).state==='running';i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(failing.job(jobId).state,'failed');assert.equal(failing.job(jobId).partial,true);
 row=await f.owned();assert.equal(row.status,'installing');assert.equal(row.enabled,null);
 const reconcile=await f.service.prepare({id:row.id,revision:row.revision,operation:'reconcile'});assert.match(reconcile.effects[0],/previous reviewed snapshot/);assert.equal(reconcile.digest,old.digest);assert.equal((await f.settle(reconcile)).state,'succeeded');
 row=await f.owned();assert.equal(row.status,'installed');assert.equal(row.enabled,true);assert.equal(row.digest,old.digest);assert.equal(row.path,old.packageDir);assert.equal(await fs.readlink(old.link.path),old.link.target);
 const restored=JSON.parse(await fs.readFile(registry,'utf8')).records[0];assert.equal(restored.previousRecord,undefined);
});

test('OpenCode reconciliation verifies the new snapshot when tracking save interrupted after link replacement',async t=>{
 const f=await fixture(t);assert.equal((await f.settle(await f.prepare())).state,'succeeded');let row=await f.owned();
 const registry=path.join(f.home,'.t3/setup/plugins/installed.json'),old=JSON.parse(await fs.readFile(registry,'utf8')).records[0];await fs.writeFile(path.join(f.source,'scripts/helper.sh'),'incoming update after publication');
 let published=false;const failing=createPluginsService({...f.options,io:{...fs,rename:async(from,to)=>{if(published&&to===registry)throw Object.assign(Error('fixture interrupted tracking save'),{code:'EIO'});const result=await fs.rename(from,to);if(to===old.link.path)published=true;return result;}}});
 const plan=await failing.prepare({id:row.id,revision:row.revision,operation:'update'}),{jobId}=await failing.apply(plan.planId);
 for(let i=0;i<200&&failing.job(jobId).state==='running';i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(failing.job(jobId).state,'failed');assert.equal(published,true);
 row=await f.owned();assert.equal(row.status,'installing');assert.equal(row.enabled,true);assert.notEqual(row.digest,old.digest);
 assert.equal((await f.settle(await f.service.prepare({id:row.id,revision:row.revision,operation:'reconcile'}))).state,'succeeded');
 row=await f.owned();assert.equal(row.status,'installed');assert.equal(row.enabled,true);assert.notEqual(row.digest,old.digest);assert.equal(await fs.readlink(old.link.path),path.join(row.path,'opencode/module.ts'));assert.equal(await fs.readFile(path.join(row.path,'scripts/helper.sh'),'utf8'),'incoming update after publication');
 assert.equal(JSON.parse(await fs.readFile(registry,'utf8')).records[0].previousRecord,undefined);
});
