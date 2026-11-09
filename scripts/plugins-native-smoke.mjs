#!/usr/bin/env node
// Explicit native proof in a disposable home. Never uses the signed-in home.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createPluginsService} from '../docker/setup/plugins.mjs';
const executable=process.env.T3_PLUGIN_NATIVE_BINARY;
assert(executable&&path.isAbsolute(executable),'Set T3_PLUGIN_NATIVE_BINARY to the actual managed Codex executable, not a mise shim.');
const home=await fs.mkdtemp(path.join(os.tmpdir(),'t3-plugins-native-'));
const source=process.argv[2]||'https://github.com/microsoft/TokenEconomizer';
const service=createPluginsService({home,env:{PATH:process.env.PATH},getHarness:async()=>({runnable:true,executable})});
const settle=async plan=>{
 const {jobId}=await service.apply(plan.planId);
 for(let i=0;i<300;i++){
  const job=service.job(jobId);
  if(job.state!=='running'){assert.equal(job.state,'succeeded',JSON.stringify(job));return job;}
  await new Promise(r=>setTimeout(r,500));
 }
 throw Error('The native plugin job did not settle. Inspect '+home);
};
console.log('Disposable home:',home);
const preview=await service.previewSource(source);
const compatible=preview.packages.filter(pkg=>pkg.providers.some(provider=>provider.id==='codex'&&provider.compatible));
assert.equal(compatible.length,1,'choose a source with one Codex plugin for this smoke test');
const pkg=compatible[0];
const plan=await service.prepare({previewId:preview.previewId,prefix:pkg.prefix});
assert(plan.canApply,plan.blocked.join(' '));
assert(plan.files.some(f=>f.name==='.codex-plugin/plugin.json'));
await settle(plan);
let row=(await service.list()).plugins.find(p=>p.owned);
assert(row);assert.equal(row.status,'installed');assert.equal(row.enabled,true);assert(row.path,'native cache is independently found');
console.log('Installed:',row.nativeId,plan.files.length,'files;',plan.hooks.length,'reviewed hook commands');
for(const enabled of [false,true]){
 await settle(await service.prepare({id:row.id,revision:row.revision,operation:'state',enabled}));
 row=(await service.list()).plugins.find(p=>p.owned);assert.equal(row.enabled,enabled);
}
console.log('Disable/enable: passed');
const restarted=createPluginsService({home,env:{PATH:process.env.PATH},getHarness:async()=>({runnable:true,executable})});
assert((await restarted.list()).plugins.some(p=>p.id===row.id&&p.enabled));
await settle(await service.prepare({id:row.id,revision:row.revision,operation:'remove'}));
assert.equal((await service.list()).plugins.some(p=>p.owned),false);
console.log('Restart inventory and native removal: passed. No hooks were trusted or executed.');
// A controlled source change proves update behavior even when upstream has no new release.
const local=path.join(home,'update-source');
await fs.mkdir(path.join(local,'.codex-plugin'),{recursive:true});
await fs.writeFile(path.join(local,'.codex-plugin/plugin.json'),JSON.stringify({name:'setup-update-proof',version:'1.0.0'}));
await fs.mkdir(path.join(local,'skills/proof'),{recursive:true});
const skill=path.join(local,'skills/proof/SKILL.md');
await fs.writeFile(skill,'---\nname: proof\ndescription: Update fixture\n---\nBefore.\n');
const initial=await service.previewSource(local);
await settle(await service.prepare({previewId:initial.previewId,prefix:''}));
row=(await service.list()).plugins.find(p=>p.owned);
await settle(await service.prepare({id:row.id,revision:row.revision,operation:'state',enabled:false}));
row=(await service.list()).plugins.find(p=>p.owned);
await fs.writeFile(skill,'---\nname: proof\ndescription: Update fixture\n---\nAfter.\n');
const update=await service.prepare({id:row.id,revision:row.revision,operation:'update'});
assert.equal(update.changes.find(f=>f.name==='skills/proof/SKILL.md').status,'modified');
await settle(update);
row=(await service.list()).plugins.find(p=>p.owned);assert.equal(row.enabled,false,'update preserves disabled state');
assert.match(await fs.readFile(path.join(row.path,'skills/proof/SKILL.md'),'utf8'),/After\./);
await settle(await service.prepare({id:row.id,revision:row.revision,operation:'remove'}));
console.log('Native update, exact incoming files and disabled-state preservation: passed.');
