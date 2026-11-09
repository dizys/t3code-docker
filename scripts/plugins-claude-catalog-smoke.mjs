#!/usr/bin/env node
// Real official catalog packages, passive source detection and native user-scope
// lifecycle only. No agent session, plugin command, prompt or model call.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPluginsService,pluginCommand} from '../docker/setup/plugins.mjs';

const executable=process.env.T3_PLUGIN_CLAUDE_BINARY;
assert(executable&&path.isAbsolute(executable),'Set T3_PLUGIN_CLAUDE_BINARY to the absolute Claude Code executable.');
const reportPath=process.env.T3_PLUGIN_CLAUDE_REPORT||null;
const sources=process.argv.slice(2);
if(!sources.length)sources.push('https://github.com/anthropics/claude-plugins-official/tree/main/plugins/commit-commands','https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-review');
const home=await fs.mkdtemp(path.join(os.tmpdir(),'t3-plugin-claude-catalog-'));
const report={startedAt:new Date().toISOString(),binary:executable,scope:'user',disposableHome:home,homeRemoved:false,sessionStarted:false,pluginCommandsInvoked:false,modelCallsMade:false,plugins:[],limitations:['Detection reports manifests and Claude-compatible formats, not cross-agent runtime verification.','Native installation/setting/removal checks do not exercise plugin commands, code review, git actions or model behavior.','No upstream update is applied: source and installed versions are pinned by each reviewed snapshot.']};
const service=createPluginsService({home,env:{PATH:process.env.PATH},getHarness:async()=>({runnable:true,executable})});
const own=async id=>(await service.list()).plugins.find(plugin=>plugin.owned&&plugin.id===id);
const settle=async(plan,entry,operation)=>{
  if(!plan.canApply){entry.blocked=plan.blocked;entry.status='blocked';entry.operations.push({operation,status:'blocked',reasons:plan.blocked});return null;}
  const{jobId}=await service.apply(plan.planId),deadline=Date.now()+180000;
  while(Date.now()<deadline){
    const job=service.job(jobId);
    if(job.state!=='running'){
      entry.operations.push({operation,status:job.state,partial:Boolean(job.partial),error:job.error||null});
      assert.equal(job.state,'succeeded',job.error||'Native lifecycle operation failed.');
      console.log(entry.name+': '+operation+' passed');return job;
    }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error('The bounded native plugin operation did not settle.');
};
try{
  report.nativeVersion=(await pluginCommand({executable,home,env:{PATH:process.env.PATH}},['--version'])).trim();
  // Each repository is fetched as a frozen source; source review never starts Claude.
  for(const source of sources){
    const entry={source,status:'pending',operations:[]};report.plugins.push(entry);
    try{
      const preview=await service.previewSource(source);
      Object.assign(entry,{commit:preview.commit,packages:preview.packages.map(pkg=>({name:pkg.name,prefix:pkg.prefix,files:pkg.files.length,components:pkg.components,detected:pkg.providers.filter(provider=>provider.detected),blocked:pkg.blocked}))});
      const pkg=preview.packages.find(pkg=>pkg.providers.some(provider=>provider.id==='claude'&&provider.compatible));
      if(!pkg){entry.status='blocked';entry.blocked=['No Setup-compatible Claude package detected.'];continue;}
      Object.assign(entry,{name:pkg.name,prefix:pkg.prefix,files:pkg.files.length,detectedTargets:pkg.providers.filter(provider=>provider.detected).map(provider=>({id:provider.id,compatible:provider.compatible,experimental:provider.experimental,reason:provider.reason})),operations:[{operation:'preview',status:'succeeded'}]});
      const plan=await service.prepare({previewId:preview.previewId,prefix:pkg.prefix,provider:'claude'});
      Object.assign(entry,{version:plan.version,digest:plan.digest,reviewedHooks:plan.hooks.length,reviewedFiles:plan.files.length});
      if(!await settle(plan,entry,'install'))continue;
      const installed=(await service.list()).plugins.find(plugin=>plugin.owned&&plugin.provider==='claude'&&plugin.name===entry.name&&plugin.source===source);
      assert(installed,'The native installation must appear as Setup-owned.');assert.equal(installed.status,'installed');assert.equal(installed.enabled,true);
      entry.id=installed.id;entry.nativeId=installed.nativeId;entry.status='installed';entry.operations.push({operation:'list',status:'succeeded',enabled:installed.enabled});
    }catch(error){entry.status='failed';entry.error=String(error.message||error);console.log((entry.name||source)+': '+entry.error);}
  }
  const installed=report.plugins.filter(plugin=>plugin.status==='installed');
  report.coexistingOwned=(await service.list()).plugins.filter(plugin=>plugin.owned&&plugin.provider==='claude').map(plugin=>({name:plugin.name,nativeId:plugin.nativeId,enabled:plugin.enabled}));
  assert.equal(report.coexistingOwned.length,installed.length,'Each successful catalog install remains independently tracked.');
  for(const entry of installed){
    try{
      for(const enabled of [false,true]){
        const row=await own(entry.id);assert(row,'The owned installation remains discoverable.');
        if(!await settle(await service.prepare({id:row.id,revision:row.revision,operation:'state',enabled}),entry,enabled?'enable':'disable'))throw Error('Unexpected blocked state operation.');
        assert.equal((await own(entry.id)).enabled,enabled,'The native user setting must match the reviewed state.');
      }
      const row=await own(entry.id);
      if(!await settle(await service.prepare({id:row.id,revision:row.revision,operation:'remove'}),entry,'remove'))throw Error('Unexpected blocked removal.');
      assert.equal(await own(entry.id),undefined,'Removed packages must lose Setup ownership.');entry.status='passed';
    }catch(error){entry.status='failed';entry.error=String(error.message||error);console.log(entry.name+': '+entry.error);}
  }
  report.finalOwned=(await service.list()).plugins.filter(plugin=>plugin.owned).map(plugin=>({name:plugin.name,status:plugin.status}));
  report.passed=report.plugins.every(plugin=>plugin.status==='passed')&&report.finalOwned.length===0;
}finally{
  await fs.rm(home,{recursive:true,force:true});report.homeRemoved=true;report.finishedAt=new Date().toISOString();
  if(reportPath){assert(path.isAbsolute(reportPath),'T3_PLUGIN_CLAUDE_REPORT must be absolute.');await fs.mkdir(path.dirname(reportPath),{recursive:true});await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});}
}
console.log(JSON.stringify({passed:report.passed,plugins:report.plugins.map(plugin=>({name:plugin.name,source:plugin.source,commit:plugin.commit,status:plugin.status,detectedTargets:plugin.detectedTargets?.map(target=>target.id),operations:plugin.operations.map(operation=>operation.operation+':'+operation.status)})),reportPath},null,2));
if(!report.passed)process.exitCode=1;
