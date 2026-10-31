import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const context=vm.createContext({});vm.runInContext(await readFile(new URL('../docker/setup/client/code-text.js',import.meta.url),'utf8')+'\n'+await readFile(new URL('../docker/setup/client/files-model.js',import.meta.url),'utf8')+'\nglobalThis.F=T3FilesModel;',context);const F=context.F;

test('folder addresses round-trip spaces, unicode, hashes, percent and absolute locations',()=>{
 const roots={workspace:'/work space',home:'/users/someone'};
 for(const value of ['/work space/project/a # b/日本語%','/users/someone/.config/one','/opt/config','/']){
  assert.equal(F.address('#'+F.route(value,roots),roots).path,value);
 }
 assert.equal(F.address('#files/trash',roots).place,'trash');
 assert.equal(F.address('#files/projects/%zz',roots).path,null);
 assert.equal(F.normalize('/a/b/../../c'),'/'+'c');assert.equal(F.normalize('relative'),null);assert.equal(F.normalize('/bad\0path'),null);
});

test('masked previews keep labels but never secret values and tokens are bounded text',()=>{
 assert.equal(F.mask('API_TOKEN=private'),'API_TOKEN=••••••••');assert(!F.mask('-----BEGIN PRIVATE KEY-----').includes('PRIVATE'));
 for(const line of ['const config = "<img onerror=bad()>";','// comment','return true;',"'a\\'b'",'plain'])assert.equal(F.tokens(line).map(token=>token.text).join(''),line);
 const huge=F.tokens('const '.repeat(10000));assert(huge.length<260);assert(huge.map(token=>token.text).join('').length<=4002);
});

test('missing facts stay unknown and composition percentages never exceed their container',()=>{
 assert.equal(F.totalOf([{bytes:10},{bytes:null}]),null);assert.equal(F.proportion(null,10),0);assert.equal(F.proportion(100,10),100);
 assert.match(F.gitLine({available:false,loading:false}),/unavailable/);assert.notEqual(F.gitLine({available:false,loading:true}),'Clean');
 assert.equal(F.consequences({keys:true}).includes('private keys'),true);assert.equal(F.consequences({secret:true}).includes('secrets'),true);
});
