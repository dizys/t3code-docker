import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseListeners, processLabel } from '../ports.mjs';
import { createCommandRunner, mapLimit } from './io.mjs';
import { inside } from './paths.mjs';

/** Only the supported shell RPC is consulted. An unsupported runtime omits the
 * entire thread affordance; no database schema or conversation content is read. */
export function createThreadFacts({ t3, now = Date.now } = {}) {
  let value = null, at = 0, pending;
  const get = () => {
    if(!pending && (!at || now()-at>=60_000)) pending=(async()=>{
      if(!t3?.first) return null;
      const item=await t3.first('orchestration.subscribeShell',{}, {timeoutMs:5000});
      const snapshot=item?.kind==='snapshot'?item.snapshot:item;
      if(!Array.isArray(snapshot?.projects)||!Array.isArray(snapshot?.threads)) return null;
      const roots=new Map(),resolved=new Map();
      const canonical=value=>{if(!resolved.has(value))resolved.set(value,fs.realpath(value).catch(()=>path.resolve(value)));return resolved.get(value);};
      await mapLimit(snapshot.projects.slice(0,100_000),8,async project=>{if(typeof project.workspaceRoot==='string'&&path.isAbsolute(project.workspaceRoot))roots.set(project.id,await canonical(project.workspaceRoot));});
      const rows=[];
      for(const thread of snapshot.threads.slice(0,100_000)) {
        if(thread.deletedAt || !roots.has(thread.projectId)) continue;
        const root=thread.worktreePath && path.isAbsolute(thread.worktreePath)?await canonical(thread.worktreePath):roots.get(thread.projectId);
        const times=[thread.updatedAt,thread.latestRunStartedAt,thread.latestRunCompletedAt,thread.createdAt].map(item=>typeof item==='string'?Date.parse(item):NaN).filter(Number.isFinite);
        rows.push({root,last:times.length?Math.max(...times):null});
      }
      return rows;
    })().then(rows=>{value=rows;},()=>{value=null;}).finally(()=>{at=now();pending=null;});
    return value;
  };
  const forPath = root => { const rows=get(); if(rows===null)return null; const matched=rows.filter(row=>inside(root,row.root)); const times=matched.map(row=>row.last).filter(Number.isFinite);return {count:matched.length,lastActiveAt:times.length?new Date(Math.max(...times)).toISOString():null}; };
  return { get, forPath, settled:async()=>{get();await pending;return value;},fresh:async()=>{await pending;at=0;get();await pending;return value;} };
}

export function createActivityService({ env=process.env, snapshot=async()=>({complete:false,processes:[]}), run=createCommandRunner(env), listeners, now=Date.now }={}) {
  let value={complete:false,processes:[]},at=0,pending;
  const read=async()=>{
    const [processes,ports,pid]=await Promise.all([
      snapshot({includeOpenFiles:true}),
      listeners?listeners():run('ss',['-H','-l','-t','-n','-p']).then(row=>parseListeners(row.stdout,{ephemeral:[0,0]}),()=>[]),
      fs.readFile(path.join(env.T3_RUN_DIR||`${env.T3CODE_HOME||`${env.HOME||"/home/t3"}/.t3`}/run`,'t3.pid'),'utf8').then(Number,()=>null),
    ]);
    return {complete:processes.complete, processes:processes.processes.filter(row=>row.uid===process.getuid?.()).map(row=>({
      pid:row.pid,label:row.pid===pid?'T3 Code':String(processLabel(row.args,'Process')).slice(0,100),cwd:row.cwd,
      openFiles:row.openFiles||[],ports:ports.filter(item=>item.pid===row.pid).map(item=>item.port),
    }))};
  };
  const get=()=>{
    if(!pending && (!at||now()-at>=5000)) pending=read().then(row=>{value=row;},()=>{value={complete:false,processes:[]};}).finally(()=>{at=now();pending=null;});
    return value;
  };
  const forPath=(root,{parent=false}={})=>{
    const facts=get(),boundary=parent?path.dirname(root):root;
    return {complete:facts.complete, running:facts.processes.filter(row=>row.cwd&&inside(boundary,row.cwd)||row.openFiles.some(file=>inside(root,file))).map(({openFiles,ports,...row})=>({...row,...(ports.length?{port:ports[0],ports}:{})}))};
  };
  return { get,forPath,settled:async()=>{get();await pending;return value;},fresh:async()=>{await pending;value=await read();at=now();return value;} };
}
