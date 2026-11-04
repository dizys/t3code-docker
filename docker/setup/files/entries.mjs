import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fail, normalizePath, validateName } from './paths.mjs';
import { statRevision } from './text.mjs';
import { createCommandRunner } from './io.mjs';

// GNU mv uses renameat2(RENAME_NOREPLACE), avoiding the lstat/rename gap.
// --no-copy also makes an unexpected device change fail without a partial copy.
export async function renameExclusive(from,to,{run=createCommandRunner()}={}) {
  const before=await fs.lstat(from,{bigint:true}),forChild=value=>value.replace(/^\/proc\/self\/fd\//,`/proc/${process.pid}/fd/`);
  let commandError;try{await run('mv',['--no-clobber','--no-copy','-T','--',forChild(from),forChild(to)]);}catch(error){commandError=error;}
  // GNU versions disagree on the exit status for a refused replacement.
  // Verify the actual inode transition; never retry or fall back to copying.
  const [after,remaining]=await Promise.all([maybeStat(to),maybeStat(from)]);
  if(identity(before)===identity(after)&&!remaining)return;
  if(after&&remaining)fail('exists','This name is now taken. Choose another name.');
  if(commandError)throw commandError;
  fail('changed','The move could not be confirmed. Check both locations before trying again.');
}

export const maybeStat=value=>fs.lstat(value,{bigint:true}).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
export const same=(a,b)=>a===null||b===null?a===b:statRevision(a)===statRevision(b);
export const identity=stat=>stat?`${stat.dev}:${stat.ino}:${stat.birthtimeNs??stat.birthtimeMs}`:null;
export const checkAbort=signal=>{if(signal?.aborted)throw new DOMException('Cancelled','AbortError');};
export const pathsOf=input=>{
  if(!Array.isArray(input)||!input.length||input.length>500)fail('invalid','Choose between 1 and 500 items.');
  const paths=[...new Set(input.map(normalizePath))];
  return paths.sort((a,b)=>a.length-b.length).filter((item,index,all)=>!all.slice(0,index).some(parent=>item.startsWith(parent+'/')));
};
export async function pinParent(value) {
  value=normalizePath(value);if(value==='/')fail('invalid','The filesystem root cannot be changed here.');
  const parent=await fs.realpath(path.dirname(value)),before=await fs.lstat(parent,{bigint:true});
  const handle=await fs.open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW),stat=await handle.stat({bigint:true});
  if(identity(before)!==identity(stat)){await handle.close();fail('changed','The parent folder changed. Open it again.');}
  return {path:path.join(parent,path.basename(value)),pinned:`/proc/self/fd/${handle.fd}/${path.basename(value)}`,parent,stat,handle,close:()=>handle.close()};
}
export async function privateDirectory(value) {
  await fs.mkdir(value,{mode:0o700,recursive:true});
  const stat=await fs.lstat(value);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.())fail('invalid','Files state must be a private folder owned by t3.');
  await fs.chmod(value,0o700);return value;
}
export async function atomicJSON(file,value) {
  const temp=file+'.'+randomUUID()+'.tmp';let handle;
  try{handle=await fs.open(temp,'wx',0o600);await handle.writeFile(JSON.stringify(value));await handle.sync();await handle.close();handle=null;await fs.rename(temp,file);}
  finally{await handle?.close();await fs.rm(temp,{force:true});}
}
export async function uniqueName(parent,name,{suffix='',start=2,reserved=new Set()}={}) {
  validateName(name);if(!reserved.has(name)&&!await maybeStat(path.join(parent,name)))return name;
  const ext=path.extname(name),stem=name.slice(0,name.length-ext.length);
  for(let count=start;count<10000;count++){
    let trimmed=stem;const ending=(suffix?(count===start?' ('+suffix+')':' ('+suffix+' '+(count-start+1)+')'):' ('+count+')')+ext;
    // An oversized ending cannot be shortened by trimming the stem.
    if(Buffer.byteLength(ending)>255)fail('invalid','That name is too long.');
    while(Buffer.byteLength(trimmed+ending)>255)trimmed=[...trimmed].slice(0,-1).join('');
    const next=validateName(trimmed+(suffix?(count===start?' ('+suffix+')':' ('+suffix+' '+(count-start+1)+')'):' ('+count+')')+ext);
    if(!reserved.has(next)&&!await maybeStat(path.join(parent,next)))return next;
  }
  fail('exists','Too many copies have this name. Choose another name.');
}

/** Copy into a private, same-device stage. Never follow a source link, read a
 * device/FIFO, cross a mount, or publish partial content. */
export async function copyEntry(source,dest,{signal,progress=()=>{},mounts,timeoutMs=20*60_000,maxEntries=200_000}={}) {
  const started=Date.now(),root=await fs.lstat(source,{bigint:true});let entries=0,bytes=0;
  const copy=async(from,to,depth=0)=>{
    checkAbort(signal);if(++entries>maxEntries||depth>128||Date.now()-started>timeoutMs)fail('too-large','This copy reached its limit. Copy a smaller folder.');
    const pin=await pinParent(from);
    try{
      const before=await fs.lstat(pin.pinned,{bigint:true});
      if(before.dev!==root.dev)fail('invalid','This folder includes another filesystem. Copy that mounted folder separately.');
      if(before.isSymbolicLink()){const target=await fs.readlink(pin.pinned);if(!same(before,await fs.lstat(pin.pinned,{bigint:true})))fail('changed','A link changed during copying.');await fs.symlink(target,to);}
      else if(before.isDirectory()){
        if(depth&&mounts){const mount=await mounts.forPath(pin.path);if(!mount.available||mount.isMountPoint)fail('invalid','This folder includes a mount that cannot be copied as an ordinary folder.');}
        const handle=await fs.open(pin.pinned,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        try{
          if(identity(await handle.stat({bigint:true}))!==identity(before))fail('changed','A folder changed during copying.');
          await fs.mkdir(to,{mode:0o700});
          const directory=await fs.opendir(`/proc/self/fd/${handle.fd}`);
          for await(const item of directory)await copy(`/proc/self/fd/${handle.fd}/${item.name}`,path.join(to,item.name),depth+1);
          if(!same(before,await handle.stat({bigint:true})))fail('changed','A folder changed during copying. Try again.');
          await fs.chmod(to,Number(before.mode&0o777n));
        }finally{await handle.close();}
      }else if(before.isFile()){
        const input=await fs.open(pin.pinned,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let output;
        try{
          output=await fs.open(to,'wx',0o600);if(!same(before,await input.stat({bigint:true})))fail('changed','A file changed during copying.');
          const buffer=Buffer.alloc(1024*1024);let offset=0;
          while(true){
            checkAbort(signal);if(Date.now()-started>timeoutMs)fail('too-large','This copy reached its time limit. Copy a smaller folder.');
            const {bytesRead}=await input.read(buffer,0,buffer.length,offset);if(!bytesRead)break;
            if(BigInt(offset+bytesRead)>before.size)fail('changed','A file grew during copying.');
            let written=0;while(written<bytesRead){const result=await output.write(buffer,written,bytesRead-written,offset+written);if(!result.bytesWritten)fail('no-space','The disk could not accept more copy data.');written+=result.bytesWritten;}
            offset+=bytesRead;progress({done:entries,bytes:bytes+offset});
          }
          if(!same(before,await input.stat({bigint:true}))||(await output.stat({bigint:true})).size!==before.size)fail('changed','A file changed during copying. Try again.');
          await output.chmod(Number(before.mode&0o777n));await output.sync();bytes+=Number(before.size);
        }finally{await Promise.allSettled([input.close(),output?.close()]);}
      }else fail('invalid','Special files cannot be copied in Files.');
      progress({done:entries,bytes});
    }finally{await pin.close();}
  };
  await copy(source,dest);return {entries,bytes};
}

export async function treeRevision(value,{signal,maxEntries=200_000,timeoutMs=20_000,onEntry,skip}={}) {
  const root=await fs.lstat(value,{bigint:true}),hash=createHash('sha256'),at=Date.now(),inodes=new Set();let entries=0,bytes=0;
  const visit=async(file,relative='',depth=0)=>{
    if(relative&&skip?.(relative))return;
    checkAbort(signal);if(++entries>maxEntries||depth>128||Date.now()-at>timeoutMs)fail('too-large','This folder is too large to review here. Work with a smaller selection.');
    const pin=await pinParent(file);
    try{
      const stat=await fs.lstat(pin.pinned,{bigint:true});if(stat.dev!==root.dev)fail('invalid','The selection includes a mounted filesystem.');
      hash.update(relative+'\0'+statRevision(stat)+'\0');const inode=String(stat.dev)+':'+String(stat.ino);if(!inodes.has(inode)){inodes.add(inode);bytes+=Number(stat.blocks)*512;}await onEntry?.({path:value+relative,relative,stat});
      if(stat.isDirectory()&&!stat.isSymbolicLink()){
        const handle=await fs.open(pin.pinned,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        try{if(identity(await handle.stat({bigint:true}))!==identity(stat))fail('changed','The folder changed. Review it again.');const names=[],directory=await fs.opendir(`/proc/self/fd/${handle.fd}`,{encoding:'buffer'}),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});for await(const entry of directory){if(names.length+entries>=maxEntries)fail('too-large','This folder is too large to review here.');let name;try{name=decoder.decode(entry.name);}catch{fail('invalid','This folder contains a filename that cannot be represented as UTF-8. Use a terminal to review it without changing its name.');}names.push(name);}names.sort();for(const name of names)await visit(`/proc/self/fd/${handle.fd}/${name}`,relative+'/'+name,depth+1);if(!same(stat,await handle.stat({bigint:true})))fail('changed','The folder changed. Review it again.');}finally{await handle.close();}
      }
    }finally{await pin.close();}
  };
  await visit(value);return {revision:hash.digest('hex'),entries,bytes,identity:identity(root)};
}
