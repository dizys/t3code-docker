import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { filesFixture } from './lib/files-fixture.mjs';
import { createUploads,CHUNK_BYTES } from '../docker/setup/files/uploads.mjs';

const item=(name='folder/file.txt',size=5)=>({path:name,size,lastModified:1700000000000});
test('uploads resume from persisted offsets and publish only complete files',async t=>{
  const f=await filesFixture(t),first=await f.uploads.start({dest:f.workspace,items:[item()]}),id=first.uploads[0].id;
  await f.uploads.chunk({id,offset:0},Buffer.from('hel'));assert.equal(await fs.stat(path.join(f.workspace,'folder/file.txt')).then(()=>true,()=>false),false);
  const recovered=createUploads({policy:f.policy,guard:f.guard,trash:f.trash});
  const again=await recovered.start({dest:f.workspace,items:[item()]});assert.equal(again.uploads[0].id,id);assert.equal(again.uploads[0].received,3);
  await assert.rejects(recovered.chunk({id,offset:0},Buffer.from('hello')),error=>error.code==='changed'&&error.fields.received===3);
  await assert.rejects(recovered.finish({id}),{code:'changed'});await recovered.chunk({id,offset:3},Buffer.from('lo'));
  const finish=await recovered.finish({id}),repeated=await recovered.finish({id});assert.deepEqual(repeated,finish);assert.equal(await fs.readFile(finish.path,'utf8'),'hello');assert.equal((await fs.readdir(path.dirname(finish.path))).some(name=>name.startsWith('.t3-upload-')),false);
  const state=await fs.stat(path.join(f.policy.stateDir,'files/uploads/'+id+'.json'));assert.equal(state.mode&0o777,0o600);
  // The finished upload is complete on disk; drop this instance's stale handle too.
  await f.uploads.cancel({ids:[id]});
});

test('upload replacements retain previous data and stale conflicts never overwrite newer contents',async t=>{
  const f=await filesFixture(t),target=path.join(f.workspace,'file.txt');await fs.writeFile(target,'old');
  const start=await f.uploads.start({dest:f.workspace,items:[item('file.txt',3)]}),id=start.uploads[0].id,revision=start.uploads[0].conflict.existing.revision;
  await f.uploads.chunk({id,offset:0},Buffer.from('new'));await assert.rejects(f.uploads.finish({id}),{code:'conflicts'});
  await fs.writeFile(target,'outside');await assert.rejects(f.uploads.finish({id,onConflict:'replace',existingRevision:revision}),{code:'stale'});assert.equal(await fs.readFile(target,'utf8'),'outside');
  const result=await f.uploads.finish({id,onConflict:'keep-both'});assert.match(result.path,/file \(2\)\.txt$/);assert.equal(await fs.readFile(target,'utf8'),'outside');
  const next=await f.uploads.start({dest:f.workspace,items:[item('file.txt',3)]}),second=next.uploads[0];await f.uploads.chunk({id:second.id,offset:0},Buffer.from('new'));const replaced=await f.uploads.finish({id:second.id,onConflict:'replace',existingRevision:second.conflict.existing.revision});assert.ok(replaced.replaced);assert.equal(await fs.readFile(target,'utf8'),'new');assert.equal((await f.trash.list()).items.length,1);
});

test('cancel and stale-session cleanup remove only their own staging inode',async t=>{
  let clock=Date.now();const f=await filesFixture(t,{now:()=>clock}),target=path.join(f.workspace,'keep');await fs.writeFile(target,'original');
  const result=await f.uploads.start({dest:f.workspace,items:[item('keep',3)]}),id=result.uploads[0].id;await f.uploads.chunk({id,offset:0},Buffer.from('new'));await f.uploads.cancel({ids:[id]});assert.equal(await fs.readFile(target,'utf8'),'original');
  const next=await f.uploads.start({dest:f.workspace,items:[item('late',3)]});clock+=25*3600_000;await f.uploads.prune();assert.equal(f.uploads.list().length,0);assert.equal((await fs.readdir(f.workspace)).some(name=>name.includes(next.uploads[0].id)),false);
});

test('space, path, chunk and parent identity checks fail before publishing',async t=>{
  const f=await filesFixture(t),low=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs:async()=>({bavail:1024**3,bsize:1})});
  await assert.rejects(low.start({dest:f.workspace,items:[item()]}),error=>error.code==='no-space'&&error.fields.requiredBytes===5);
  for(const name of ['../outside','/root/file','a//b','a/../b'])await assert.rejects(f.uploads.start({dest:f.workspace,items:[item(name)]}),{code:'invalid'});
  const result=await f.uploads.start({dest:f.workspace,items:[item('file.txt',CHUNK_BYTES+1)]}),id=result.uploads[0].id;await assert.rejects(f.uploads.chunk({id,offset:0},Buffer.alloc(CHUNK_BYTES+1)),{code:'too-large'});
  await assert.rejects(f.uploads.chunk({id,offset:null},Buffer.alloc(1)),{code:'invalid'});
  await f.uploads.cancel({ids:[id]});
  const linked=path.join(f.workspace,'link');await fs.symlink(f.home,linked);await assert.rejects(f.uploads.start({dest:f.workspace,items:[item('link/file')]}),{code:'locked'});
});

test('empty directories, restored transfer facts and fresh replacement revisions are preserved',async t=>{
  const f=await filesFixture(t);const empty=await f.uploads.start({dest:f.workspace,items:[{path:'empty/nested',directory:true}]});assert.equal(empty.uploads[0].directory,true);assert((await fs.stat(path.join(f.workspace,'empty/nested'))).isDirectory());
  const result=await f.uploads.start({dest:f.workspace,items:[item('later',3)]}),id=result.uploads[0].id;await f.uploads.chunk({id,offset:0},Buffer.from('new'));let jobs=await f.uploads.jobs();assert.equal(jobs[0].received,3);assert.equal(jobs[0].state,'waiting');
  await fs.writeFile(path.join(f.workspace,'later'),'outside');await assert.rejects(f.uploads.finish({id,onConflict:'replace'}),{code:'stale'});assert.equal(await fs.readFile(path.join(f.workspace,'later'),'utf8'),'outside');
  await f.uploads.finish({id,onConflict:'keep-both'});jobs=await f.uploads.jobs();assert.equal(jobs[0].state,'done');assert.match(jobs[0].result.path,/later \(2\)$/);
  const recovered=createUploads({policy:f.policy,guard:f.guard,trash:f.trash});assert.equal((await recovered.jobs())[0].result.path,jobs[0].result.path);
});

test('concurrent uploads across instances share one reserve',async t=>{
  const f=await filesFixture(t),free=1024**3+10*1024*1024,statfs=async()=>({bavail:free,bsize:1});
  const a=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs}),b=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs});
  await b.jobs();
  const first=await a.start({dest:f.workspace,items:[item('a.bin',8*1024*1024)]}),id=first.uploads[0].id;
  // b warmed its view of the staging dir before a's upload landed, so its own
  // rows see nothing. The shared reserve still accounts for the 8 MiB already
  // promised, so this start must lose.
  await assert.rejects(b.start({dest:f.workspace,items:[item('b.bin',8*1024*1024)]}),{code:'no-space'});
  await a.chunk({id,offset:0},Buffer.alloc(8*1024*1024));
  const done=await a.finish({id});assert.ok(done.path);
  // Finishing releases the reservation, so the same upload fits afterwards.
  const c=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs});
  const second=await c.start({dest:f.workspace,items:[item('b.bin',8*1024*1024)]});await c.cancel({ids:second.uploads.map(row=>row.id)});
});

test('simultaneous starts across instances cannot promise the same free space',async t=>{
  const f=await filesFixture(t),statfs=async()=>({bavail:1024**3+10*1024*1024,bsize:1});
  const instances=[0,1].map(()=>createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs}));
  await Promise.all(instances.map(uploads=>uploads.ready()));
  const results=await Promise.allSettled(instances.map((uploads,index)=>uploads.start({dest:f.workspace,items:[item('race-'+index+'.bin',8*1024*1024)]})));
  for(const [index,result]of results.entries())if(result.status==='fulfilled')await instances[index].cancel({ids:result.value.uploads.map(row=>row.id)});
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1,'only one 8 MiB upload fits in 10 MiB of headroom');
  assert.equal(results.find(row=>row.status==='rejected')?.reason.code,'no-space');
});

test('restarted uploads restore remaining-byte reservations without double-counting',async t=>{
  const f=await filesFixture(t),free=1024**3+10*1024*1024,statfs=async()=>({bavail:free,bsize:1});
  const a=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs});
  const first=await a.start({dest:f.workspace,items:[item('a.bin',8*1024*1024)]}),id=first.uploads[0].id;
  await a.chunk({id,offset:0},Buffer.alloc(1024*1024));
  // Simulate a restart: new instances recover the 7 MiB still missing from disk.
  const b=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs}),c=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs});
  await b.jobs();await c.jobs();
  // 7 MiB promised plus 4 MiB wanted exceeds the 10 MiB headroom, while 3 MiB
  // exactly fits. The duplicate recovery must not promise the same bytes twice.
  await assert.rejects(c.start({dest:f.workspace,items:[item('b.bin',4*1024*1024)]}),{code:'no-space'});
  const second=await c.start({dest:f.workspace,items:[item('c.bin',3*1024*1024)]}),other=second.uploads[0].id;
  await c.chunk({id:other,offset:0},Buffer.alloc(3*1024*1024));await c.cancel({ids:[other]});
  await b.chunk({id,offset:1024*1024},Buffer.alloc(7*1024*1024));
  const done=await b.finish({id});assert.ok(done.path);
  // The stale pre-restart handle releases nothing twice: the full 8 MiB fits again.
  await a.cancel({ids:[id]});
  const d=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs});
  const third=await d.start({dest:f.workspace,items:[item('d.bin',8*1024*1024)]});await d.cancel({ids:third.uploads.map(row=>row.id)});
});

test('concurrent chunks across instances share the recovered reserve',async t=>{
  const f=await filesFixture(t),free=1024**3+10*1024*1024,statfs=async()=>({bavail:free,bsize:1});
  const a=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs});
  const first=await a.start({dest:f.workspace,items:[item('a.bin',4*1024*1024),item('b.bin',4*1024*1024)]});
  const [ida,idb]=first.uploads.map(row=>row.id);
  const b=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs});
  await b.jobs();
  await Promise.all([a.chunk({id:ida,offset:0},Buffer.alloc(3*1024*1024)),b.chunk({id:idb,offset:0},Buffer.alloc(3*1024*1024))]);
  await Promise.all([a.chunk({id:ida,offset:3*1024*1024},Buffer.alloc(1024*1024)),b.chunk({id:idb,offset:3*1024*1024},Buffer.alloc(1024*1024))]);
  assert.ok((await a.finish({id:ida})).path);assert.ok((await b.finish({id:idb})).path);
  const c=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs});
  const second=await c.start({dest:f.workspace,items:[item('c.bin',8*1024*1024)]});await c.cancel({ids:second.uploads.map(row=>row.id)});
});

test('pruning recovered uploads releases their reservations',async t=>{
  let clock=Date.now();
  const f=await filesFixture(t,{now:()=>clock}),free=1024**3+10*1024*1024,statfs=async()=>({bavail:free,bsize:1});
  const a=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs,now:()=>clock});
  const first=await a.start({dest:f.workspace,items:[item('old.bin',8*1024*1024)]}),id=first.uploads[0].id;
  const b=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs,now:()=>clock});
  await b.jobs();clock+=25*3600_000;await b.prune();assert.equal(b.list().length,0);
  const c=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs,now:()=>clock});
  const second=await c.start({dest:f.workspace,items:[item('new.bin',10*1024*1024)]});await c.cancel({ids:second.uploads.map(row=>row.id)});
  await a.cancel({ids:[id]});
});

test('stale instances cannot subtract released reservations from other uploads',async t=>{
  const f=await filesFixture(t),statfs=async()=>({bavail:1024**3+10*1024*1024,bsize:1});
  const a=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs});
  const first=await a.start({dest:f.workspace,items:[item('old.bin',8*1024*1024)]}),id=first.uploads[0].id;
  const b=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs});await b.jobs();
  await b.chunk({id,offset:0},Buffer.alloc(8*1024*1024));await b.finish({id});
  const next=await b.start({dest:f.workspace,items:[item('pending.bin',8*1024*1024)]});
  await assert.rejects(a.start({dest:f.workspace,items:[item('extra.bin',4*1024*1024)]}),{code:'no-space'});
  await b.cancel({ids:next.uploads.map(row=>row.id)});await a.cancel({ids:[id]});
});

test('fresh module recovery reserves all unfinished uploads before accepting chunks',async t=>{
  const f=await filesFixture(t);
  const started=await f.uploads.start({dest:f.workspace,items:[item('recover-a.bin',8*1024*1024),item('recover-b.bin',8*1024*1024)]});
  const {createUploads:restarted}=await import('../docker/setup/files/uploads.mjs?restart-reserve-test');
  const recovered=restarted({policy:f.policy,guard:f.guard,trash:f.trash,statfs:async()=>({bavail:1024**3+10*1024*1024,bsize:1})});
  const results=await Promise.allSettled(started.uploads.map(({id})=>recovered.chunk({id,offset:0},Buffer.alloc(8*1024*1024))));
  assert.ok(results.every(row=>row.status==='rejected'&&row.reason.code==='no-space'));
  const ids=started.uploads.map(row=>row.id);await recovered.cancel({ids});await f.uploads.cancel({ids});
});

test('start measures the mount the upload lands on, not the destination',async t=>{
  const f=await filesFixture(t),stick=path.join(f.workspace,'stick');await fs.mkdir(stick);
  // The destination looks roomy but the stick subdir is nearly full.
  const statfs=async value=>value.split(path.sep).includes('stick')?{bavail:1024,bsize:1024}:{bavail:1024**3+6*1024**3,bsize:1};
  const uploads=createUploads({policy:f.policy,guard:f.guard,trash:f.trash,statfs}),big=5*1024**3;
  await assert.rejects(uploads.start({dest:f.workspace,items:[item('stick/big.bin',big)]}),
    error=>error.code==='no-space'&&error.fields.availableBytes===1024*1024&&error.fields.requiredBytes===big);
  // Nothing staged on the stick and nothing left behind in this start.
  assert.deepEqual(await fs.readdir(stick),[]);assert.equal(uploads.list().length,0);
  // The failed start reserved nothing: a 2 GiB upload still fits the 6 GiB of
  // headroom, which a leaked 5 GiB reservation would have denied.
  const next=await uploads.start({dest:f.workspace,items:[item('after.bin',2*1024**3)]});
  await uploads.cancel({ids:next.uploads.map(row=>row.id)});
});
