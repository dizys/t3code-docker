import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readPluginSource,selectPluginProvider} from '../docker/setup/plugins/sources.mjs';

async function fixture(t){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'t3-plugin-formats-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const put=async(name,value)=>{const file=path.join(home,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,typeof value==='object'?JSON.stringify(value):value);};
 return {home,put};
}
const manifest={name:'complete-plugin',version:'1.0.0'};

test('one source package retains all native formats and an experimental OpenCode module without executing it',async t=>{
 const f=await fixture(t);
 for(const provider of ['codex','claude','cursor','antigravity'])await f.put(`plugin/.${provider}-plugin/plugin.json`,manifest);
 await f.put('plugin/package.json',{...manifest,pi:{extensions:['./pi/extension.ts']}});
 await f.put('plugin/pi/extension.ts','throw Error("must not execute")');
 await f.put('plugin/opencode/complete-plugin.ts','throw Error("must not execute")');
 await f.put('plugin/scripts/support.py','# supporting files must remain in the snapshot');
 const source=await readPluginSource(f.home,{home:f.home,provider:'all'});
 assert.equal(source.packages.length,1);const pkg=source.packages[0];
 assert.equal(pkg.prefix,'plugin/');assert.deepEqual(Object.keys(pkg.variants).sort(),['antigravity','claude','codex','cursor','grok','opencode','pi']);
 const opencode=selectPluginProvider(pkg,'opencode');assert.equal(opencode.format,'local-module');assert.deepEqual(opencode.entrypoints,['opencode/complete-plugin.ts']);assert.equal(opencode.experimental,true);assert(opencode.files.some(f=>f.name==='scripts/support.py'));
 assert.equal(pkg.variants.grok.format,'claude-compatible');assert(pkg.variants.cursor.experimental);assert(pkg.variants.antigravity.experimental);
 await assert.rejects(async()=>selectPluginProvider(pkg,'muse'),{code:'unsupported'});
});

test('OpenCode-only conventional modules are discoverable without a JSON manifest',async t=>{
 const f=await fixture(t);await f.put('.opencode/plugins/example.ts','export default {setup(){throw Error("must not execute")}}');
 const result=await readPluginSource(f.home,{home:f.home,provider:'all'});
 assert.equal(result.packages.length,1);assert.equal(result.packages[0].name,'example');assert.deepEqual(result.packages[0].variants.opencode.entrypoints,['.opencode/plugins/example.ts']);
});

test('OpenCode SDK package metadata is detected, with dependencies blocked and no fabricated module registration',async t=>{
 const f=await fixture(t);await f.put('package.json',{name:'@example/opencode-plugin',version:'1.0.0',exports:{'.':'./src/index.ts'},dependencies:{'@opencode/plugin':'latest'}});
 await f.put('src/index.ts','throw Error("must not execute")');
 const source=await readPluginSource(f.home,{home:f.home,provider:'all'});const pkg=source.packages[0];
 assert.equal(pkg.variants.opencode.format,'npm-package');assert.deepEqual(pkg.variants.opencode.entrypoints,[]);assert(pkg.blocked.some(reason=>/dependencies/.test(reason)));
});

test('README support claims and generic TypeScript helpers do not fabricate native integrations',async t=>{
 const f=await fixture(t);await f.put('.codex-plugin/plugin.json',manifest);await f.put('README.md','Supports OpenCode, Cursor and Antigravity');await f.put('src/opencode-helper.ts','throw Error("not a plugin")');
 const result=await readPluginSource(f.home,{home:f.home,provider:'all'});assert.deepEqual(Object.keys(result.packages[0].variants),['codex']);
});

test('OpenCode module snapshots keep runtime scripts/dependency gates even without other manifests',async t=>{
 const f=await fixture(t);await f.put('opencode/module.js','throw Error("must not execute")');await f.put('package.json',{name:'ordinary-package',scripts:{postinstall:'touch sentinel'}});
 const result=await readPluginSource(f.home,{home:f.home,provider:'all'});assert.equal(result.packages[0].variants.opencode.format,'local-module');assert(result.packages[0].blocked.some(reason=>/scripts/.test(reason)));
});

// Legacy npm plugins declare main rather than exports (e.g. @franlol/opencode-md-table-formatter).
test('legacy OpenCode SDK main entries are detected but ordinary npm modules are not plugins',async t=>{
 const f=await fixture(t);await f.put('package.json',{name:'@franlol/opencode-md-table-formatter',version:'0.0.6',main:'index.ts',peerDependencies:{'@opencode-ai/plugin':'>=0.13.7'}});
 await f.put('index.ts','throw Error("preview must not execute")');
 const source=await readPluginSource(f.home,{home:f.home,provider:'all'});assert.equal(source.packages[0].variants.opencode.format,'npm-package');assert.deepEqual(source.packages[0].variants.opencode.entrypoints,[]);
 await f.put('package.json',{name:'ordinary-npm-module',main:'index.ts'});
 await assert.rejects(readPluginSource(f.home,{home:f.home,provider:'all'}),{code:'missing'});
});

test('Pi package with explicit resources can carry main metadata for another host',async t=>{
 const f=await fixture(t);await f.put('package.json',{name:'superpowers',version:'7.0.2',type:'module',main:'.opencode/plugins/superpowers.js',pi:{extensions:['./.pi/extensions/superpowers.ts'],skills:['./skills']}});
 await f.put('.pi/extensions/superpowers.ts','throw Error("must not execute")');await f.put('.opencode/plugins/superpowers.js','throw Error("must not execute")');await f.put('skills/example/SKILL.md','example');
 const source=await readPluginSource(f.home,{home:f.home,provider:'all'});assert.deepEqual(source.packages[0].variants.pi.blocked,[]);
});
