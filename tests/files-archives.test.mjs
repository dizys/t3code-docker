import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { filesFixture } from './lib/files-fixture.mjs';
import { zipFixture } from './lib/zip-fixture.mjs';
import { inspectZip,extractEntries } from '../docker/setup/files/zip-format.mjs';
import { createCommandRunner } from '../docker/setup/files/io.mjs';
import { randomBytes } from 'node:crypto';

test('ZIP metadata agrees with the image CLI and preserves unicode, executable modes, empty folders and safe links',async t=>{
 const f=await filesFixture(t),source=path.join(f.workspace,'source'),archive=path.join(f.workspace,'fixture.zip');await fs.mkdir(source);await fs.mkdir(path.join(source,'empty'));await fs.writeFile(path.join(source,'日本語 [a]*.txt'),'hello');await fs.writeFile(path.join(source,'run.sh'),'#!/bin/sh\nexit 0\n',{mode:0o755});await fs.symlink('run.sh',path.join(source,'latest'));
 const run=createCommandRunner();await run('zip',['-q','-r','-y',archive,'--','source'],{cwd:f.workspace});const cli=await run('unzip',['-Z','-l',archive]);assert.match(cli.stdout,/number of entries: 5/);assert.match(cli.stdout,/lrwx/);
 const info=await inspectZip(archive);assert.equal(info.entries.length,5);assert.equal(info.skipped.length,0);const stage=path.join(f.workspace,'out');await extractEntries(archive,info,stage);assert.equal(await fs.readFile(path.join(stage,'source/日本語 [a]*.txt'),'utf8'),'hello');assert.equal((await fs.stat(path.join(stage,'source/run.sh'))).mode&0o777,0o755);assert((await fs.stat(path.join(stage,'source/empty'))).isDirectory());assert.equal(await fs.readlink(path.join(stage,'source/latest')),'run.sh');
});
test('traversal names and links that could redirect extraction are disclosed and skipped before writes',async t=>{
 const f=await filesFixture(t),archive=path.join(f.workspace,'unsafe.zip'),stage=path.join(f.workspace,'out');await fs.writeFile(archive,zipFixture([{name:'../escape',data:'bad'},{name:'/absolute',data:'bad'},{name:'C:/drive',data:'bad'},{name:'back\\slash',data:'bad'},{name:'out',mode:0o120777,data:'../../escape'},{name:'out/file',data:'bad'},{name:'safe/a.txt',data:'okay'},{name:'safe/latest',mode:0o120777,data:'a.txt'}]));
 const info=await inspectZip(archive);assert.equal(info.skipped.length,6);await extractEntries(archive,info,stage);assert.equal(await fs.readFile(path.join(stage,'safe/a.txt'),'utf8'),'okay');assert.equal(await fs.stat(path.join(f.workspace,'escape')).then(()=>true,()=>false),false);assert.equal(await fs.readlink(path.join(stage,'safe/latest')),'a.txt');assert.equal(await fs.lstat(path.join(stage,'out')).then(()=>true,()=>false),false);
});
test('ZIP64 counts are bounded and duplicate or conflicting paths cannot overwrite an earlier entry',async t=>{
 const f=await filesFixture(t),archive=path.join(f.workspace,'test.zip');await fs.writeFile(archive,zipFixture([{name:'a',data:'64'}],{zip64:true}));assert.equal((await inspectZip(archive)).total,2);
 await fs.writeFile(archive,zipFixture([{name:'a',data:'one'},{name:'a',data:'two'}]));await assert.rejects(inspectZip(archive),{code:'invalid'});
 const zip=zipFixture([{name:'a',data:'small'}]);zip.writeUInt32LE(0xffffffff,zip.length-10);await fs.writeFile(archive,zip);await assert.rejects(inspectZip(archive),error=>['invalid','too-large'].includes(error.code));
});
test('lying expansion sizes, CRC errors, source changes and cancellation never publish extracted files',async t=>{
 const f=await filesFixture(t),archive=path.join(f.workspace,'bomb.zip');await fs.writeFile(archive,zipFixture([{name:'bomb',data:Buffer.alloc(1024*1024,0),declared:16}]));let info=await inspectZip(archive),stage=path.join(f.workspace,'stage');await assert.rejects(extractEntries(archive,info,stage),{code:'too-large'});assert((await fs.stat(path.join(stage,'bomb'))).size<1024*1024);await fs.rm(stage,{recursive:true});
 await fs.writeFile(archive,zipFixture([{name:'bad',data:'crc',crc:0}]));info=await inspectZip(archive);await assert.rejects(extractEntries(archive,info,stage),{code:'invalid'});await fs.rm(stage,{recursive:true});
 await fs.writeFile(archive,zipFixture([{name:'safe',data:'fine'}]));info=await inspectZip(archive);await fs.appendFile(archive,'changed');await assert.rejects(extractEntries(archive,info,stage),{code:'stale'});
 await fs.writeFile(archive,zipFixture([{name:'safe',data:'fine'}]));info=await inspectZip(archive);const controller=new AbortController();controller.abort();await assert.rejects(extractEntries(archive,info,stage,{signal:controller.signal}),{name:'AbortError'});
});

async function archiveServices(t,options={}){
 const f=await filesFixture(t),{createGitService}=await import('../docker/setup/files/git.mjs'),{createRebuildableService}=await import('../docker/setup/files/rebuildable.mjs'),{createReviews}=await import('../docker/setup/files/reviews.mjs'),{createArchives}=await import('../docker/setup/files/archives.mjs');
 const sizes={facts:()=>null,under:()=>[],entries:()=>new Map()},git=createGitService(),rebuildable=createRebuildableService({sizes,git,workspace:f.workspace}),reviews=createReviews(),archives=createArchives({...f,sizes,git,rebuildable,reviews,...options});return {...f,archives};
}
test('ZIP downloads stream exact literal names, apply exclusions and consume a stale-checked review',{timeout:20000},async t=>{
 const f=await archiveServices(t),source=path.join(f.workspace,'source');await fs.mkdir(source);await fs.mkdir(path.join(source,'node_modules'));await fs.writeFile(path.join(source,'package.json'),'{}');await fs.writeFile(path.join(source,'node_modules/cache'),'skip');await fs.writeFile(path.join(source,'.env'),'secret');await createCommandRunner()('git',['init','-q',source]);await fs.writeFile(path.join(source,'.gitignore'),'node_modules/\n');await fs.writeFile(path.join(source,'literal[*].txt'),'literal');await fs.writeFile(path.join(source,'line\nbreak.txt'),'newline');
 const preview=await f.archives.zipPreview({paths:[source],options:{includeHidden:false}});assert(preview.options.leaveOutRebuildable.folders.includes('source/node_modules'));const response=await f.archives.zip({token:preview.token}),chunks=[];for await(const chunk of response.stream)chunks.push(chunk);assert.equal(response.headers['content-length'],undefined);const archive=path.join(f.workspace,'download.zip');await fs.writeFile(archive,Buffer.concat(chunks));const info=await inspectZip(archive),names=info.entries.map(row=>row.name);assert(names.includes('source/literal[*].txt'));assert(names.includes('source/line\nbreak.txt'));assert(!names.some(name=>name.includes('node_modules')||name.endsWith('.env')));assert(names.includes('source/.git/config'),'Git history is independent of the hidden-files choice');await assert.rejects(f.archives.zip({token:preview.token}),{code:'stale'});
 const stale=await f.archives.zipPreview({paths:[source]});await fs.writeFile(path.join(source,'package.json'),'changed');await assert.rejects(f.archives.zip({token:stale.token}),{code:'stale'});
});
test('compression and extraction publish complete stages and preserve replaced destinations in Trash',{timeout:20000},async t=>{
 const f=await archiveServices(t),source=path.join(f.workspace,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'file.txt'),'archive me');
 const compressed=await f.archives.compress({paths:[source]}),job=await f.jobs.settled(compressed.job);assert.equal(job.state,'done',job.error);assert.match(job.result.path,/source.zip$/);
 const preview=await f.archives.extractPreview({path:job.result.path});assert.equal(preview.topLevel[0],'source');const extracted=await f.archives.extract({token:preview.token,into:'new',name:'output'}),done=await f.jobs.settled(extracted.job);assert.equal(done.state,'done',done.error);assert.equal(await fs.readFile(path.join(f.workspace,'output/source/file.txt'),'utf8'),'archive me');
 await fs.writeFile(path.join(source,'file.txt'),'original destination');const next=await f.archives.extractPreview({path:job.result.path});await assert.rejects(f.archives.extract({token:next.token,into:'here'}),{code:'conflicts'});const replaced=await f.archives.extract({token:next.token,into:'here',choices:{source:'replace'}}),finished=await f.jobs.settled(replaced.job);assert.equal(finished.state,'done',finished.error);assert.equal(await fs.readFile(path.join(source,'file.txt'),'utf8'),'archive me');assert.equal((await f.trash.list()).items.length,1);assert.equal((await fs.stat(job.result.path)).isFile(),true);
 assert.equal((await fs.readdir(f.workspace)).some(name=>/^\.t3-(zip|extract)-/.test(name)),false);
});
test('an extraction destination that changes while queued is kept; cancellation cleans all staging',{timeout:20000},async t=>{
 const f=await archiveServices(t),archive=path.join(f.workspace,'test.zip');await fs.writeFile(archive,zipFixture([{name:'file.txt',data:Buffer.alloc(1024*1024,0x61)}]));
 let release;const gate=new Promise(resolve=>{release=resolve;});const blockers=[f.jobs.add('test','Block one',()=>gate),f.jobs.add('test','Block two',()=>gate)];const preview=await f.archives.extractPreview({path:archive}),response=await f.archives.extract({token:preview.token,into:'new',name:'out'});await fs.mkdir(path.join(f.workspace,'out'));await fs.writeFile(path.join(f.workspace,'out/keep'),'newer');release();for(const id of blockers)await f.jobs.settled(id);assert.equal((await f.jobs.settled(response.job)).state,'failed');assert.equal(await fs.readFile(path.join(f.workspace,'out/keep'),'utf8'),'newer');
 const next=await f.archives.extractPreview({path:archive}),original=f.jobs.add;let cancelId;f.jobs.add=(kind,label,work,facts)=>original(kind,label,context=>work({...context,progress:value=>{context.progress(value);if(value.bytes>0)f.jobs.cancel(cancelId);}}),facts);const cancelled=await f.archives.extract({token:next.token,into:'new',name:'cancelled'});cancelId=cancelled.job;assert.equal((await f.jobs.settled(cancelId)).state,'cancelled');assert.equal(await fs.stat(path.join(f.workspace,'cancelled')).then(()=>true,()=>false),false);assert.equal((await fs.readdir(f.workspace)).some(name=>name.startsWith('.t3-extract-')),false);
});

test('internal link chains stay contained; dangling, cyclic and destination-dependent links are disclosed',async t=>{
 const f=await archiveServices(t),archive=path.join(f.workspace,'links.zip');await fs.writeFile(archive,zipFixture([{name:'file',data:'safe'},{name:'good',mode:0o120777,data:'file'},{name:'chain',mode:0o120777,data:'good'},{name:'external',mode:0o120777,data:'existing/outside'},{name:'cycle-a',mode:0o120777,data:'cycle-b'},{name:'cycle-b',mode:0o120777,data:'cycle-a'}]));
 const info=await inspectZip(archive);assert.deepEqual(info.entries.map(row=>row.name),['file','good','chain']);assert.equal(info.skipped.length,3);
 await fs.symlink(f.home,path.join(f.workspace,'existing'));await fs.writeFile(path.join(f.workspace,'file'),'existing content');const preview=await f.archives.extractPreview({path:archive});await assert.rejects(f.archives.extract({token:preview.token,into:'here',choices:{file:'keep-both'}}),/new folder/);assert.equal(await fs.readFile(path.join(f.workspace,'file'),'utf8'),'existing content');
});
test('a link with an empty target is disclosed and skipped, not a failed extraction',async t=>{
 const f=await filesFixture(t),archive=path.join(f.workspace,'empty-link.zip'),stage=path.join(f.workspace,'out');await fs.writeFile(archive,zipFixture([{name:'safe',data:'ok'},{name:'l',mode:0o120777,data:''}]));
 const info=await inspectZip(archive);assert.deepEqual(info.entries.map(row=>row.name),['safe']);assert.equal(info.skipped.find(row=>row.entry==='l').reason,'empty link target');
 await extractEntries(archive,info,stage);assert.equal(await fs.readFile(path.join(stage,'safe'),'utf8'),'ok');assert.equal(await fs.lstat(path.join(stage,'l')).then(()=>true,()=>false),false);
});

test('low disk space preserves an informative preview, refuses publication, and can be reviewed again after freeing space',async t=>{
 let available=1024**3+100;const f=await archiveServices(t,{space:async()=>available}),archive=path.join(f.workspace,'capacity.zip');await fs.writeFile(archive,zipFixture([{name:'file',data:Buffer.alloc(200,0x61)}]));
 const preview=await f.archives.extractPreview({path:archive});assert.equal(preview.canExtract,false);assert.equal(preview.uncompressedBytes,200);assert.deepEqual(preview.topLevelEntries,[{name:'file',kind:'file'}]);assert.equal(preview.freeBytes,available);assert.equal(preview.reserveBytes,1024**3);await assert.rejects(f.archives.extract({token:preview.token,name:'out'}),{code:'no-space'});assert.equal(await fs.stat(path.join(f.workspace,'out')).then(()=>true,()=>false),false);
 available=2*1024**3;const next=await f.archives.extractPreview({path:archive});assert.equal(next.canExtract,true);const action=await f.archives.extract({token:next.token,name:'out',trashArchive:true});assert.equal((await f.jobs.settled(action.job)).state,'done');assert.equal((await f.trash.list()).items[0].name,'capacity.zip');assert.equal((await fs.stat(path.join(f.workspace,'out/file'))).size,200);
});
test('prepared ZIP downloads are bounded, single use, and disconnects release their stream slots',{timeout:10000},async t=>{
 const f=await archiveServices(t),value=path.join(f.workspace,'large');await fs.writeFile(value,randomBytes(1024*1024));
 const first=await f.archives.zipPreview({paths:[value]}),second=await f.archives.zipPreview({paths:[value]}),third=await f.archives.zipPreview({paths:[value]});const a=await f.archives.zipStart({token:first.token}),b=await f.archives.zipStart({token:second.token});await assert.rejects(f.archives.zipStart({token:third.token}),{code:'busy'});
 const one=await f.archives.zip({token:a.token}),two=await f.archives.zip({token:b.token});const closed=Promise.all([one,two].map(row=>new Promise(resolve=>row.stream.once('close',resolve))));one.stream.destroy();two.stream.destroy();await closed;await f.jobs.settled(a.job);await f.jobs.settled(b.job);await assert.rejects(f.archives.zip({token:a.token}),{code:'stale'});
 const next=await f.archives.zip({token:third.token});for await(const _ of next.stream){}assert.equal((await f.jobs.settled(next.job)).state,'done');
});
test('legacy CP437 filenames decode without lossy replacement; malformed UTF-8 and encrypted ZIPs fail safely',async t=>{
 const f=await filesFixture(t),archive=path.join(f.workspace,'encoding.zip');await fs.writeFile(archive,zipFixture([{name:Buffer.from([0x63,0x61,0x66,0x82,0x2e,0x74,0x78,0x74]),flags:0,data:'coffee'}]));assert.equal((await inspectZip(archive)).entries[0].name,'café.txt');
 await fs.writeFile(archive,zipFixture([{name:Buffer.from([0xff]),data:'bad'}]));assert.equal((await inspectZip(archive)).skipped[0].reason,'invalid name');await fs.writeFile(archive,zipFixture([{name:'encrypted',data:'no',flags:0x801}]));await assert.rejects(inspectZip(archive),/Encrypted/);
});

test('non-UTF-8 filesystem names cannot be silently archived as a different existing filename',async t=>{
 const f=await archiveServices(t),source=path.join(f.workspace,'source');await fs.mkdir(source);await fs.writeFile(Buffer.concat([Buffer.from(source+'/'),Buffer.from([0xff])]),'invalid bytes');await fs.writeFile(path.join(source,'�'),'distinct valid name');await assert.rejects(f.archives.zipPreview({paths:[source]}),/cannot be represented as UTF-8/);assert.equal(await fs.readFile(path.join(source,'�'),'utf8'),'distinct valid name');
});

test('large flat ZIPs keep previews bounded and require a new folder for publication',async t=>{
 const f=await archiveServices(t),archive=path.join(f.workspace,'flat.zip');await fs.writeFile(archive,zipFixture(Array.from({length:501},(_,i)=>({name:'file-'+i,data:''}))));const preview=await f.archives.extractPreview({path:archive});assert.equal(preview.canExtractHere,false);assert.equal(preview.topLevelCount,501);assert.equal(preview.topLevel.length,100);await assert.rejects(f.archives.extract({token:preview.token,into:'here'}),{code:'too-large'});assert.deepEqual((await fs.readdir(f.workspace)).sort(),['flat.zip']);
});
