// Native regression for persistent, unselected Node shims. No downloads or
// changes to the real home, selections, credentials or running agents.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

assert.notEqual(process.getuid?.(),0,'Run the runtime regression as the unprivileged container user');
const home=await fs.mkdtemp(path.join(os.tmpdir(),'t3-node-runtime-'));
try {
  const data=path.join(home,'data'),config=path.join(home,'config'),shims=path.join(data,'shims'),project=path.join(home,'project');
  const mise=process.env.T3_MISE_BIN||'/usr/local/bin/mise';
  const prefix=process.env.T3_NODE_RUNTIME_BIN||'/usr/local/lib/t3-node-runtime';
  for(const dir of [shims,config,project])await fs.mkdir(dir,{recursive:true});
  for(const name of ['node','npm','npx'])await fs.symlink(mise,path.join(shims,name));
  // Native mise accepts these local fixture installs without downloads. They
  // behave like the persisted Node installation that caused the regression.
  for(const version of ['99.0.0','99.1.0']) {
    const bin=path.join(data,'installs/node',version,'bin');await fs.mkdir(bin,{recursive:true});
    await fs.writeFile(path.join(bin,'node'),`#!/bin/sh\nif [ "$1" = --version ]; then printf 'v${version}\\n'; else exec '${process.execPath.replaceAll("'","'\\''")}' "$@"; fi\n`,{mode:0o755});
  }
  const env={...process.env,HOME:home,MISE_CONFIG_DIR:config,MISE_DATA_DIR:data,MISE_STATE_DIR:path.join(home,'state'),MISE_CACHE_DIR:path.join(home,'cache'),MISE_AUTO_INSTALL:'false',MISE_NOT_FOUND_SYSTEM_FALLBACK:'false',MISE_TRUSTED_CONFIG_PATHS:home};
  // Ignore selectors inherited from a developer's shell. This test owns every
  // config and later supplies its own global/project selections.
  for(const key of ['MISE_NODE_VERSION','MISE_NPM_VERSION','MISE_GLOBAL_CONFIG_FILE','MISE_CONFIG_FILE','MISE_ENV','MISE_DISABLE_TOOLS'])delete env[key];
  const imagePath=process.env.PATH.split(path.delimiter).filter(dir=>dir!==prefix&&!dir.includes('/mise/')&&!dir.includes('/t3-harness/bin')).join(path.delimiter);
  const rawEnv={...env,PATH:shims+path.delimiter+imagePath};
  const raw=spawnSync('node',['--version'],{cwd:home,env:rawEnv,encoding:'utf8',timeout:15_000});
  assert.notEqual(raw.status,0,'The fixture must reproduce a broken ambient Node shim');
  env.PATH=prefix+path.delimiter+rawEnv.PATH;
  const run=(command,args,cwd=home)=>spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:20_000});
  const node=run('node',['--version']);assert.equal(node.status,0,node.stderr);assert.equal(node.stdout.trim(),process.version);
  for(const command of ['npm','npx']){const result=run(command,['--version']);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/^\d+\.\d+\.\d+/);}

  const agent=path.join(home,'pi-fixture');
  await fs.writeFile(agent,'#!/usr/bin/env node\nconsole.log("1.5.2");\n',{mode:0o755});
  const harnessRoot=process.env.T3_HARNESS_SOURCE||'/opt/t3-harness';
  const {probeVersion}=await import(pathToFileURL(path.join(harnessRoot,'probe.mjs')));
  const {createRunner}=await import(pathToFileURL(path.join(harnessRoot,'io.mjs')));
  const checked=await probeVersion({env,home,run:createRunner(),timeouts:{probe:20_000}},{versionArgs:['--version'],versionPattern:'(\\d+\\.\\d+\\.\\d+)'},agent);
  assert.equal(checked.ok,true,checked.error);assert.equal(checked.version,'1.5.2');
  const {launcherScript}=await import(pathToFileURL(path.join(process.env.T3_PROVIDER_SOURCE||'/opt/t3-provider','launchers.mjs')));
  const launcher=path.join(home,'pi-launcher');
  await fs.writeFile(launcher,launcherScript({id:'pi',name:'Pi',executable:agent,harnessCli:'/must-not-update'}),{mode:0o755});
  const launched=run(launcher,['--version']);assert.equal(launched.status,0,launched.stderr);assert.equal(launched.stdout.trim(),'1.5.2');

  await fs.writeFile(path.join(config,'config.toml'),'[tools]\nnode = "99.0.0"\n');
  const selected=run('node',['--version']);assert.equal(selected.status,0,selected.stderr);assert.equal(selected.stdout.trim(),'v99.0.0');
  await fs.writeFile(path.join(project,'mise.toml'),'[tools]\nnode = "99.1.0"\n');
  const projectNode=run('node',['--version'],project);assert.equal(projectNode.status,0,projectNode.stderr);assert.equal(projectNode.stdout.trim(),'v99.1.0');
  await fs.writeFile(path.join(config,'config.toml'),'[tools]\nnode = "system"\n');
  const explicitSystem=run('node',['--version']);assert.equal(explicitSystem.status,0,explicitSystem.stderr);assert.equal(explicitSystem.stdout.trim(),process.version);

  // A missing declaration is an error, never permission to use image Node.
  await fs.writeFile(path.join(config,'config.toml'),'[tools]\nnode = "99.99.99"\n');
  const missingGlobal=run('node',['--version']);assert.equal(missingGlobal.error,undefined);assert.notEqual(missingGlobal.status,null);assert.notEqual(missingGlobal.status,0,'A missing global Node must not fall back');
  await fs.writeFile(path.join(config,'config.toml'),'');
  await fs.writeFile(path.join(project,'mise.toml'),'[tools]\nnode = "99.99.99"\n');
  const missingProject=run('node',['--version'],project);assert.equal(missingProject.error,undefined);assert.notEqual(missingProject.status,null);assert.notEqual(missingProject.status,0,'A missing project Node must not fall back');
  assert.equal((await fs.readFile(path.join(project,'mise.toml'),'utf8')),'[tools]\nnode = "99.99.99"\n');
  console.log(JSON.stringify({architecture:process.arch,staleShimsReproduced:true,imageNodeNpmNpxWork:true,piProbeAndLauncherWork:true,selectedGlobalAndProjectPinsHonored:true,explicitSystemWorks:true,missingGlobalAndProjectPinsPreserved:true}));
} finally { await fs.rm(home,{recursive:true,force:true}); }
