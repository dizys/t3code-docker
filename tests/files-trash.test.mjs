import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { filesFixture } from './lib/files-fixture.mjs';

test('Trash batches use the right place, preserve links and restore without overwriting',async t=>{
  const {home,workspace,trash}=await filesFixture(t),a=path.join(home,'notes.txt'),target=path.join(workspace,'outside');await fs.writeFile(a,'notes');await fs.writeFile(target,'kept');const link=path.join(home,'link');await fs.symlink(target,link);
  const moved=await trash.move({paths:[a,link]});assert.equal(moved.ids.length,2);const listing=await trash.list();assert.equal(listing.items.length,2);assert(listing.items.every(row=>row.batch===moved.undo));assert((await fs.readdir(path.join(home,'.t3/trash'))).length===2);assert.equal(await fs.readFile(target,'utf8'),'kept');
  await fs.writeFile(a,'newer');const restored=await trash.restore({undo:moved.undo});assert.equal(restored.restored.length,2);assert.equal(await fs.readFile(a,'utf8'),'newer');assert.equal(await fs.readFile(path.join(home,'notes (restored).txt'),'utf8'),'notes');assert((await fs.lstat(link)).isSymbolicLink());assert.equal((await trash.list()).items.length,0);
});

test('retention spares the Undo window and never removes foreign or replaced payloads',async t=>{
  let clock=Date.now();const f=await filesFixture(t,{now:()=>clock}),a=path.join(f.workspace,'a');await fs.writeFile(a,'old');const first=await f.trash.move({paths:[a]});clock+=8*86400_000;await fs.writeFile(a,'young');const young=await f.trash.move({paths:[a]});
  const root=path.join(f.workspace,'.t3-trash');await fs.mkdir(path.join(root,'foreign'));await fs.writeFile(path.join(root,'foreign/keep'),'foreign');
  await f.trash.retention();assert.deepEqual((await f.trash.list()).items.map(row=>row.id),young.ids);assert.equal(await fs.readFile(path.join(root,'foreign/keep'),'utf8'),'foreign');
  const dir=path.join(root,young.ids[0]);await fs.unlink(path.join(dir,'item'));await fs.writeFile(path.join(dir,'item'),'replacement');
  await assert.rejects(f.trash.restore({ids:young.ids}),{code:'stale'});assert.equal(await fs.readFile(path.join(dir,'item'),'utf8'),'replacement');assert.equal(first.ids.length,1);
});

test('emptying Trash needs confirmation and deletes only the explicitly selected identities',async t=>{
  const {workspace,trash}=await filesFixture(t),a=path.join(workspace,'a'),b=path.join(workspace,'b');await fs.writeFile(a,'a');await fs.writeFile(b,'b');const first=await trash.move({paths:[a]}),second=await trash.move({paths:[b]});
  await assert.rejects(trash.empty({ids:first.ids}),{code:'conflicts'});await trash.empty({ids:first.ids,confirmed:true});assert.deepEqual((await trash.list()).items.map(row=>row.id),second.ids);
});

test('workspace Trash refuses to append through an exclude link',async t=>{
  const f=await filesFixture(t);
  await fs.mkdir(path.join(f.workspace,'.git','info'),{recursive:true});
  const victim=path.join(f.root,'victim');await fs.writeFile(victim,'precious');
  await fs.symlink(victim,path.join(f.workspace,'.git','info','exclude'));
  const target=path.join(f.workspace,'a');await fs.writeFile(target,'a');
  await assert.rejects(f.trash.move({paths:[target]}),{code:'invalid'});
  assert.equal(await fs.readFile(victim,'utf8'),'precious');assert.equal(await fs.readFile(target,'utf8'),'a');
});

test('workspace Trash records its ignore line in a regular exclude file',async t=>{
  const f=await filesFixture(t);
  await fs.mkdir(path.join(f.workspace,'.git','info'),{recursive:true});
  await fs.writeFile(path.join(f.workspace,'.git','info','exclude'),'*.log\n');
  const target=path.join(f.workspace,'a');await fs.writeFile(target,'a');
  const moved=await f.trash.move({paths:[target]});assert.equal(moved.ids.length,1);
  assert.equal(await fs.readFile(path.join(f.workspace,'.git','info','exclude'),'utf8'),'*.log\n.t3-trash/\n');
});
