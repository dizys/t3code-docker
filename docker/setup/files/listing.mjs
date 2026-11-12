import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fail, inside } from './paths.mjs';
import { kindOf } from './kinds.mjs';
import { createMountService } from './mounts.mjs';
const mounts = createMountService();
import { mapLimit, opendirRaw } from './io.mjs';
import { internalName, sameEntry } from './walk.mjs';

const decode = new TextDecoder('utf-8', { fatal: true });
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export const fingerprint = value => '"' + createHash('sha256').update(JSON.stringify(value)).digest('base64url') + '"';
export const access = async (value, flags) => fs.access(value, flags).then(() => true, () => false);
export async function permissions(value) {
  const [writable, facts] = await Promise.all([access(value, constants.W_OK), mounts.forPath(value)]);
  const readOnly = !!facts.mount?.readOnly;
  return { writable: writable && !readOnly, readOnly, volumeId: facts.mount?.id || null };
}

/** Open descriptor pins the folder while names and lstat facts are read. */
export async function directoryEntries(value, { limit = 20_000, onEntry } = {}) {
  let handle, directory;
  const names = []; let overflow = false, invalidNames = 0, changed = false;
  try {
    const before = await fs.lstat(value);
    if (!before.isDirectory() || before.isSymbolicLink()) fail('invalid', 'Open a folder.');
    handle = await fs.open(value, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!sameEntry(before, stat)) fail('changed', 'This folder changed. Open it again.');
    const pinned = `/proc/self/fd/${handle.fd}`;
    directory = await opendirRaw(pinned);
    for await (const item of directory) {
      let name;
      try { name = decode.decode(item.name); } catch { invalidNames++; continue; }
      if (internalName(name)) continue;
      if (names.length >= limit) { overflow = true; break; }
      names.push(name);
    }
    const facts=await mapLimit(names,16,async name=>{
      try {
        const entry={name,path:path.join(value,name),stat:await fs.lstat(path.join(pinned,name))};
        return !onEntry||await onEntry(entry)?entry:null;
      }catch(error){
        if(error.code==='ENOENT'){changed=true;return null;}
        if(['EACCES','EPERM'].includes(error.code))return {name,path:path.join(value,name),unavailable:true};
        throw error;
      }
    });
    const rows=facts.filter(Boolean);
    changed ||= (await handle.stat()).mtimeMs !== stat.mtimeMs;
    return { rows, stat, overflow, invalidNames, changed };
  } finally { await directory?.close().catch(() => {}); await handle?.close(); }
}

export function createListingService({ policy, sizes, git, rebuildable }) {
  const placeOf = value => inside(policy.workspace,value) ? 'projects' : inside(policy.home,value) ? 'home' : 'path';
  const projectFor = async value => {
    if (!inside(policy.workspace,value)) return null;
    if (await git.hasMarker(policy.workspace)) return policy.workspace;
    const relative = path.relative(policy.workspace,value);
    return relative ? path.join(policy.workspace, relative.split(path.sep)[0]) : null;
  };
  const entry = async ({ name, path: value, stat, unavailable }, gitFacts, { classify = true } = {}) => {
    if (unavailable) return { name, path: value, kind:'file', bytes:null, measured:false, tags:[], unavailable:true };
    const kind = kindOf(name,stat), classification = classify ? await policy.classify(value) : {tags:[]};
    const measured = kind === 'folder' ? sizes.facts(value,stat) : { bytes: Number(stat.size) };
    let target = null;
    if (kind === 'link' && classify) {
      try { const targetStat = await fs.stat(value); target = { path:classification.target, kind:kindOf(path.basename(classification.target),targetStat) }; }
      catch { target = { path:classification.target, missing:true }; }
    }
    const relative = gitFacts?.root ? path.relative(gitFacts.root,value) : null;
    return { name, path:value, kind, bytes:measured?.bytes ?? null, measured:!!measured, partial:measured?.partial || false,
      modified:stat.mtime.toISOString(), tags:classification.tags, what:classification.what, managedTag:classification.managed?.tag||classification.ancestor?.tag||null,
      git:relative && gitFacts?.available ? gitFacts.statuses[relative] || null : null, ...(target ? { target } : {}),
      _revision:`${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`, _stat:stat };
  };
  const list = async (value, { hidden = false, sort = 'name', dir = 'asc', all = false, projectsOnly = false, pageSize = 500 } = {}) => {
    const absolute = await fs.realpath(value), classification = await policy.classify(absolute);
    const source = await directoryEntries(absolute, { limit:20_000 });
    const root = await git.rootFor(absolute), gitFacts = git.get(root);
    const candidates = source.rows.filter(row => (hidden || !row.name.startsWith('.')) && (!projectsOnly || row.stat?.isDirectory() && !row.name.startsWith('.')));
    const entries = await mapLimit(candidates,16,row => entry(row,gitFacts,{classify:false}));
    const rebuild = rebuildable?.get(absolute,root,entries) || { loading:false, candidates:[], kept:[] };
    const candidatesByPath = new Map(rebuild.candidates.map(row => [row.path,row]));
    const statFacts=sizes.facts(absolute,source.stat);
    if(!statFacts)void sizes.start(absolute).catch(()=>{});
    for (const row of entries) {
      if (candidatesByPath.has(row.path)) { row.tags.push('rebuildable'); row.rebuildable = true; }
      if (statFacts && row.kind === 'folder' && row.bytes === null) void sizes.start(row.path).catch(() => {});
    }
    const sortKey = ['name','size','modified','kind'].includes(sort) ? sort : 'name';
    const direction = dir === 'desc' ? -1 : 1;
    entries.sort((a,b) => {
      if (sortKey === 'name' && (a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1;
      if (sortKey === 'size') { if (a.bytes === null || b.bytes === null) return a.bytes === b.bytes ? collator.compare(a.name,b.name) : a.bytes === null ? 1 : -1; }
      const result = sortKey === 'size' ? a.bytes-b.bytes : sortKey === 'modified' ? Date.parse(a.modified||0)-Date.parse(b.modified||0) : collator.compare(a[sortKey],b[sortKey]);
      return result*direction || collator.compare(a.name,b.name);
    });
    const count = entries.length;
    const page=await mapLimit(all?entries:entries.slice(0,pageSize),16,async row=>{
      if(row.unavailable)return row;
      const decorated=await entry({name:row.name,path:row.path,stat:row._stat},gitFacts);
      return {...row,...decorated,tags:[...new Set([...row.tags,...decorated.tags])]};
    });
    const revision = page.map(({ _stat, ...row }) => row);
    const clean = page.map(({ _stat, _revision, ...row }) => row);
    const permissionsOf = await permissions(absolute), project = await projectFor(absolute), place = placeOf(absolute);
    const response = { ok:true, path:absolute, requested:value, place, project, relative:path.relative(place === 'projects' ? policy.workspace : place === 'home' ? policy.home : '/',absolute),
      ...permissionsOf, managed:classification.managed, tags:classification.tags,
      volume:place === 'projects' ? 'workspace' : place === 'home' ? 'home' : null,
      trash:place === 'projects' ? path.join(policy.workspace,'.t3-trash') : place === 'home' ? path.join(policy.stateRoot,'trash') : null,
      git:gitFacts, counts:{ items:count, hidden:source.rows.filter(row=>row.name.startsWith('.')).length, bytes:statFacts?.bytes ?? null,
        rebuildableBytes:rebuild.loading ? null : rebuild.candidates.reduce((sum,row)=>sum+(row.bytes||0),0) },
      entries:clean, more:!all && count>pageSize, total:count, tail:{count:all?0:Math.max(0,count-pageSize),bytes:all?0:entries.slice(pageSize).every(row=>row.bytes!==null)?entries.slice(pageSize).reduce((sum,row)=>sum+row.bytes,0):null}, truncated:source.overflow, invalidNames:source.invalidNames, changed:source.changed,
      measuredAt:statFacts?.at || null, partial:source.overflow || source.invalidNames>0 || statFacts?.partial || false, measuring:!!sizes.jobFor(absolute), measurement:sizes.jobFor(absolute)?{...sizes.jobFor(absolute)}:null, rebuildableLoading:rebuild.loading };
    response.etag = fingerprint([response,revision]);
    return response;
  };
  return { list, entry, placeOf, projectFor };
}
