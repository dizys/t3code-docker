import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fail, inside, normalizePath } from './paths.mjs';
import { maybeStat, identity, privateDirectory, atomicJSON, uniqueName, pathsOf, pinParent, renameExclusive } from './entries.mjs';
import { kindOf } from './kinds.mjs';
import { createLimiter } from './io.mjs';
import { readText } from './text.mjs';

const DAY=86400_000,validId=id=>typeof id==='string'&&/^t_[0-9a-f-]{36}$/.test(id);
export function createTrash({policy,guard,sizes,git,now=Date.now,recordEvent=()=>{},disk=value=>fs.statfs(value)}) {
  const locations=[path.join(policy.workspace,'.t3-trash'),path.join(policy.stateRoot,'trash')],serial=createLimiter(1);
  const rootFor=async value=>{
    const stat=await fs.lstat(value,{bigint:true}),source=await guard.mounts.forPath(path.dirname(value),{fresh:true});
    const order=inside(policy.home,value)?[1,0]:[0,1];
    for(const index of order){const root=[policy.workspace,policy.home][index],target=await guard.mounts.forPath(root);if(source.available&&target.mount?.id===source.mount?.id&&stat.dev===(await fs.lstat(root,{bigint:true})).dev)return locations[index];}
    fail('no-trash-here','There is no Trash on this filesystem. Download first, or use Delete permanently with its separate review.');
  };
  const prepare=async root=>{
    await privateDirectory(root);
    if(root===locations[0]&&await git.hasMarker(policy.workspace)){
      const marker=await fs.lstat(path.join(policy.workspace,'.git'));let directory;
      if(marker.isDirectory())directory=path.join(policy.workspace,'.git');
      else if(marker.isFile()){const result=await git.command(policy.workspace,['rev-parse','--absolute-git-dir']);directory=result.stdout.trim();}
      if(directory){const info=path.join(directory,'info');await fs.mkdir(info,{recursive:true});const exclude=path.join(info,'exclude'),before=await maybeStat(exclude);if(before?.isSymbolicLink())fail('invalid','Git’s exclude file is a link. Add .t3-trash/ in Git before using workspace Trash.');
        // Read and append through one O_NOFOLLOW descriptor so a link swapped in
        // after the check above cannot redirect the write, as in text.mjs.
        let handle;try{handle=await fs.open(exclude,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_APPEND,0o666);}
        catch(error){if(error.code==='ELOOP')fail('invalid','Git’s exclude file is a link. Add .t3-trash/ in Git before using workspace Trash.');throw error;}
        try{const stat=await handle.stat({bigint:true});if(!stat.isFile())fail('invalid','Git’s exclude file is not a regular file. Add .t3-trash/ in Git before using workspace Trash.');
          const content=await handle.readFile('utf8');if(!content.split('\n').includes('.t3-trash/'))await handle.write((content&&!content.endsWith('\n')?'\n':'')+'.t3-trash/\n',null,'utf8');}
        finally{await handle.close();}}
    }
    return root;
  };
  const read=async(root,id)=>{
    if(!validId(id))fail('invalid','Choose a valid Trash item.');
    const dir=path.join(root,id),directory=await maybeStat(dir);
    if(!directory?.isDirectory()||directory.isSymbolicLink())fail('missing','This Trash item is no longer here.');
    const metaFile=path.join(dir,'meta.json'),stat=await maybeStat(metaFile);
    if(!stat?.isFile()||stat.isSymbolicLink()||stat.size>65536n||stat.uid!==BigInt(process.getuid?.()))fail('invalid','This is not a Files Trash item.');
    const text=await readText(metaFile);if(text.kind!=='text'||text.truncated)fail('invalid','This Trash record cannot be read safely.');
    let meta;try{meta=JSON.parse(text.text);}catch{fail('invalid','This Trash record is incomplete.');}
    const payload=await maybeStat(path.join(dir,'item'));
    if(meta.id!==id||!Number.isFinite(Date.parse(meta.deletedAt))||!payload||identity(payload)!==meta.identity)fail('stale','This Trash item changed. Refresh Trash.');
    normalizePath(meta.from);return {dir,root,meta,payload};
  };
  const find=async id=>{for(const root of locations)try{return await read(root,id);}catch(error){if(!['ENOENT','missing'].includes(error.code))throw error;}fail('missing','This Trash item is no longer here.');};
  const list=async()=>{
    const items=[];
    for(const root of locations){const rootStat=await maybeStat(root);if(!rootStat?.isDirectory()||rootStat.isSymbolicLink())continue;const dir=await fs.opendir(root);let count=0;
      for await(const entry of dir){if(++count>20_000)break;if(!validId(entry.name))continue;try{const {meta}=await read(root,entry.name);items.push({...meta,name:path.basename(meta.from),path:meta.from,fromDisplay:policy.display(path.dirname(meta.from)),removeAt:new Date(Date.parse(meta.deletedAt)+7*DAY).toISOString()});}catch{/* Foreign/incomplete records are never deleted as Files Trash. */}}
    }
    items.sort((a,b)=>Date.parse(b.deletedAt)-Date.parse(a.deletedAt));return {ok:true,items,revision:createHash('sha256').update(JSON.stringify(items.map(row=>[row.id,row.identity,row.from,row.deletedAt,row.bytes,row.kind]))).digest('hex'),bytes:items.every(row=>Number.isFinite(row.bytes))?items.reduce((sum,row)=>sum+row.bytes,0):null,locations,retentionDays:7};
  };
  const stash=async(row,{batch='t_batch_'+randomUUID(),reason='trash'}={})=>{
    const root=await prepare(await rootFor(row.path));
    if(inside(row.path,root)||locations.some(directory=>inside(directory,row.path)))fail('locked','Trash cannot contain itself.');
    const id='t_'+randomUUID(),dir=path.join(root,id);await fs.mkdir(dir,{mode:0o700});let renamed=false;
    const meta={id,from:row.path,deletedAt:new Date(now()).toISOString(),bytes:row.stat.isDirectory()?sizes.facts(row.path)?.bytes??null:Number(row.stat.size),kind:kindOf(path.basename(row.path),row.stat),reason,batch,identity:identity(row.stat)};
    try{await atomicJSON(path.join(dir,'meta.json'),meta);await fs.rename(row.pin?.pinned||row.path,path.join(dir,'item'));renamed=true;return meta;}
    finally{if(!renamed)await fs.rm(dir,{recursive:true,force:true});}
  };
  const move=(input)=>serial(async()=>{
    const paths=pathsOf(input.paths),batch='t_batch_'+randomUUID();
    // Preflight all filesystems before the first rename.
    await Promise.all(paths.map(rootFor));
    return guard.run(input,paths.map(path=>({path,mode:'remove'})),async rows=>{
      const moved=[];try{for(const row of rows)moved.push(await stash(row,{batch}));}
      catch(error){for(const meta of moved.reverse())try{const item=await find(meta.id);if(!await maybeStat(meta.from)){await fs.rename(path.join(item.dir,'item'),meta.from);await fs.rm(item.dir,{recursive:true,force:true});}}catch{}throw error;}
      return {ok:true,ids:moved.map(row=>row.id),undo:batch,bytes:moved.every(row=>row.bytes!==null)?moved.reduce((sum,row)=>sum+row.bytes,0):null};
    });
  });
  const rollback=async(meta,target=meta.from)=>{
    const item=await find(meta.id);if(await maybeStat(target))return false;
    await renameExclusive(path.join(item.dir,'item'),target);await fs.rm(item.dir,{recursive:true,force:true});return true;
  };
  const selected=async input=>{
    const all=await list(),ids=input.undo?all.items.filter(row=>row.batch===input.undo).map(row=>row.id):input.ids;
    if(!Array.isArray(ids)||!ids.length||ids.length>500||!ids.every(validId))fail('invalid','Choose between 1 and 500 Trash items.');
    return Promise.all([...new Set(ids)].map(find));
  };
  const restore=input=>serial(async()=>{
    const items=await selected(input),restored=[];
    // Authorize every destination before restoring any item.
    await guard.run(input,items.map(item=>({path:item.meta.from,mode:'write',missing:true})),async()=>{},{notify:false});
    for(const item of items){
      const parent=path.dirname(item.meta.from),name=await uniqueName(parent,path.basename(item.meta.from),{suffix:'restored'}),target=path.join(parent,name);
      const result=await guard.run(input,[{path:target,mode:'write',missing:true}],async([row],verify)=>{
        const fresh=await read(item.root,item.meta.id);await verify();if(await maybeStat(row.pin.pinned))fail('exists','The restore name is now taken. Try again.');
        await renameExclusive(path.join(fresh.dir,'item'),row.pin.pinned);await fs.rm(fresh.dir,{recursive:true,force:true});return {id:item.meta.id,path:row.path};
      });restored.push(result);
    }
    return {ok:true,restored};
  });
  const removeItems=async items=>{
    let bytes=0;for(const item of items){const fresh=await read(item.root,item.meta.id),payload=path.join(fresh.dir,'item'),mounts=await guard.mounts.forPath(payload,{fresh:true});if(!mounts.available||mounts.mounts.some(row=>inside(payload,row.path)))fail('locked','A mounted filesystem is inside this Trash item. Unmount it before removing it.');const pin=await pinParent(payload);try{if(identity(await fs.lstat(pin.pinned,{bigint:true}))!==fresh.meta.identity)fail('stale','Trash changed. Review it again.');await fs.rm(pin.pinned,{recursive:true,force:false});await fs.rm(fresh.dir,{recursive:true,force:true});bytes+=fresh.meta.bytes||0;}finally{await pin.close();}}
    return {ok:true,removed:items.length,bytes};
  };
  const empty=input=>serial(async()=>{if(input.confirmed!==true)fail('conflicts','Emptying Trash cannot be undone. Confirm the items shown in Trash.');const all=await list();if(input.revision&&input.revision!==all.revision)fail('stale','Trash changed after this review. Review it again before emptying it.');const items=input.ids===null||input.ids===undefined?await Promise.all(all.items.map(row=>find(row.id))):await selected(input);const result=await removeItems(items);recordEvent('files.trash-emptied','Emptied Trash',{detail:String(result.bytes)});return result;});
  const retention=()=>serial(async()=>{
    const all=await list(),oldest=[...all.items].sort((a,b)=>Date.parse(a.deletedAt)-Date.parse(b.deletedAt));const pressure=new Set();
    const usage=async root=>{const facts=await disk(root);const total=Number(facts.blocks)*Number(facts.bsize),free=Number(facts.bavail)*Number(facts.bsize);return total?(1-free/total)*100:0;};
    for(const row of oldest){const item=await find(row.id),age=now()-Date.parse(row.deletedAt);const used=await usage(item.root),device=String((await fs.lstat(item.root,{bigint:true})).dev);if(used>=90)pressure.add(device);else if(used<85)pressure.delete(device);if(age>=7*DAY||pressure.has(device)&&age>=10*60_000)await removeItems([item]);}
  });
  return {list,move,restore,empty,retention,stash,rollback,find,locations,rootFor};
}
