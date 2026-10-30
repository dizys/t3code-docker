const T3FilesTransfers=(()=>{
  'use strict';
  const {html,raw,icon}=Kit,F=T3FilesModel,M=T3Model;
  const activeStates=new Set(['queued','starting','uploading','retrying','finishing']);
  const create=({api,request,context,refresh,dialogs,go,extract=()=>{},freeSpace=()=>go('storage'),onActive=()=>{}})=>{
    const rows=new Map(),uploaded=new Map(),dismissed=new Set(),PHONE=matchMedia('(max-width: 639.98px)');
    // Restored history stays compact; enqueue and notifyJob open new work.
    let active=0,folded=true,visible=true,dragging=false,previousFold=false,sheet=null,timer=null,frame=null,picker=null,transferPage=0;
    const workRows=()=>[...rows.values()];
    const hasUploads=()=>workRows().some(row=>row.file&&activeStates.has(row.phase));
    const hasJobs=()=>workRows().some(row=>!row.file&&['running','queued'].includes(row.phase));
    const progress=row=>Number.isFinite(row.total)&&row.total>0?Math.max(0,Math.min(100,(row.sent??row.received??row.done??0)/row.total*100)):row.phase==='done'?100:null;
    const rate=row=>{const samples=(row.samples||[]).filter(sample=>sample.at>=Date.now()-5000);if(samples.length<2)return null;const first=samples[0],last=samples.at(-1);return last.at>first.at?Math.max(0,(last.bytes-first.bytes)*1000/(last.at-first.at)):null;};
    const sample=(row,value)=>{row.sent=value;row.samples=(row.samples||[]).filter(sample=>sample.at>Date.now()-5000);row.samples.push({at:Date.now(),bytes:value});};
    const label=row=>({queued:row.file||row.kind==='upload'?'Waiting to upload':'Waiting for another transfer',starting:'Starting upload…',uploading:'Uploading',retrying:row.code==='busy'?'Waiting for T3 Code’s update':'Reconnecting',paused:'Paused',conflict:'Already here. Waiting for your choice.',finishing:'Finishing…',done:row.skipped?'Skipped':({zip:'ZIP ready',compress:'Compressed',extract:'Extracted',clean:'Space freed',delete:'Deleted',copy:'Copied',move:'Moved'})[row.kind]||'Uploaded',failed:'Couldn’t finish',cancelled:'Cancelled',uncertain:'Check the folder before retrying',running:'On the server'})[row.phase]||row.phase;
    const control=(row,action,glyph,title)=>html`<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-transfer-action="${action}" data-transfer-id="${row.id}" aria-label="${title}">${icon(glyph)}</button>`;
    const body=(expanded=!folded)=>{
      const all=workRows(),cancelable=all.filter(row=>!['done','cancelled','uncertain','finishing'].includes(row.phase)&&row.cancellable!==false),live=all.filter(row=>activeStates.has(row.phase)||['running','queued'].includes(row.phase)),attention=all.filter(row=>['paused','conflict','failed','uncertain'].includes(row.phase)),total=all.reduce((sum,row)=>sum+(row.total||0),0),done=all.reduce((sum,row)=>sum+(row.sent??row.received??row.done??0),0);
      const ordered=[...all.filter(row=>['starting','uploading','retrying','finishing','running'].includes(row.phase)),...attention,...all.filter(row=>row.phase==='queued'),...all.filter(row=>['done','cancelled'].includes(row.phase))];transferPage=Math.min(transferPage,Math.max(0,Math.ceil(ordered.length/100)-1));
      return html`<header class="tc-tray-head"><div><strong>Transfers</strong><small>${live.length?M.plural(live.length,'running'):attention.length?attention.length+' '+(attention.length===1?'needs':'need')+' your attention':'Transfers complete'}${attention.length&&live.length?' · '+attention.length+' need you':''}</small><div class="tc-progress" role="progressbar" aria-label="Overall transfer progress" aria-valuemin="0" aria-valuemax="100"${total?html` aria-valuenow="${Math.round(done/total*100)}"`:''}><span style="width:${total?Math.min(100,done/total*100):live.length?15:100}%"></span></div></div><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-transfer-action="fold" aria-label="${expanded?'Collapse transfers':'Show transfers'}" aria-expanded="${String(expanded)}">${icon(expanded?'chevron-down':'chevron-up')}</button></header>${expanded?html`<div class="tc-files-transfer-list">${ordered.slice(transferPage*100,(transferPage+1)*100).map(row=>{const percent=progress(row),speed=rate(row),left=speed>0?(row.total-(row.sent||row.received||0))/speed:null;return html`<div class="tc-tray-item" data-key="transfer:${row.id}" data-state="${row.phase==='done'?'done':['failed','conflict','paused','uncertain'].includes(row.phase)?'warn':'running'}">${icon(row.phase==='done'?'circle-check':['failed','conflict','paused','uncertain'].includes(row.phase)?'triangle-alert':row.file?'upload':({zip:'download',compress:'archive',extract:'file-archive',clean:'eraser',delete:'trash-2',move:'folder-input'})[row.kind]||'copy')}<div><b title="${row.label}">${row.label}</b>${!['done','cancelled','conflict','failed','uncertain'].includes(row.phase)?html`<div class="tc-progress" role="progressbar" aria-label="${row.label}" aria-valuemin="0" aria-valuemax="100"${percent!==null?html` aria-valuenow="${Math.round(percent)}"`:''}><span style="width:${percent??15}%"></span></div>`:''}<small>${row.error||label(row)}</small>${row.phase==='done'&&(row.file||row.kind==='upload')&&row.path&&F.basename(row.path)!==F.basename(row.relative||row.label)?html`<small>Saved as <code>${F.basename(row.path)}</code></small>`:''}${row.space?html`<small>${M.formatBytes(row.space.requiredBytes||row.total)} needed · ${M.formatBytes(row.space.availableBytes)} available</small><button class="tc-btn tc-btn--link tc-btn--xs" type="button" data-transfer-action="free-space">Free up space…</button>`:''}${row.file&&['uploading','retrying','paused'].includes(row.phase)?html`<small>${M.formatBytes(row.received||0)} of ${M.formatBytes(row.total)}${speed?' · '+M.formatBytes(speed)+'/s':''}${left!==null&&left>0?' · '+Math.ceil(left)+' s left':''}${row.retryAt?' · retry in '+Math.max(0,Math.ceil((row.retryAt-Date.now())/1000))+' s':''}</small>`:!row.file&&Number.isFinite(row.done)&&row.phase==='running'?html`<small>${row.done.toLocaleString()}${Number.isFinite(row.total)?' of '+row.total.toLocaleString():''} ${row.unit||'files'}</small>`:''}${row.kind==='clean'&&Number.isFinite(row.freedBytes)?html`<small>${M.formatBytes(row.freedBytes)} freed</small>`:''}${row.phase==='done'&&!row.skipped&&/\.zip$/i.test(row.path||'')&&(row.file||row.kind==='upload')?html`<label class="tc-files-transfer-extract"><input class="tc-checkbox" type="checkbox" data-transfer-extract="${row.id}"${row.extractPending?raw(' disabled checked'):''}>${row.extractPending?'Reviewing extraction…':'Extract into '+F.basename(row.path).replace(/\.zip$/i,'')+'/'}</label>`:''}${row.path&&row.phase==='done'?html`<button class="tc-btn tc-btn--link tc-btn--xs" type="button" data-transfer-action="show" data-transfer-id="${row.id}" title="${row.dest||F.parent(row.path)}"><span>Show in ${F.basename(row.dest||F.parent(row.path))}</span></button>`:''}</div><span>${row.phase==='conflict'?html`<button class="tc-btn tc-btn--sm" type="button" data-transfer-action="resolve" data-transfer-id="${row.id}">Resolve…</button>`:row.phase==='uncertain'?control(row,'show','folder-open','Check destination'):row.file&&row.phase==='finishing'?html`<span class="tc-spinner" aria-label="Finishing upload"></span>`:row.file&&activeStates.has(row.phase)?html`${control(row,'pause','pause','Pause '+row.label)}${control(row,'cancel','x','Cancel '+row.label)}`:row.file&&['paused','failed'].includes(row.phase)?html`${control(row,'retry','play','Resume '+row.label)}${control(row,'cancel','x','Cancel '+row.label)}`:!row.file&&['running','queued'].includes(row.phase)&&row.cancellable!==false?control(row,'cancel','x','Cancel '+row.label):control(row,'dismiss','x','Dismiss '+row.label)}</span></div>`;})}</div>${ordered.length>100?html`<div class="tc-files-transfer-pages"><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-transfer-action="previous"${transferPage===0?raw(' disabled'):''}>Previous</button><span>${transferPage*100+1}–${Math.min((transferPage+1)*100,ordered.length)} of ${ordered.length}</span><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-transfer-action="next"${(transferPage+1)*100>=ordered.length?raw(' disabled'):''}>Next</button></div>`:''}${PHONE.matches?html`<div class="tc-files-transfer-keep">${icon('info')}<div><strong>Keep Files open until they finish</strong><small>Phones may pause uploads in the background. Received bytes are kept, and uploads resume when you return.</small></div></div><footer class="tc-files-transfer-actions"><button class="tc-btn" type="button" data-transfer-action="cancel-all"${!cancelable.length?raw(' disabled'):''}>Cancel all</button><button class="tc-btn" type="button" data-transfer-action="add">${icon('plus')}Add more</button></footer>`:html`<footer class="tc-tray-foot">${icon('info')}<span>Keep this tab open until uploads finish. Server jobs carry on without it.</span></footer>`}`:''}`;
    };
    const paint=()=>{
      if(frame)return;frame=requestAnimationFrame(()=>{frame=null;const mount=document.getElementById('files-transfers');if(mount)Kit.patch(mount,content());sheet?.render();});
    };
    const content=()=>!visible||!rows.size?'':PHONE.matches?html`<button class="tc-files-transfer-pill" type="button" data-transfer-action="open">${icon(hasUploads()?'upload':'arrow-down-up')}${M.plural(workRows().filter(row=>activeStates.has(row.phase)||['running','queued'].includes(row.phase)).length||rows.size,'transfer')}${workRows().some(row=>['failed','conflict','paused','uncertain'].includes(row.phase))?html`<span class="tc-dot tc-dot--warn"></span>`:''}</button>`:html`<section class="tc-tray" aria-label="Transfers"${dragging?raw(' data-dragging'):''}>${body()}</section>`;
    const openSheet=()=>{if(sheet)return;sheet=Kit.open({kind:'bottom',panel:{class:'tc-sheet tc-sheet--bottom tc-files-transfer-sheet',role:'dialog','aria-label':'Transfers'},render:()=>body(true),onClose:()=>{sheet=null;}});};
    const changed=()=>{paint();clearTimeout(timer);if(rows.size&&visible)timer=setTimeout(tick,1000);};
    const tick=()=>{const finished=workRows().filter(row=>row.finishedAt).sort((a,b)=>b.finishedAt-a.finishedAt);for(const [index,row]of finished.entries())if(index>=100||Date.now()-row.finishedAt>10*60_000){dismissed.add(row.serverId||row.id);rows.delete(row.id);}while(dismissed.size>512)dismissed.delete(dismissed.values().next().value);for(const [path,at]of uploaded)if(Date.now()-at>60_000)uploaded.delete(path);changed();};
    const pump=()=>{if(!visible)return;for(const row of rows.values()){if(active>=3)break;if(!row.file||row.phase!=='queued')continue;active++;row.phase='starting';void upload(row).finally(()=>{active--;changed();pump();});}changed();};
    const pause=row=>{if(row.phase==='finishing')return;row.phase='paused';row.error='Paused. Your received bytes are kept on the server.';row.controller?.abort();changed();};
    const markDone=async(row,result)=>{row.phase='done';row.result=result;row.path=result.path;row.received=row.total;row.sent=row.total;row.skipped=!!result.skipped;row.error='';row.finishedAt=Date.now();if(!result.skipped&&result.path)uploaded.set(result.path,Date.now());await refresh();changed();};
    const wait=(ms,signal)=>new Promise(resolve=>{if(signal.aborted){resolve();return;}const timer=setTimeout(done,ms);function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});});
    const retry=async(row,response)=>{
      if(row.controller.signal.aborted)return false;
      if(response.data?.code==='no-space'){row.phase='failed';row.space=response.data;row.error=row.received?'Stopped at '+M.formatBytes(row.received)+' of '+M.formatBytes(row.total)+'. The disk is full.':'Not enough space for these files';return false;}
      if(response.status!==0&&response.status<500&&response.data?.code!=='busy'){row.phase='failed';row.error=response.error||'This upload could not continue.';return false;}
      row.failedAt??=Date.now();if(Date.now()-row.failedAt>=120_000){pause(row);return false;}
      const delay=response.data?.code==='busy'?5000:[1000,2000,4000,8000,15000][Math.min(4,row.retries||0)];row.retries=(row.retries||0)+1;row.phase='retrying';row.code=response.data?.code;row.error=response.error||'Connection lost. Received bytes are kept.';row.retryAt=Date.now()+delay;changed();await wait(delay,row.controller.signal);return !row.controller.signal.aborted;
    };
    const sync=async row=>{
      const response=await api('/files/jobs');if(!response.ok||!Array.isArray(response.data?.jobs))return false;
      const job=response.data.jobs.find(job=>job.id===row.serverId);if(job?.result?.path){await markDone(row,job.result);return 'done';}
      if(Number.isSafeInteger(job?.received)&&job.received>=0&&job.received<=row.total){row.received=job.received;row.sent=job.received;return true;}
      return false;
    };
    const upload=async row=>{
      row.controller=new AbortController();const signal=row.controller.signal;row.error='';
      try{
        if(!row.serverId){
          while(!signal.aborted){const response=await request('upload/start',{dest:row.dest,items:[{path:row.relative,size:row.file.size,lastModified:row.file.lastModified,directory:row.directory===true}]},{quiet:true,refresh:false});
            if(response.ok&&response.data?.uploads?.[0]){const session=response.data.uploads[0];if(session.directory){await markDone(row,session.result);return;}row.serverId=session.id;rows.delete(session.id);row.received=session.received;row.auth=response.filesAuthorization||{};if(signal.aborted){if(row.cancelWhenReady)await request('upload/cancel',{ids:[row.serverId]},{quiet:true,refresh:false});return;}row.existingRevision=session.conflict?.existing?.revision;if(session.conflict&&!row.choice){row.conflict=session.conflict;row.phase='conflict';return;}break;}
            if(!await retry(row,response))return;
          }
        }
        while(!signal.aborted&&row.received<row.total){
          if(row.auth?.unlock&&context().unlockedRoot!==row.auth.unlock){pause(row);row.error='Editing was locked again. Reopen and unlock this managed folder before resuming.';return;}
          row.phase='uploading';row.error='';row.retryAt=null;changed();let body;
          try{body=await row.file.slice(row.received,row.received+8*1024*1024).arrayBuffer();}catch{row.phase='failed';row.error='The source file could not be read. Choose it again to resume.';return;}
          const offset=row.received,response=await api('/files/upload/chunk?'+new URLSearchParams({id:row.serverId,offset}),{method:'POST',rawBody:body,headers:{'content-type':'application/octet-stream',...(row.auth?.unlock?{'x-t3-files-unlock':row.auth.unlock}:{}),...(row.auth?.confirmed?{'x-t3-files-confirmed':'true'}:{})},signal,onProgress:loaded=>{sample(row,offset+loaded);paint();}});
          if(signal.aborted)return;
          if(response.ok&&Number.isSafeInteger(response.data?.received)&&response.data.received>offset&&response.data.received<=row.total){row.received=response.data.received;sample(row,row.received);row.failedAt=null;row.retries=0;continue;}
          if(response.data?.code==='changed'&&Number.isSafeInteger(response.data.received)&&response.data.received!==offset&&response.data.received>=0&&response.data.received<=row.total){row.received=response.data.received;continue;}
          if(response.status===0||response.status>=500){const checked=await sync(row);if(checked==='done')return;if(checked===true&&row.received!==offset)continue;}
          if(!await retry(row,response))return;
        }
        if(signal.aborted)return;row.phase='finishing';row.error='';changed();
        const response=await request('upload/finish',{id:row.serverId,onConflict:row.choice||'ask',existingRevision:row.existingRevision,...row.auth},{quiet:true,refresh:false});if(signal.aborted)return;
        if(response.ok&&typeof response.data?.path==='string')await markDone(row,response.data);
        else if(['conflicts','stale'].includes(response.data?.code)){row.phase='conflict';row.conflict=response.data.conflicts?.[0]||row.conflict;row.existingRevision=row.conflict?.existing?.revision;row.error='The destination changed. Review what to keep.';}
        else if(response.status===0){const checked=await sync(row);if(checked!=='done'){row.phase='uncertain';row.error='The finish reply was lost. Check the destination; this upload won’t be replayed.';}}
        else{row.phase='failed';row.error=response.error||'This upload could not finish.';}
      }catch(error){if(!signal.aborted){row.phase='failed';row.error=error.message||'The upload was interrupted.';}}
      finally{row.sent=row.received;changed();}
    };
    const enqueue=async(items,{dest=context().path}={})=>{
      if(workRows().filter(row=>row.file&&!['done','cancelled'].includes(row.phase)).length+items.length>20_000){Kit.toast('This selection has too many files',{tone:'danger',detail:'Upload folders in smaller groups of up to 20,000 files.'});return;}
      for(const item of items){const file=item.directory?{name:F.basename(item.relative),size:0,lastModified:0}:item.file||item,relative=item.relative||file.webkitRelativePath||file.name;if(!relative||file.size<0)continue;
        const duplicate=workRows().find(row=>row.file&&row.dest===dest&&row.relative===relative&&row.file.size===file.size&&row.file.lastModified===file.lastModified&&!['done','cancelled'].includes(row.phase));
        if(duplicate){duplicate.file=file;duplicate.phase='queued';duplicate.failedAt=null;duplicate.error='';continue;}
        const id='local_'+crypto.randomUUID();rows.set(id,{id,file,directory:item.directory===true,dest,relative,label:relative,total:file.size,received:0,phase:'queued',samples:[],retries:0});
      }
      folded=false;pump();onActive();
    };
    const resolve=async id=>{
      const first=rows.get(id);if(!first)return;const pending=workRows().filter(row=>row.phase==='conflict'&&row.dest===first.dest).slice(0,100);
      const choices=await dialogs.conflicts({items:pending.map(row=>({name:row.relative,bytes:row.total,...row.conflict})),dest:first.dest,label:'Continue upload'});
      if(!choices)return;
      for(const row of pending){row.choice=choices[row.relative];row.error='';if(row.choice==='skip'){if(row.serverId)await request('upload/cancel',{ids:[row.serverId]},{quiet:true,refresh:false});row.phase='done';row.skipped=true;row.finishedAt=Date.now();}else{row.phase='queued';row.failedAt=null;row.retries=0;}}
      pump();
    };
    const pick=(folder,{dest=context().path,relative}={})=>{
      picker?.remove();picker=document.createElement('input');picker.type='file';picker.multiple=true;picker.hidden=true;if(folder)picker.setAttribute('webkitdirectory','');document.body.appendChild(picker);
      picker.addEventListener('change',()=>{const files=[...picker.files];void enqueue(relative?files.map(file=>({file,relative})):files,{dest});picker.remove();picker=null;},{once:true});picker.click();
    };
    const acceptDrop=async transfer=>{
      const items=[],entries=[...transfer.items].filter(item=>item.kind==='file').map(item=>({entry:item.webkitGetAsEntry?.(),file:item.getAsFile()}));
      const walk=async(entry,prefix='',depth=0)=>{
        if(depth>128||items.length>=20_000)throw new Error('This folder is too large. Upload a smaller group.');
        if(entry.isFile){const file=await new Promise((resolve,reject)=>entry.file(resolve,reject));items.push({file,relative:prefix+file.name});}
        else if(entry.isDirectory){const reader=entry.createReader();let empty=true;while(true){const children=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!children.length)break;empty=false;for(const child of children)await walk(child,prefix+entry.name+'/',depth+1);}if(empty)items.push({directory:true,relative:prefix+entry.name});}
      };
      for(const item of entries)if(item.entry)await walk(item.entry);else if(item.file)items.push({file:item.file,relative:item.file.name});
      if(!entries.length)for(const file of transfer.files)items.push(file);
      return items;
    };
    const jobs=value=>{
      if(!Array.isArray(value))return;
      const owned=new Set(workRows().map(row=>row.serverId));
      for(const job of value){if(job.kind==='measure'||owned.has(job.id))continue;
        const prior=rows.get(job.id);if(dismissed.has(job.id))continue;
        const row={...prior,...job,id:job.id,label:job.label||F.basename(job.path||job.dest||'Server job'),phase:job.kind==='upload'&&!job.result?'paused':job.state,received:job.received,total:job.total,server:true};if(job.result?.path)row.path=job.result.path;
        if(['done','failed','cancelled'].includes(row.phase))row.finishedAt=Date.parse(job.finishedAt)||Date.now();
        if(job.kind==='upload'&&!job.result)row.error='Choose the same source file to resume this upload.';
        rows.set(job.id,row);
      }
      changed();
    };
    const notifyJob=()=>{folded=false;changed();};
    const action=async(name,id)=>{
      const row=rows.get(id);
      if(name==='fold'){if(PHONE.matches){if(sheet)sheet.close('fold');else openSheet();}else folded=!folded;changed();return;}
      if(name==='open'){openSheet();return;}
      if(name==='previous'||name==='next'){transferPage=Math.max(0,transferPage+(name==='next'?1:-1));paint();return;}
      if(name==='add'){pick(false);return;}
      if(name==='free-space'){sheet?.close('space');freeSpace();return;}
      if(name==='cancel-all'){for(const item of workRows())if(!['done','cancelled','uncertain','finishing'].includes(item.phase)&&item.cancellable!==false)await action('cancel',item.id);return;}
      if(!row)return;
      if(name==='pause')pause(row);
      if(name==='retry'){if(!row.file){pick(false,{dest:row.dest,relative:row.relative});return;}row.phase='queued';row.failedAt=null;row.space=null;row.retries=0;row.error='';pump();}
      if(name==='resolve')await resolve(id);
      if(name==='cancel'){
        if(row.phase==='finishing')return;
        if(row.file&&!row.serverId){row.cancelWhenReady=true;row.controller?.abort();row.phase='cancelled';row.finishedAt=Date.now();changed();return;}
        row.controller?.abort();row.phase='cancelled';row.finishedAt=Date.now();changed();
        const response=await request(row.file||row.kind==='upload'?'upload/cancel':'jobs/cancel',row.file||row.kind==='upload'?{ids:[row.serverId||row.id]}:{id:row.id},{quiet:true,refresh:false});if(!response.ok){row.phase='failed';row.error=response.error;}
      }
      if(name==='dismiss'){dismissed.add(id);if(row.serverId)dismissed.add(row.serverId);while(dismissed.size>512)dismissed.delete(dismissed.values().next().value);rows.delete(id);changed();}
      if(name==='show'){sheet?.close('show');go(F.route(row.dest||F.parent(row.path||row.result?.paths?.[0]||context().path),context().roots));}
    };
    document.addEventListener('change',event=>{const id=event.target.dataset.transferExtract,row=id&&rows.get(id);if(!row||row.extractPending||!event.target.checked)return;row.extractPending=true;sheet?.close('extract');changed();void Promise.resolve(extract(row.path,{quick:true})).finally(()=>{row.extractPending=false;changed();});});
    document.addEventListener('click',event=>{const target=event.target.closest('[data-transfer-action]');if(target){event.preventDefault();void action(target.dataset.transferAction,target.dataset.transferId).catch(error=>Kit.toast(error.message||'Transfer action failed',{tone:'danger'}));}});
    document.addEventListener('visibilitychange',()=>{
      if(!PHONE.matches)return;
      if(document.hidden){for(const row of workRows())if(row.file&&activeStates.has(row.phase)&&row.phase!=='finishing'){row.autoPaused=true;pause(row);}}
      else{for(const row of workRows())if(row.autoPaused&&row.phase==='paused'){row.autoPaused=false;row.phase='queued';row.failedAt=null;}pump();onActive();}
    });
    window.addEventListener('beforeunload',event=>{if(hasUploads()){event.preventDefault();event.returnValue='';}});
    const beforeNavigate=async()=>{if(hasUploads()&&!await Kit.confirm({title:'Pause uploads and leave Files?',body:'Received bytes are kept. Resume here, or choose the same source files again after returning.',confirm:'Pause and leave',tone:'primary'}))return false;for(const row of rows.values())if(row.file&&activeStates.has(row.phase))pause(row);return true;};
    return {content:()=>html`<div id="files-transfers" data-key="files-transfers" data-keep>${content()}</div>`,enqueue,pick,acceptDrop,jobs,notifyJob,hasUploads,hasJobs,beforeNavigate,
      setDragging:value=>{if(value&&!dragging){previousFold=folded;folded=true;}if(!value&&dragging)folded=previousFold;dragging=value;paint();},isUploaded:path=>Date.now()-(uploaded.get(path)||0)<60_000,
      activate:()=>{visible=true;paint();pump();},hide:()=>{visible=false;sheet?.close('route');sheet=null;paint();}};
  };
  return {create};
})();
