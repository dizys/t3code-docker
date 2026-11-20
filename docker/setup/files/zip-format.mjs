// ZIP metadata is parsed by record lengths, never by human CLI output (which
// cannot distinguish names containing newlines). Files use bounded streams;
// archive-controlled paths are never passed to an extraction command.
// Format: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createInflateRaw, crc32 } from 'node:zlib';
import { fail, inside } from './paths.mjs';
import { openRegular, statRevision } from './text.mjs';
import { checkAbort } from './entries.mjs';

const MAX_ENTRIES=200_000,MAX_DIRECTORY=64*1024*1024,utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const cp437="\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\b\t\n\u000b\f\r\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\u007f\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0";
const safeNumber=value=>{const result=Number(value);if(!Number.isSafeInteger(result)||result<0)fail('too-large','This ZIP is too large to inspect safely.');return result;};
const exact=async(handle,offset,length)=>{const bytes=Buffer.alloc(length);let read=0;while(read<length){const result=await handle.read(bytes,read,length-read,offset+read);if(!result.bytesRead)fail('invalid','This ZIP is truncated. Download it to inspect or repair it.');read+=result.bytesRead;}return bytes;};
const extraFields=bytes=>{const fields=new Map();for(let at=0;at<bytes.length;){if(at+4>bytes.length)fail('invalid','This ZIP has damaged metadata.');const id=bytes.readUInt16LE(at),length=bytes.readUInt16LE(at+2);at+=4;if(at+length>bytes.length)fail('invalid','This ZIP has damaged metadata.');if(fields.has(id))fail('invalid','This ZIP has duplicate metadata fields.');fields.set(id,bytes.subarray(at,at+length));at+=length;}return fields;};
function decodeName(bytes,flags,extras){
  if(flags&0x800)return utf8.decode(bytes);
  const unicode=extras.get(0x7075);if(unicode?.length>=5&&unicode[0]===1&&unicode.readUInt32LE(1)===crc32(bytes))return utf8.decode(unicode.subarray(5));
  // Info-ZIP on UTF-8 Unix locales can omit both Unicode markers.
  try{return utf8.decode(bytes);}catch{return [...bytes].map(value=>cp437[value]).join('');}
}
function unsafeName(name){
  if(!name||name.includes('\0')||name.includes('\\')||name.startsWith('/')||/^[A-Za-z]:/.test(name))return 'outside';
  const parts=name.replace(/\/$/,'').split('/');if(parts.some(part=>part==='..'))return 'outside';
  if(parts.length>128)return 'path is too deep';if(Buffer.byteLength(name)>4096||parts.some(part=>!part||part==='.'||Buffer.byteLength(part)>255))return 'invalid name';return null;
}
export async function inspectZip(value,{signal}={}) {
  const deadline=Date.now()+20_000,opened=await openRegular(value),{handle,info:stat}=opened;
  try{
    const size=Number(stat.size);if(size<22)fail('invalid','This is not a complete ZIP archive.');
    const tail=await exact(handle,Math.max(0,size-65557),Math.min(size,65557));let end=-1;
    for(let at=tail.length-22;at>=0;at--)if(tail.readUInt32LE(at)===0x06054b50&&at+22+tail.readUInt16LE(at+20)===tail.length){end=at;break;}
    if(end<0)fail('invalid','This is not a supported ZIP archive.');
    const endAt=size-tail.length+end;
    if(tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6)||tail.readUInt16LE(end+8)!==tail.readUInt16LE(end+10))fail('invalid','Split ZIP archives must be downloaded and joined before extracting.');
    let count=tail.readUInt16LE(end+10),bytes=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16),directoryEnd=endAt;
    if(count===0xffff||bytes===0xffffffff||offset===0xffffffff){
      if(endAt<20)fail('invalid','This ZIP64 archive is incomplete.');const locator=await exact(handle,endAt-20,20);
      if(locator.readUInt32LE(0)!==0x07064b50||locator.readUInt32LE(4)!==0||locator.readUInt32LE(16)!==1)fail('invalid','Split ZIP64 archives are not supported.');
      const location=safeNumber(locator.readBigUInt64LE(8)),record=await exact(handle,location,56);
      if(record.readUInt32LE(0)!==0x06064b50||record.readUInt32LE(16)||record.readUInt32LE(20)||record.readBigUInt64LE(24)!==record.readBigUInt64LE(32))fail('invalid','This ZIP64 directory is invalid.');
      count=safeNumber(record.readBigUInt64LE(32));bytes=safeNumber(record.readBigUInt64LE(40));offset=safeNumber(record.readBigUInt64LE(48));directoryEnd=location;
    }
    if(count>MAX_ENTRIES||bytes>MAX_DIRECTORY)fail('too-large','Extract up to 200,000 entries and 64 MiB of directory metadata at a time.');
    if(offset+bytes>directoryEnd)fail('invalid','This ZIP directory overlaps its contents.');
    const directory=await exact(handle,offset,bytes),entries=[],skipped=[],seen=new Map();let at=0,total=0;
    for(let index=0;index<count;index++){
      checkAbort(signal);if(Date.now()>deadline)fail('too-large','This ZIP takes too long to inspect. Extract a smaller archive.');if(at+46>directory.length||directory.readUInt32LE(at)!==0x02014b50)fail('invalid','This ZIP directory is damaged.');
      const flags=directory.readUInt16LE(at+8),method=directory.readUInt16LE(at+10),crc=directory.readUInt32LE(at+16),nameLength=directory.readUInt16LE(at+28),extraLength=directory.readUInt16LE(at+30),commentLength=directory.readUInt16LE(at+32),disk=directory.readUInt16LE(at+34);
      const next=at+46+nameLength+extraLength+commentLength;if(next>directory.length)fail('invalid','This ZIP directory is truncated.');
      const rawName=directory.subarray(at+46,at+46+nameLength),extras=extraFields(directory.subarray(at+46+nameLength,at+46+nameLength+extraLength));
      let packed=directory.readUInt32LE(at+20),length=directory.readUInt32LE(at+24),localOffset=directory.readUInt32LE(at+42),zipAt=0;const large=extras.get(1);
      const largeValue=()=>{if(!large||zipAt+8>large.length)fail('invalid','This ZIP64 entry is incomplete.');const result=safeNumber(large.readBigUInt64LE(zipAt));zipAt+=8;return result;};
      if(length===0xffffffff)length=largeValue();if(packed===0xffffffff)packed=largeValue();if(localOffset===0xffffffff)localOffset=largeValue();
      if(disk||localOffset+30>offset)fail('invalid','This ZIP entry points outside the archive contents.');
      let name;try{name=decodeName(rawName,flags,extras);}catch{name='[invalid UTF-8 name '+(index+1)+']';skipped.push({entry:name,reason:'invalid name'});at=next;continue;}
      const mode=directory.readUInt32LE(at+38)>>>16,kind=(mode&0o170000)===0o120000?'link':name.endsWith('/')?'folder':'file',type=mode&0o170000;
      const reason=unsafeName(name)||(![0,0o040000,0o100000,0o120000].includes(type)?'special file':null);
      if(reason){skipped.push({entry:name,reason});at=next;continue;}
      if(flags&1||flags&0x40||![0,8].includes(method))fail('invalid','Encrypted or unsupported ZIP compression must be extracted on your computer. Store and Deflate ZIPs are supported.');
      name=name.replace(/\/$/,'');if(seen.has(name))fail('invalid','This ZIP contains duplicate names. Re-create it with unique paths before extracting.');
      const local=await exact(handle,localOffset,30);if(local.readUInt32LE(0)!==0x04034b50||local.readUInt16LE(8)!==method||local.readUInt16LE(6)!==flags)fail('invalid','This ZIP has conflicting entry headers.');
      const localNameLength=local.readUInt16LE(26),localExtraLength=local.readUInt16LE(28),localName=await exact(handle,localOffset+30,localNameLength);
      if(!rawName.equals(localName))fail('invalid','This ZIP has conflicting filenames.');
      const dataOffset=localOffset+30+localNameLength+localExtraLength;
      if(dataOffset+packed>offset||kind==='folder'&&length!==0)fail('invalid','This ZIP entry has invalid lengths.');
      total+=length;if(!Number.isSafeInteger(total))fail('too-large','This ZIP expands beyond the supported size.');
      const time=directory.readUInt16LE(at+12),date=directory.readUInt16LE(at+14),ut=extras.get(0x5455),modified=ut?.length>=5&&ut[0]&1?new Date(ut.readUInt32LE(1)*1000):new Date(Date.UTC(1980+(date>>9),(date>>5&15)-1,date&31,time>>11,time>>5&63,(time&31)*2));
      const entry={name,kind,mode:mode&0o777,bytes:length,packed,dataOffset,crc,method,modified:Number.isFinite(modified.getTime())?modified.toISOString():null};entries.push(entry);seen.set(name,entry);at=next;
    }
    if(at!==directory.length)fail('invalid','This ZIP contains unsupported directory records.');
    // Never extract a regular file through a link or a file-shaped parent.
    const budget=()=>{checkAbort(signal);if(Date.now()>deadline)fail('too-large','This ZIP takes too long to inspect. Extract a smaller archive.');};
    const safe=[];for(const entry of entries){budget();let parent=path.posix.dirname(entry.name),bad=false;while(parent!=='.'){const row=seen.get(parent);if(row&&row.kind!=='folder'){bad=true;break;}parent=path.posix.dirname(parent);}if(bad)skipped.push({entry:entry.name,reason:'parent is a link or file'});else safe.push(entry);}
    const facts={path:value,revision:statRevision(stat),bytes:size,entries:safe,skipped,total};
    let linkBytes=0;
    for(const entry of safe)if(entry.kind==='link'){
      budget();if((linkBytes+=entry.bytes)>16*1024*1024)fail('too-large','This ZIP has too much link metadata. Extract a smaller archive.');
      if(entry.bytes>4096){entry.skip='link target is too long';skipped.push({entry:entry.name,reason:entry.skip});continue;}
      try{entry.target=utf8.decode(await entryBytes(handle,entry,{signal,maxBytes:4096,deadline}));}catch(error){if(error.code||error.name==='AbortError')throw error;entry.skip='invalid link target';skipped.push({entry:entry.name,reason:entry.skip});continue;}
      if(!entry.target){entry.skip='empty link target';skipped.push({entry:entry.name,reason:entry.skip});continue;}
      if(entry.target.includes('\0')||entry.target.includes('\\')||entry.target.startsWith('/'))entry.skip='link';
      const parts=path.posix.dirname(entry.name)==='.'?[]:path.posix.dirname(entry.name).split('/');
      for(const part of entry.target.split('/'))if(part==='..'){if(!parts.length){entry.skip='link';break;}parts.pop();}else if(part&&part!=='.')parts.push(part);
      if(entry.skip)skipped.push({entry:entry.name,reason:entry.skip,target:entry.target});
    }
    // A lexical target can still escape through another link, including one
    // already at the destination. Keep only links resolvable inside the ZIP's
    // own namespace. This also rejects cycles and dangling external targets.
    const namespace=new Map(safe.map(row=>[row.name,row])),folders=new Set(['']);
    for(const row of safe){let parent=path.posix.dirname(row.name);while(parent!=='.'){folders.add(parent);parent=path.posix.dirname(parent);}if(row.kind==='folder')folders.add(row.name);}
    const internal=entry=>{
      let remaining=[...path.posix.dirname(entry.name).split('/').filter(part=>part!=='.'),...entry.target.split('/')],parts=[],links=0;
      while(remaining.length){budget();const part=remaining.shift();if(!part||part==='.')continue;if(part==='..'){if(!parts.length)return false;parts.pop();continue;}
        parts.push(part);const row=namespace.get(parts.join('/'));
        if(row?.kind==='link'){if(row.skip||++links>40)return false;parts.pop();remaining=[...row.target.split('/'),...remaining];}
        else if(remaining.length&&row?.kind==='file')return false;
      }
      const target=parts.join('/');return folders.has(target)||namespace.get(target)?.kind==='file';
    };
    for(const entry of safe)if(entry.kind==='link'&&!entry.skip&&!internal(entry)){entry.skip='link target is not contained in this ZIP';skipped.push({entry:entry.name,reason:entry.skip,target:entry.target});}
    facts.entries=safe.filter(entry=>!entry.skip);facts.total=facts.entries.reduce((sum,row)=>sum+row.bytes,0);
    if(statRevision(await handle.stat({bigint:true}))!==facts.revision)fail('changed','This ZIP changed while it was being inspected. Review it again.');return facts;
  }finally{await handle.close();await opened.parent?.close();}
}
async function* compressed(handle,entry,signal,deadline){let position=0;while(position<entry.packed){checkAbort(signal);if(Date.now()>deadline)fail('too-large','This ZIP reached its processing time limit.');const buffer=Buffer.allocUnsafe(Math.min(65536,entry.packed-position)),{bytesRead}=await handle.read(buffer,0,buffer.length,entry.dataOffset+position);if(!bytesRead)fail('invalid','This ZIP is truncated.');position+=bytesRead;yield buffer.subarray(0,bytesRead);}}
async function consumeEntry(handle,entry,{signal,maxBytes=entry.bytes,onChunk,deadline=Date.now()+20*60_000}={}){
  const input=Readable.from(compressed(handle,entry,signal,deadline)),inflate=entry.method===8?createInflateRaw():null,output=inflate?input.pipe(inflate):input;let bytes=0,checksum=0;
  const abort=()=>output.destroy(new DOMException('Cancelled','AbortError'));signal?.addEventListener('abort',abort,{once:true});
  input.on('error',error=>inflate?.destroy(error));
  try{for await(const chunk of output){checkAbort(signal);bytes+=chunk.length;if(bytes>maxBytes||bytes>entry.bytes)fail('too-large','This ZIP expanded beyond its declared size. Extraction stopped and staged files were removed.');checksum=crc32(chunk,checksum);await onChunk?.(chunk);}
    if(bytes!==entry.bytes||checksum!==entry.crc)fail('invalid','A ZIP entry failed its size or integrity check. Nothing was published.');return bytes;
  }catch(error){if(error.code?.startsWith('Z_'))fail('invalid','A ZIP entry could not be decompressed. Nothing was published.');throw error;}
  finally{signal?.removeEventListener('abort',abort);input.destroy();inflate?.destroy();}
}
export async function entryBytes(handle,entry,options={}){const chunks=[];await consumeEntry(handle,entry,{...options,onChunk:chunk=>chunks.push(chunk)});return Buffer.concat(chunks);}
export async function extractEntries(value,info,stage,{signal,progress=()=>{},reserveCheck=async()=>{}}={}){
  const opened=await openRegular(value);let done=0,bytes=0,lastCheck=0;const directories=[],deadline=Date.now()+20*60_000;
  const budget=()=>{checkAbort(signal);if(Date.now()>deadline)fail('too-large','Extraction reached its 20-minute time limit. Staged output was removed.');};
  try{
    if(statRevision(opened.info)!==info.revision)fail('stale','This ZIP changed after the preview. Review it again.');
    await fs.mkdir(stage,{mode:0o700});
    for(const entry of info.entries.filter(row=>row.kind!=='link')){
      budget();const target=path.join(stage,entry.name);if(!inside(stage,target))fail('invalid','An archive entry escaped staging.');
      await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
      if(entry.kind==='folder'){await fs.mkdir(target,{recursive:true,mode:0o700});directories.push([target,entry]);}
      else{const handle=await fs.open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await consumeEntry(opened.handle,entry,{signal,deadline,onChunk:async chunk=>{if(Date.now()-lastCheck>2000){lastCheck=Date.now();await reserveCheck();}let offset=0;while(offset<chunk.length){const result=await handle.write(chunk,offset,chunk.length-offset);if(!result.bytesWritten)fail('no-space','The disk is full. Staged files were removed.');offset+=result.bytesWritten;}bytes+=chunk.length;progress({done,bytes,total:info.entries.length});}});await handle.chmod(entry.mode||0o644);await handle.sync();if(entry.modified)await handle.utimes(new Date(),new Date(entry.modified));}finally{await handle.close();}}
      done++;progress({done,bytes,total:info.entries.length});
    }
    // Links are last, so no later extraction can traverse one of them.
    for(const entry of info.entries.filter(row=>row.kind==='link')){budget();const target=path.join(stage,entry.name),resolved=path.resolve(path.dirname(target),entry.target);if(!inside(stage,resolved))fail('invalid','A link escaped the extraction folder.');await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.symlink(entry.target,target);done++;progress({done,bytes,total:info.entries.length});}
    for(const [directory,entry]of directories.sort(([a],[b])=>b.split('/').length-a.split('/').length)){await fs.chmod(directory,entry.mode||0o755);if(entry.modified)await fs.utimes(directory,new Date(),new Date(entry.modified));}
    if(statRevision(await opened.handle.stat({bigint:true}))!==info.revision)fail('changed','This ZIP changed during extraction. The original archive was kept.');return {entries:done,bytes};
  }finally{await opened.handle.close();await opened.parent?.close();}
}
