#!/usr/bin/env node
// Optional real-runtime verification. Loads TokenEconomizer with TE_DISABLE=1
// in a private disposable home; never creates a session or makes a model call.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createPluginsService} from '../docker/setup/plugins.mjs';
import {readPluginSource} from '../docker/setup/plugins/sources.mjs';
import {withNativeProcess} from '../docker/harness/native-process.mjs';

const executable=process.env.T3_PLUGIN_OPENCODE_BINARY;
assert(executable&&path.isAbsolute(executable),'Set T3_PLUGIN_OPENCODE_BINARY to the absolute managed OpenCode executable.');
const input=process.argv[2]||'https://github.com/microsoft/TokenEconomizer';
const home=await fs.mkdtemp(path.join(os.tmpdir(),'t3-plugin-opencode-smoke-'));
const source=path.join(home,'source');
try{
  const snapshot=await readPluginSource(input,{home,provider:'all'});
  const pkg=snapshot.packages.find(pkg=>pkg.prefix==='plugin/'&&pkg.variants?.opencode)||snapshot.packages.find(pkg=>pkg.variants?.opencode);
  assert(pkg,'The source must contain an OpenCode integration.');
  assert.equal(pkg.name,'tokeneconomizer','This native smoke checks TokenEconomizer, whose TE_DISABLE=1 contract prevents bootstrap and side calls.');
  for(const file of pkg.files){const target=path.join(source,file.name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,file.data,{mode:file.mode});}
  const service=createPluginsService({home,env:{PATH:process.env.PATH},getHarness:async()=>({runnable:true,executable})});
  const owned=async()=> (await service.list()).plugins.find(plugin=>plugin.owned);
  const settle=async plan=>{
    assert(plan.canApply,plan.blocked.join(' '));
    const{jobId}=await service.apply(plan.planId);
    for(let i=0;i<500;i++){
      const job=service.job(jobId);
      if(job.state!=='running'){assert.equal(job.state,'succeeded',job.error);console.log(plan.operation+' passed');return;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw Error('The Setup plugin operation did not settle.');
  };
  const nativeStatus=async expected=>{
    const password=randomBytes(24).toString('hex');
    const env={PATH:process.env.PATH,HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share'),XDG_CACHE_HOME:path.join(home,'.cache'),XDG_STATE_HOME:path.join(home,'.local/state'),OPENCODE_PASSWORD:password,OPENCODE_USERNAME:'opencode',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_CONFIG_PROJECT_DISABLE:'1',OPENCODE_DISABLE_PROJECT_CONFIG:'1',TE_DISABLE:'1'};
    await withNativeProcess({executable,home,env,timeoutMs:30000},['serve','--stdio','--hostname','127.0.0.1','--port','0'],async({nextLine,signal})=>{
      const ready=JSON.parse(await nextLine()),url=new URL(ready.url);
      assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');
      for(let i=0;i<100;i++){
        const response=await fetch(new URL('/api/plugin',url),{signal,redirect:'error',headers:{authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64')}});
        assert(response.ok,'The private native plugin API must respond successfully.');
        const reader=response.body.getReader(),chunks=[];let bytes=0;
        try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;assert(bytes<=4*1024*1024,'Native inventory exceeds 4MiB');chunks.push(next.value);}}finally{await reader.cancel();}
        const inventory=JSON.parse(Buffer.concat(chunks).toString('utf8'));assert(Array.isArray(inventory.data));
        const plugin=inventory.data.find(row=>row.id==='tokeneconomizer');
        if(expected&&plugin?.state?.status==='active'){console.log('Native TokenEconomizer activation verified');return;}
        if(!expected&&!plugin&&inventory.data.some(row=>row.id==='opencode.config.skill'&&row.state?.status==='active')){console.log('Native TokenEconomizer absence verified');return;}
        assert.notEqual(plugin?.state?.status,'failed','TokenEconomizer failed native activation.');
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw Error('The private native plugin status did not settle.');
    });
  };
  const preview=await service.previewSource(source),candidate=preview.packages.find(pkg=>pkg.providers.find(provider=>provider.id==='opencode')?.compatible);
  assert(candidate,'The source must expose an installable OpenCode module.');
  const plan=await service.prepare({previewId:preview.previewId,prefix:candidate.prefix,provider:'opencode'});
  assert.equal(plan.files.length,pkg.files.length,'The complete source snapshot is preserved.');assert.equal(plan.hooks.length,0,'Unused Claude hooks are not reported as OpenCode hooks.');
  await settle(plan);
  let row=await owned();assert(row);assert.equal(row.enabled,true);assert.equal(row.stateCoverage,'discovery-links');
  const registry=JSON.parse(await fs.readFile(path.join(home,'.t3/setup/plugins/installed.json'),'utf8')),record=registry.records[0];
  assert.equal(await fs.realpath(record.link.path),path.join(row.path,record.link.entrypoint));
  assert((await fs.stat(path.resolve(path.dirname(await fs.realpath(record.link.path)),'../scripts/te-hook'))).isFile(),'Relative runtime scripts remain beside the module.');
  await nativeStatus(true);
  for(const enabled of [false,true,false]){await settle(await service.prepare({id:row.id,revision:row.revision,operation:'state',enabled}));row=await owned();assert.equal(row.enabled,enabled);}
  await nativeStatus(false);
  await fs.writeFile(path.join(source,'setup-smoke-update.txt'),'Disposable snapshot update verification.\n');
  const previous=row.path;await settle(await service.prepare({id:row.id,revision:row.revision,operation:'update'}));row=await owned();assert.equal(row.enabled,false);assert.notEqual(row.path,previous);
  await settle(await service.prepare({id:row.id,revision:row.revision,operation:'state',enabled:true}));row=await owned();await nativeStatus(true);
  await settle(await service.prepare({id:row.id,revision:row.revision,operation:'remove'}));assert.equal(await owned(),undefined);assert.equal(await fs.lstat(record.link.path).catch(()=>null),null);await nativeStatus(false);
  assert.equal(await fs.stat(path.join(home,'.tokeneconomizer')).catch(()=>null),null,'TE_DISABLE prevented TokenEconomizer bootstrap.');
  console.log('OpenCode native plugin lifecycle passed; '+pkg.files.length+' source files, no sessions or model calls.');
}finally{await fs.rm(home,{recursive:true,force:true});}
