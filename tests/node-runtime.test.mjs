import assert from 'node:assert/strict';
import test from 'node:test';
import {nodeRuntimeMode} from '../docker/harness/node-runtime.mjs';

const answer=(listing)=>async()=>({code:0,stdout:JSON.stringify(listing),stderr:''});
const mode=(listing,command='node')=>nodeRuntimeMode({command,run:answer(listing)});

test('image Node remains the default with no selection, including unselected installations',async()=>{
  for(const command of ['node','npm','npx']) {
    assert.equal(await mode({},command),'system');
    assert.equal(await mode([],command),'system');
    assert.equal(await mode([{version:'26.13.0',installed:true,active:false}],command),'system');
    assert.equal(await mode({node:[{version:'26.13.0',installed:true,active:false}]},command),'system');
  }
});

test('global, project, environment and missing runtime selections stay with mise',async()=>{
  for(const type of ['mise.toml','.nvmrc','env'])for(const installed of [true,false])for(const command of ['node','npm','npx']) {
    const entry={version:'22.0.0',requested_version:'22',installed,source:{type,path:'/fixture'}};
    for(const listing of [[entry],{node:[entry]}])assert.equal(await mode(listing,command),'mise');
  }
});

test('npm and npx honor an independently selected npm release',async()=>{
  const listing={node:[{version:'26.13.0',installed:true}],npm:[{version:'11.0.0',source:{type:'mise.toml'}}]};
  for(const command of ['npm','npx'])assert.equal(await mode(listing,command),'mise');
});

test('an explicit system selector never recurses through mise exec',async()=>{
  for(const command of ['node','npm','npx'])for(const selector of [{version:'system'},{version:'24.0.0',requested_version:'system'}]) {
    assert.equal(await mode({node:[{version:'26.13.0',installed:true},{...selector,source:{type:'mise.toml'}}]},command),'system');
  }
});

test('runtime discovery is read-only, checks the actual working directory, and keeps the caller environment',async()=>{
  const env={HOME:'/fixture/home',PATH:'/fixture/bin',MISE_AUTO_INSTALL:'true',MISE_NOT_FOUND_SYSTEM_FALLBACK:'true',T3_MISE_BIN:'/image/mise'};
  const before={...env};
  assert.equal(await nodeRuntimeMode({command:'npx',env,cwd:'/fixture/project',run:async(argv,options)=>{
    assert.deepEqual(argv,['/image/mise','-C','/fixture/project','ls','--json','node','npm']);
    assert.equal(options.cwd,'/fixture/project');assert.equal(options.env.MISE_AUTO_INSTALL,'false');assert.equal(options.env.MISE_NOT_FOUND_SYSTEM_FALLBACK,'false');assert.equal(options.env.PATH,env.PATH);
    return {code:0,stdout:'{}',stderr:''};
  }}),'system');
  assert.deepEqual(env,before);
});

test('unavailable or corrupt configuration never silently replaces a declared runtime',async()=>{
  for(const result of [{code:1,stdout:''},{code:0,error:'timeout',stdout:'{}'},...['','invalid','null','[null]','{"node":{}}','{"node":[null]}'].map(stdout=>({code:0,stdout}))]) {
    await assert.rejects(nodeRuntimeMode({command:'node',run:async()=>result}));
  }
  await assert.rejects(nodeRuntimeMode({command:'python',run:answer({})}),/Unknown/);
});
