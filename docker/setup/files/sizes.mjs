import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { walk } from './walk.mjs';
import { fail, inside } from './paths.mjs';

export function createSizesService({ storage, home, workspace, now = Date.now, measure = walk } = {}) {
  const cache = new Map(), jobs = new Map(), preparing = new Map();
  let generation=0, combined=null, sorted=null, stamp=null;
  const index = () => storage?.sizes?.();
  const timestamp=value=>typeof value==='number'?value:Date.parse(value);
  const facts = (value, stat) => {
    const source=index(), indexed=source?.bytesOf(value), item=cache.get(value);
    const cached=item&&(!stat||item.mtimeMs===stat.mtimeMs)?item:null;
    const validIndex=Number.isFinite(indexed)&&(!stat||stat.mtimeMs<=timestamp(source.at));
    if(cached&&(!validIndex||timestamp(cached.at)>timestamp(source.at)))return cached;
    return validIndex?{bytes:indexed,at:source.at,partial:!!source.partial,files:null}:cached;
  };
  const entries=()=>{
    const source=index(),revision=String(source?.at)+':'+generation;
    if(stamp!==revision){
      combined=new Map(source?.entries?.()||[]);
      for(const [key,row]of cache)if(!combined.has(key)||timestamp(row.at)>timestamp(source?.at))combined.set(key,row.bytes);
      sorted=[...combined].sort(([a],[b])=>a<b?-1:a>b?1:0);stamp=revision;
    }
    return combined;
  };
  const under=value=>{
    entries();const prefix=value==='/'?'/':value+'/';let low=0,high=sorted.length;
    while(low<high){const mid=(low+high)>>>1;if(sorted[mid][0]<prefix)low=mid+1;else high=mid;}
    const rows=[];for(let index=low;index<sorted.length&&sorted[index][0].startsWith(prefix);index++)if(sorted[index][0]!==value)rows.push(sorted[index]);return rows;
  };
  const jobFor = value => [...jobs.values()].find(row => row.path === value && ['queued', 'running'].includes(row.state));
  const prepare = async (value, { force = false } = {}) => {
    const stat = await fs.lstat(value);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('invalid', 'Measure a folder, or open the link’s destination.');
    const existing = jobFor(value); if (existing) return existing;
    if (!force && facts(value, stat)) return null;
    if ([...jobs.values()].filter(row => ['queued', 'running'].includes(row.state)).length >= 2) return null;
    const job = { id: 'j_measure_' + randomUUID(), kind: 'measure', label: path.basename(value), path: value,
      state: 'running', done: [home,workspace].includes(value)&&storage?.refresh?null:0, total:facts(value,stat)?.files??null, unit: 'files', startedAt: new Date(now()).toISOString() };
    jobs.set(job.id, job);
    void (async () => {
      try {
        if ([home, workspace].includes(value) && storage?.refresh && storage?.sizes) { await storage.refresh(); job.partial = !!index()?.partial; }
        else {
          const result = await measure(value, { progress: row => { job.done = row.files; } });
          const after = await fs.lstat(value);
          if (stat.dev !== after.dev || stat.ino !== after.ino || stat.mtimeMs !== after.mtimeMs) { job.partial = true; }
          else {
            const at = new Date(now()).toISOString();
            for (const [key, row] of result.directories) {
              if (cache.size >= 10_000) cache.delete(cache.keys().next().value);
              cache.set(key, { bytes: row.bytes, mtimeMs: row.mtimeMs, files: row.files, partial: !row.complete, at });
            }
            generation++;job.partial = result.partial;
          }
        }
        job.state = 'done';
      } catch { job.state = 'failed'; job.error = 'This folder could not be measured. Check its permissions and try again.'; }
      finally {
        job.finishedAt = new Date(now()).toISOString();
        for (const [key, row] of jobs) if (jobs.size > 50 && !['running', 'queued'].includes(row.state)) jobs.delete(key);
      }
    })();
    return job;
  };
  const start = (value, options = {}) => {
    if (!options.force && storage?.backgroundScansEnabled === false) return Promise.resolve(null);
    const existing = jobFor(value); if (existing) return Promise.resolve(existing);
    if (preparing.has(value)) return preparing.get(value);
    if (!options.force && ([...jobs.values()].some(row => ['running', 'queued'].includes(row.state) && inside(row.path, value))
      || [...preparing.keys()].some(root => inside(root, value)))) return Promise.resolve(null);
    if ([...jobs.values()].filter(row => ['queued', 'running'].includes(row.state)).length + preparing.size >= 2) return Promise.resolve(null);
    const request = prepare(value, options).finally(() => preparing.delete(value));
    preparing.set(value, request); return request;
  };
  return { facts, start, jobs: () => [...jobs.values()].map(row => ({ ...row })), jobFor,
    entries, under,
    invalidate: value => { generation++;for (const key of cache.keys()) if (key === value || key.startsWith(value + '/') || value.startsWith(key + '/')) cache.delete(key); },
  };
}
