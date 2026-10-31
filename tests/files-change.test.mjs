import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { filesFixture } from './lib/files-fixture.mjs';
import { readText } from '../docker/setup/files/text.mjs';
import { renameExclusive } from '../docker/setup/files/entries.mjs';

test('mkdir and rename treat names as data and never clobber a racing destination',async t=>{
  const {workspace,changes}=await filesFixture(t),name='cash $(touch sentinel) # 日本語';
  const created=await changes.mkdir({parent:workspace,name});assert.equal(created.path,path.join(workspace,name));
  await assert.rejects(changes.mkdir({parent:workspace,name}),{code:'exists'});
  const a=path.join(workspace,'a'),b=path.join(workspace,'b');await fs.writeFile(a,'one');await fs.writeFile(b,'two');
  await assert.rejects(changes.rename({path:a,name:'b'}),{code:'exists'});assert.equal(await fs.readFile(b,'utf8'),'two');
  await assert.rejects(renameExclusive(a,b),{code:'exists'});assert.equal(await fs.readFile(a,'utf8'),'one');
  await changes.rename({path:a,name:'- renamed'});assert.equal(await fs.readFile(path.join(workspace,'- renamed'),'utf8'),'one');
});

test('managed aliases require the exact root, while renaming a link never changes its target',async t=>{
  const {home,workspace,changes}=await filesFixture(t),managed=path.join(home,'.t3'),target=path.join(managed,'userdata');await fs.mkdir(target);
  const link=path.join(workspace,'alias');await fs.symlink(target,link);
  await assert.rejects(changes.rename({path:link,name:'renamed'}),{code:'locked'});
  await changes.rename({path:link,name:'renamed',unlock:managed});assert((await fs.lstat(path.join(workspace,'renamed'))).isSymbolicLink());assert((await fs.stat(target)).isDirectory());
  await assert.rejects(changes.rename({path:managed,name:'moved',unlock:managed}),{code:'locked'});
});

test('sign-in/key consequences and unknown or active processes fail closed',async t=>{
  const f=await filesFixture(t),keys=path.join(f.home,'.ssh');await fs.mkdir(keys);
  await assert.rejects(f.changes.rename({path:keys,name:'keys'}),{code:'conflicts'});
  f.setProcesses({complete:false,processes:[]});await assert.rejects(f.changes.rename({path:keys,name:'keys',confirmed:true}),{code:'in-use'});
  f.setProcesses({complete:true,processes:[{pid:42,label:'Dev server',cwd:keys,openFiles:[]}]});await assert.rejects(f.changes.rename({path:keys,name:'keys',confirmed:true}),error=>error.code==='in-use'&&error.fields.processes[0].pid===42);
  f.setProcesses({complete:true,processes:[]});await f.changes.rename({path:keys,name:'keys',confirmed:true});assert((await fs.stat(path.join(f.home,'keys'))).isDirectory());
});

test('renaming a Pi profile requires explicit sign-in confirmation and preserves its contents',async t=>{
  const f=await filesFixture(t),profile=path.join(f.home,'.pi'),auth=path.join(profile,'agent/auth.json');
  await fs.mkdir(path.dirname(auth),{recursive:true});await fs.writeFile(auth,'fixture credentials',{mode:0o600});
  await assert.rejects(f.changes.rename({path:profile,name:'pi-backup'}),error=>error.code==='conflicts'&&error.fields.consequence.signIns.includes('Pi'));
  assert.equal(await fs.readFile(auth,'utf8'),'fixture credentials','unconfirmed actions do not change the profile');
  await f.changes.rename({path:profile,name:'pi-backup',confirmed:true});
  assert.equal(await fs.readFile(path.join(f.home,'pi-backup/agent/auth.json'),'utf8'),'fixture credentials');
});

test('editor writes preserve mode, detect stale contents, save copies and deduplicate request identities',async t=>{
  const {workspace,changes}=await filesFixture(t),file=path.join(workspace,'script.sh');await fs.writeFile(file,'before\n',{mode:0o750});
  const before=await readText(file,{edit:true});await fs.writeFile(file,'outside\n');
  await assert.rejects(changes.write({path:file,text:'mine\n',etag:before.etag}),error=>error.code==='changed'&&error.fields.current.text==='outside\n');
  assert.equal(await fs.readFile(file,'utf8'),'outside\n');
  const copy=await changes.write({path:file,text:'mine\n',mode:'copy'});assert.match(copy.path,/script \(copy\)\.sh$/);assert.equal(await fs.readFile(copy.path,'utf8'),'mine\n');
  const input={path:file,text:'saved\n',mode:'overwrite',requestId:'r_12345678-1234-4234-8234-123456789abc'};
  const first=await changes.invoke('write',input),inode=(await fs.stat(file)).ino,second=await changes.invoke('write',input);assert.equal(first.etag,second.etag);assert.equal((await fs.stat(file)).ino,inode);assert.equal((await fs.stat(file)).mode&0o777,0o750);
  await assert.rejects(async()=>changes.invoke('write',{...input,text:'different'}),{code:'changed'});
  assert.equal((await fs.readdir(workspace)).some(name=>name.startsWith('.t3-write-')),false);
});

test('moving with replacement retains the destination in Trash, and Undo refuses newer edits',async t=>{
  const {workspace,changes,trash}=await filesFixture(t),source=path.join(workspace,'one'),dest=path.join(workspace,'dest');await fs.mkdir(dest);await fs.writeFile(source,'new');await fs.writeFile(path.join(dest,'one'),'old');
  await assert.rejects(changes.move({paths:[source],dest}),{code:'conflicts'});
  const result=await changes.move({paths:[source],dest,onConflict:'replace'});assert.equal(result.moved,1);assert.equal((await trash.list()).items.length,1);assert.equal(await fs.readFile(path.join(dest,'one'),'utf8'),'new');
  await fs.writeFile(path.join(dest,'one'),'edited');await assert.rejects(changes.move({undo:result.undo}),{code:'stale'});assert.equal(await fs.readFile(path.join(dest,'one'),'utf8'),'edited');
});

test('copy jobs keep folder structure and symlinks, then publish complete copies only',{timeout:15000},async t=>{
  const {workspace,changes,jobs}=await filesFixture(t),source=path.join(workspace,'source'),dest=path.join(workspace,'dest');await fs.mkdir(source);await fs.mkdir(dest);await fs.writeFile(path.join(source,'file.txt'),'copy me');await fs.symlink('../outside',path.join(source,'link'));await fs.writeFile(path.join(workspace,'outside'),'untouched');
  const result=await changes.move({paths:[source],dest,copy:true}),job=await jobs.settled(result.job);assert.equal(job.state,'done',job.error);assert.equal(await fs.readFile(path.join(dest,'source/file.txt'),'utf8'),'copy me');assert((await fs.lstat(path.join(dest,'source/link'))).isSymbolicLink());assert.equal(await fs.readFile(path.join(workspace,'outside'),'utf8'),'untouched');assert.equal((await fs.readdir(dest)).some(name=>name.startsWith('.t3-copy-')),false);
});

test('Undo restores the replaced destination as well as the moved source',async t=>{
  const f=await filesFixture(t),source=path.join(f.workspace,'one'),dest=path.join(f.workspace,'dest');await fs.mkdir(dest);await fs.writeFile(source,'new');await fs.writeFile(path.join(dest,'one'),'old');
  const result=await f.changes.move({paths:[source],dest,onConflict:'replace'});await f.changes.move({undo:result.undo});assert.equal(await fs.readFile(source,'utf8'),'new');assert.equal(await fs.readFile(path.join(dest,'one'),'utf8'),'old');assert.equal((await f.trash.list()).items.length,0);
});

test('a destination appearing after move planning is never replaced without a new decision',async t=>{
 const f=await filesFixture(t),source=path.join(f.workspace,'file'),dest=path.join(f.workspace,'dest'),target=path.join(dest,'file');await fs.mkdir(dest);await fs.writeFile(source,'source');
 const original=f.guard.run;let injected=false;f.guard.run=async(input,specs,work)=>{if(!injected){injected=true;await fs.writeFile(target,'arrived later');}return original(input,specs,work);};
 await assert.rejects(f.changes.move({paths:[source],dest}),{code:'stale'});assert.equal(await fs.readFile(target,'utf8'),'arrived later');assert.equal(await fs.readFile(source,'utf8'),'source');
});
test('replacement choices bind the reviewed destination revision',async t=>{
 const f=await filesFixture(t),source=path.join(f.workspace,'file'),dest=path.join(f.workspace,'dest'),target=path.join(dest,'file');await fs.mkdir(dest);await fs.writeFile(source,'source');await fs.writeFile(target,'original');let reviewed;
 try{await f.changes.move({paths:[source],dest});}catch(error){reviewed=error.fields.conflicts[0].existing.revision;}
 await fs.writeFile(target,'newer');await assert.rejects(f.changes.move({paths:[source],dest,onConflict:'replace',expected:{file:reviewed}}),{code:'stale'});assert.equal(await fs.readFile(target,'utf8'),'newer');
});


test('exclusive rename normalizes GNU refused-replacement exits and verifies successful inode transitions',async t=>{
 const {workspace}=await filesFixture(t),a=path.join(workspace,'source'),b=path.join(workspace,'taken');await fs.writeFile(a,'keep source');await fs.writeFile(b,'keep destination');
 const refusal=Object.assign(new Error('mv: not replacing destination'),{code:1});await assert.rejects(renameExclusive(a,b,{run:async()=>{throw refusal;}}),{code:'exists'});assert.equal(await fs.readFile(a,'utf8'),'keep source');assert.equal(await fs.readFile(b,'utf8'),'keep destination');
 const moved=path.join(workspace,'moved');await renameExclusive(a,moved,{run:async()=>{await fs.rename(a,moved);throw Object.assign(new Error('late CLI exit'),{code:1});}});assert.equal(await fs.readFile(moved,'utf8'),'keep source');assert.equal(await fs.stat(a).then(()=>true,()=>false),false);
});
