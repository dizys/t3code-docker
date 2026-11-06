import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fail, normalizePath, validateName } from './paths.mjs';
import { maybeStat, identity, same, uniqueName, privateDirectory, atomicJSON, renameExclusive, pinParent } from './entries.mjs';
import { createLimiter } from './io.mjs';
import { readText, statRevision } from './text.mjs';

export const CHUNK_BYTES=8*1024*1024;
const RESERVE=1024**3,DAY=86400_000;
// Bytes promised to in-flight uploads but not yet on disk, across every
// instance in this process. Starts are serialized per instance, but chunks
// run under per-id locks, so uploads with different ids would otherwise each
// see the full reserve and jointly spend past it.
let reservedBytes=0;
// Remaining bytes promised to unfinished uploads, by upload id. The first live
// instance to load an id owns its global share; later duplicates track their
// own copy without promising the same bytes twice.
const reservedIds=new Map();
const validId=id=>typeof id==='string'&&/^u_[0-9a-f-]{36}$/.test(id);
const relative=value=>{
  if(typeof value!=='string'||!value||path.isAbsolute(value)||Buffer.byteLength(value)>4096)fail('invalid','Use a relative upload path.');
  const parts=value.split('/');for(const name of parts)validateName(name);return parts;
};
const digest=async(file,expected)=>{
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const before=await handle.stat({bigint:true});if(!same(before,expected)||!before.isFile()||before.size>32n*1024n*1024n)fail('changed','The file changed while comparing contents.');
    const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(256*1024);let offset=0;
    while(offset<Number(before.size)){const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,Number(before.size)-offset),offset);if(!bytesRead)fail('changed','The file changed while comparing contents.');hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
    if(!same(before,await handle.stat({bigint:true})))fail('changed','The file changed while comparing contents.');return hash.digest('hex');
  }finally{await handle.close();}
};
export function createUploads({policy,guard,trash,now=Date.now,statfs=value=>fs.statfs(value),onFinish=()=>{}}) {
  const sessions=new Map(),locks=new Map(),metadata=createLimiter(1),starts=createLimiter(1);
  // This instance's share of reservedBytes, so its own rows are not counted twice.
  let counted=0;
  const reserve=row=>{row.reserved=(row.reserved??0)+row.size;counted+=row.size;reservedBytes+=row.size;if(row.size>0)reservedIds.set(row.id,(reservedIds.get(row.id)??0)+row.size);};
  const release=(row,n=row.reserved??0)=>{n=Math.min(n,row.reserved??0);if(n>0){row.reserved-=n;counted-=n;const pending=reservedIds.get(row.id)??0,take=Math.min(n,pending);if(take>0){reservedBytes-=take;if(pending>take)reservedIds.set(row.id,pending-take);else reservedIds.delete(row.id);}}};
  const directory=path.join(policy.stateDir,'files','uploads');
  let loading;
  const lock=(id,work)=>{if(!locks.has(id))locks.set(id,createLimiter(1));return locks.get(id)(work);};
  const record=id=>path.join(directory,id+'.json');
  const forget=async id=>{sessions.delete(id);locks.delete(id);await fs.unlink(record(id)).catch(error=>{if(error.code!=='ENOENT')throw error;});};
  const persist=row=>metadata(async()=>{await privateDirectory(directory);await atomicJSON(record(row.id),row);});
  const trim=async()=>{
    const completed=[...sessions.values()].filter(row=>row.result).sort((a,b)=>b.at-a.at);
    for(const row of completed.slice(256))await forget(row.id);
  };
  const ready=()=>loading??=(async()=>{
    const root=await maybeStat(directory);if(!root)return;
    if(!root.isDirectory()||root.isSymbolicLink()||root.uid!==BigInt(process.getuid?.()))return;
    const entries=await fs.opendir(directory);let count=0;
    for await(const entry of entries){
      if(++count>4096)break;const id=entry.name.replace(/\.json$/,'');if(!entry.name.endsWith('.json')||!validId(id))continue;
      try{const file=record(id),stat=await maybeStat(file);if(!stat?.isFile()||stat.isSymbolicLink()||stat.size>65536n||stat.uid!==BigInt(process.getuid?.()))continue;
        const content=await readText(file),row=JSON.parse(content.text);
        if(row.id!==id||!Number.isSafeInteger(row.size)||row.size<0||!Number.isSafeInteger(row.received)||row.received<0||row.received>row.size||!Number.isFinite(row.at))continue;
        relative(row.relative);normalizePath(row.dest);normalizePath(row.parent);if(row.temp!==path.join(row.parent,'.t3-upload-'+row.id+'.part'))continue;
        if(row.result){normalizePath(row.result.path);row.reserved=0;sessions.set(row.id,row);continue;}
        const parent=await maybeStat(row.parent),temp=await maybeStat(row.temp);
        if(!parent?.isDirectory()||parent.isSymbolicLink()||identity(parent)!==row.parentIdentity||!temp?.isFile()||temp.isSymbolicLink()||identity(temp)!==row.identity||Number(temp.size)>row.size)continue;
        row.received=Number(temp.size);row.reserved=row.size-row.received;counted+=row.reserved;
        if(row.reserved>0&&!reservedIds.has(row.id)){reservedIds.set(row.id,row.reserved);reservedBytes+=row.reserved;}
        sessions.set(row.id,row);
      }catch{/* Foreign or incomplete metadata cannot authorize staging cleanup. */}
    }
    await trim();
  })();
  const free=async parent=>{const data=await statfs(parent);return Number(data.bavail)*Number(data.bsize);};
  const enough=async(parent,required)=>{const available=await free(parent);if(required>available-RESERVE)fail('no-space','There isn’t enough space for these files. Free space and try again.',{availableBytes:available,requiredBytes:required,reserveBytes:RESERVE});return available;};
  const parents=async(dest,parts,input)=>{
    let value=dest;
    for(const name of parts){value=path.join(value,name);const stat=await maybeStat(value);if(stat){if(!stat.isDirectory()||stat.isSymbolicLink())fail('locked','A folder in this upload is a link or a file. Open its real folder and upload there.');continue;}
      await guard.run(input,[{path:value,mode:'write',missing:true}],async([row])=>{if(row.stat)fail('changed','An upload folder changed. Try again.');await fs.mkdir(row.pin.pinned);});}
    return value;
  };
  const start=input=>starts(async()=>{
    await ready();await trim();const dest=await fs.realpath(normalizePath(input.dest));
    if(!Array.isArray(input.items)||!input.items.length||input.items.length>500)fail('invalid','Upload between 1 and 500 files per request.');
    const items=input.items.map(item=>{
      const parts=relative(item.path);if(item.directory===true)return {...item,size:0,lastModified:0,parts};if(!Number.isSafeInteger(item.size)||item.size<0||!Number.isSafeInteger(item.lastModified)||item.lastModified<0)fail('invalid','Each upload needs its file size and modification time.');return {...item,parts};
    });
    if(new Set(items.map(row=>row.path)).size!==items.length)fail('conflicts','Two files in this upload have the same path. Upload them separately.');
    const results=[],created=[];
    const pending=items.filter(item=>!item.directory&&![...sessions.values()].some(row=>!row.result&&row.dest===dest&&row.relative===item.path&&row.size===item.size&&row.lastModified===item.lastModified));
    const required=pending.reduce((sum,row)=>sum+row.size,0);if(!Number.isSafeInteger(required))fail('too-large','This upload is too large. Upload a smaller selection.');
    const device=String((await fs.lstat(dest,{bigint:true})).dev),reserved=[...sessions.values()].filter(row=>!row.result&&row.parentIdentity.split(':')[0]===device).reduce((sum,row)=>sum+row.size-row.received,0);
    const freeBytes=await enough(dest,required+reserved+(reservedBytes-counted));
    if([...sessions.values()].filter(row=>!row.result).length+pending.length>2048)fail('busy','There are too many unfinished uploads. Cancel old uploads before starting more.');
    try{
      for(const item of items){
        if(item.directory){const parent=await parents(dest,item.parts,input);results.push({path:item.path,directory:true,result:{path:parent,directory:true}});continue;}
        const previous=[...sessions.values()].find(row=>!row.result&&row.dest===dest&&row.relative===item.path&&row.size===item.size&&row.lastModified===item.lastModified);
        if(previous){const actual=await maybeStat(previous.temp);if(actual?.isFile()&&!actual.isSymbolicLink()&&identity(actual)===previous.identity&&Number(actual.size)<=previous.size){const landed=Number(actual.size);if(landed>previous.received)release(previous,landed-previous.received);previous.received=landed;previous.at=now();results.push({...previous,conflict:await conflict(previous)});continue;}fail('changed','An unfinished upload changed on disk. Cancel it before restarting.');}
        const parent=await parents(dest,item.parts.slice(0,-1),input),target=path.join(parent,item.parts.at(-1)),id='u_'+randomUUID(),temp=path.join(parent,'.t3-upload-'+id+'.part');
        const row=await guard.run(input,[{path:target,mode:'write',missing:true,inUse:false}],async([target])=>{
          const handle=await fs.open(path.join(target.pin.parent,path.basename(temp)),'wx',0o600);
          try{const stat=await handle.stat({bigint:true});return {id,dest,parent:target.pin.parent,parentIdentity:identity(target.pin.stat),relative:item.path,target:target.path,temp,identity:identity(stat),size:item.size,lastModified:item.lastModified,received:0,at:now(),existingRevision:target.stat?statRevision(target.stat):null};}finally{await handle.close();}
        });
        sessions.set(id,row);reserve(row);created.push(row);results.push({...row,conflict:await conflict(row)});
      }
      for(const row of created)await persist(row);return {ok:true,chunkBytes:CHUNK_BYTES,freeBytes,uploads:results.map(row=>row.directory?row:publicSession(row))};
    }catch(error){for(const row of created){release(row);await forget(row.id);await safeUnlink(row);}throw error;}
  });
  const publicSession=row=>({id:row.id,path:row.relative,size:row.size,received:row.received,...(row.conflict?{conflict:row.conflict}:{}),...(row.result?{result:row.result}:{})});
  const get=async id=>{await ready();if(!validId(id)||!sessions.has(id))fail('missing','This upload session is no longer here. Drop the file again to start or resume.');return sessions.get(id);};
  const conflict=async row=>{const existing=await maybeStat(row.target);return existing?{existing:{bytes:Number(existing.size),modified:new Date(Number(existing.mtimeMs)).toISOString(),revision:statRevision(existing),kind:existing.isDirectory()?'folder':existing.isSymbolicLink()?'link':'file'}}:null;};
  const safeUnlink=async row=>{const actual=await maybeStat(row.temp);if(actual?.isFile()&&!actual.isSymbolicLink()&&identity(actual)===row.identity)await fs.unlink(row.temp);};
  const chunk=(input,body)=>lock(input.id,async()=>{
    const row=await get(input.id);if(row.result)return {ok:true,received:row.size,finished:true};
    if(!Buffer.isBuffer(body)||body.length>CHUNK_BYTES)fail('too-large','Each upload chunk can contain up to 8 MiB.');
    if(input.offset===null||input.offset===undefined)fail('invalid','Each upload chunk needs its offset.');const offset=Number(input.offset);if(!Number.isSafeInteger(offset)||offset<0||offset!==row.received)fail('changed','Continue this upload from the saved offset.',{received:row.received});
    if(row.received+body.length>row.size)fail('invalid','This chunk exceeds the declared file size.');
    await enough(row.parent,body.length+reservedBytes-(row.reserved??0));
    return guard.run(input,[{path:row.target,mode:'write',missing:true,inUse:false}],async([target])=>{
      if(identity(target.pin.stat)!==row.parentIdentity||target.pin.parent!==row.parent)fail('changed','The upload folder changed. Cancel this upload and choose the folder again.');
      const temp=path.join(`/proc/self/fd/${target.pin.handle.fd}`,path.basename(row.temp)),handle=await fs.open(temp,constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{
        const stat=await handle.stat({bigint:true});if(!stat.isFile()||identity(stat)!==row.identity||Number(stat.size)!==row.received)fail('changed','The staged upload changed. Drop the same file again to check its saved offset.',{received:row.received});
        let written=0;while(written<body.length){const result=await handle.write(body,written,body.length-written,row.received+written);if(!result.bytesWritten)fail('no-space','The disk could not accept more upload data.');written+=result.bytesWritten;}
        await handle.sync();row.received+=written;release(row,written);row.at=now();await persist(row);return {ok:true,received:row.received};
      }finally{await handle.close();}
    });
  });
  const finish=input=>lock(input.id,async()=>{
    const row=await get(input.id);if(row.result)return {ok:true,...row.result};
    if(row.received!==row.size)fail('changed','The upload has not finished receiving data.',{received:row.received});
    const choice=input.onConflict||'ask';if(!['ask','replace','keep-both','skip'].includes(choice))fail('invalid','Choose Replace, Keep both or Skip.');
    const existing=await maybeStat(row.target),current=await conflict(row);
    if(existing&&choice==='ask')fail('conflicts','This name is already here. Choose what to keep.',{conflicts:[{name:path.basename(row.target),...current}],received:row.received});
    if(existing&&choice==='skip'){await safeUnlink(row);release(row);row.result={skipped:true,path:row.target};row.finalRevision=statRevision(existing);await persist(row);return {ok:true,...row.result};}
    const dest=existing&&choice==='keep-both'?path.join(row.parent,await uniqueName(row.parent,path.basename(row.target))):row.target;
    const result=await guard.run(input,[{path:dest,mode:existing&&choice==='replace'?'remove':'write',missing:true}],async([target],verify)=>{
      if(identity(target.pin.stat)!==row.parentIdentity)fail('changed','The upload folder changed.');
      const temp=path.join(`/proc/self/fd/${target.pin.handle.fd}`,path.basename(row.temp)),staged=await maybeStat(temp);
      if(!staged?.isFile()||staged.isSymbolicLink()||identity(staged)!==row.identity||Number(staged.size)!==row.size)fail('changed','The staged upload changed. Start again.');
      if(target.stat&&choice!=='replace')fail('exists','A file with this name appeared. Resolve the conflict again.');
      if(target.stat&&statRevision(target.stat)!==(input.existingRevision||row.existingRevision))fail('stale','The file to replace changed. Review the conflict again.',{conflicts:[{name:path.basename(target.path),...await conflict(row)}]});
      if(target.stat?.isFile()&&target.stat.size<=32n*1024n*1024n&&target.stat.size===staged.size&&await digest(temp,staged)===await digest(target.pin.pinned,target.stat)){await verify();await safeUnlink(row);return {path:target.path,skipped:true,identical:true};}
      await fs.chmod(temp,target.stat?.isFile()?Number(target.stat.mode&0o777n):0o644);await fs.utimes(temp,new Date(),new Date(row.lastModified));await verify();let replaced;
      if(target.stat)replaced=await trash.stash(target,{reason:'replaced'});
      try{await renameExclusive(temp,target.pin.pinned);}catch(error){if(replaced)await trash.rollback(replaced,target.pin.pinned).catch(()=>{});throw error;}return {path:target.path,...(replaced?{replaced:replaced.id}:{})};
    });
    row.result=result;release(row);row.at=now();row.finalRevision=statRevision(await fs.lstat(result.path,{bigint:true}));await persist(row);void Promise.resolve(onFinish(result)).catch(()=>{});return {ok:true,...result};
  });
  const cancel=async input=>{
    if(!Array.isArray(input.ids)||input.ids.length>500)fail('invalid','Choose the uploads to cancel.');
    await ready();for(const id of input.ids)await lock(id,async()=>{const row=await get(id);if(!row.result){release(row);await safeUnlink(row);}await forget(id);});return {ok:true};
  };
  const prune=async()=>{await ready();for(const [id,row]of sessions)if(now()-row.at>DAY)await lock(id,async()=>{if(!row.result){release(row);await safeUnlink(row);}await forget(id);});await trim();};
  const jobs=async()=>{await ready();return [...sessions.values()].sort((a,b)=>Number(!!a.result)-Number(!!b.result)||b.at-a.at).slice(0,100).map(row=>({id:row.id,kind:'upload',label:row.relative,relative:row.relative,dest:row.dest,path:row.target,received:row.received,done:row.received,total:row.size,unit:'bytes',state:row.result?'done':'waiting',at:row.at,...(row.result?{result:row.result,finishedAt:new Date(row.at).toISOString()}:{} )}));};
  return {start,chunk,finish,cancel,prune,ready,jobs,list:()=>[...sessions.values()].map(publicSession)};
}
