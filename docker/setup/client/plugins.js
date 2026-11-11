// Plugins share the Skills visual language, while package ownership and native
// lifecycle stay separate. Opening this library performs passive reads only.
const T3PluginsUI = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const off = value => value ? raw(' disabled') : '';
  const names = {codex:'Codex',claude:'Claude Code',opencode:'OpenCode',cursor:'Cursor',grok:'Grok Build',muse:'Muse Code',pi:'Pi',antigravity:'Antigravity'};
  const mark = id => html`<span class="tc-tile tc-tile--mark tc-tile--xs" aria-hidden="true">${raw(T3C.agentMark(id))}</span>`;
  const create = ({api,getStatus,render,reviewHooks}) => {
    let data=null,error=null,loading=false,started=false,query='',provider='',active=null,section='all',scannedAt=null;
    const checks = new Map(), collapsed = new Set();
    let checking=false, cardView=false, showAll=false, unified=false, hideBundled=false;
    try { cardView=localStorage.getItem('t3-console-plugin-view')==='cards'; showAll=localStorage.getItem('t3-console-plugin-columns')==='all'; unified=localStorage.getItem('t3-console-plugin-unified')==='true'; hideBundled=localStorage.getItem('t3-console-plugin-hide-bundled')==='true'; } catch {}
    const remember=(key,value)=>{try{localStorage.setItem('t3-console-plugin-'+key,String(value));}catch{}};
    const installed=()=>Object.keys(names).filter(id=>getStatus?.()?.harnesses?.some(h=>h.id===id&&h.installed)||(data?.plugins||[]).some(p=>p.provider===id));
    const columns=()=>Object.keys(names).filter(id=>showAll||installed().includes(id));
    const attention=row=>row.status&&row.status!=='installed';
    const paint=()=>render();
    const load=async()=>{
      if(loading)return;
      started=true;loading=true;error=null;paint();
      try{const response=await api('/context/plugins');if(response.ok){data=response.data;scannedAt=Date.now();}else error=response.error;}
      catch(e){error=e.message||'The connection was interrupted.';}
      finally{loading=false;paint();}
    };
    const call=async(route,body)=>{
      const response=await api('/context/plugins/'+route,{body});
      if(!response.ok)throw Error(response.error||'The plugin operation failed.');
      return response.data;
    };
    const close=()=>{
      if(active?.pending){Kit.announce('Wait for the plugin operation to finish');return false;}
      active?.layer.close();return true;
    };
    const badge=row=>row.status&&row.status!=='installed'?'Needs attention':row.stateCoverage==='discovery-links'&&typeof row.enabled==='boolean'?(row.enabled?'Registered':'Not registered'):row.enabled===true?(row.stateCoverage==='user-settings'?'On in user settings':'Enabled'):row.enabled===false?(row.stateCoverage==='user-settings'?'Off in user settings':'Disabled'):'Found on disk';
    const open=(row,operation=null)=>{
      if(!close())return;
      const view={row,plan:null,result:null,error:null,pending:false,layer:null,closed:false};active=view;
      const alive=()=>active===view&&!view.closed;
      const draw=()=>{if(alive())view.layer.render();};
      const title=()=>view.result?'Plugin operation':view.plan?({install:'Review installation',update:'Review update',state:'Review plugin setting',remove:'Review removal',reconcile:'Check installation'}[view.plan.operation]):view.row?view.row.name:'Add plugin';
      const agentName=names[row?.provider]||'Codex';
      const labels={install:'Install for '+agentName,update:'Update for '+agentName,state:'Save plugin setting',remove:'Remove from '+agentName,reconcile:'Check installation'};
      const safe=task=>async()=>{
        if(view.pending)return;view.error=null;view.pending=true;draw();
        try{await task();}catch(e){if(alive())view.error=e.message;}
        finally{view.pending=false;draw();}
      };
      const plan=async args=>{view.plan=await call('plan',args);};
      const apply=safe(async()=>{
        const result=await call('apply',{planId:view.plan.planId});
        // The server job survives a sheet navigation or a lost apply response.
        for(let i=0;i<360;i++){
          const response=await api('/context/plugins/job?id='+encodeURIComponent(result.jobId));
          if(!response.ok)throw Error(response.error+' Refresh the library before retrying.');
          if(response.data.state!=='running'){
            view.result=response.data;
            if(response.data.state==='failed')view.error=response.data.error;
            await load();return;
          }
          await new Promise(resolve=>setTimeout(resolve,500));
        }
        throw Error('This job is taking longer than expected. Refresh to inspect its current state before retrying.');
      });
      const manifest=p=>html`<p>${p.description||'No description provided.'}</p><dl class="tc-plugin-facts"><dt>Agent</dt><dd>${names[p.provider]||agentName} · Personal, in this container</dd><dt>Source</dt><dd>${p.source||''}</dd><dt>Revision</dt><dd><code>${p.commit||p.digest||'Local snapshot'}</code></dd><dt>Version</dt><dd>${p.version||'Not declared'}</dd></dl>`;
      const components=p=>html`<div class="tc-plugin-components">${(p.components||[]).map(c=>html`<span class="tc-badge">${c.type}: ${c.name}</span>`)}</div>`;
      const review=p=>html`${manifest(p)}${components(p)}<div class="tc-notice tc-notice--warn"><div class="tc-notice-body"><strong>Review what will change</strong><ul>${p.effects.map(effect=>html`<li>${effect}</li>`)}</ul></div></div>${(p.blocked||[]).map(reason=>html`<p class="tc-notice tc-notice--danger" role="alert">${reason}</p>`)}${(p.hooks||[]).length?html`<h3>Automatic commands</h3><p class="tc-hint">${row.provider==='codex'?'Codex hooks need separate trust. Review their exact definitions before turning them on.':'This agent may run these hooks automatically in a new session. Review every command and its access before applying.'}</p>${p.hooks.map(h=>html`<div><strong>${h.event}</strong><pre class="tc-code tc-plugin-code" tabindex="0">${h.command||'Review this '+h.handlerType+' hook in the native agent.'}</pre></div>`)}`:''}<details><summary>${p.files.length} package files${p.changes?' · '+p.changes.filter(f=>f.status!=='unchanged').length+' changed':''}</summary><ul class="tc-plugin-file-list">${p.files.map(f=>html`<li><details><summary><code>${f.name}</code><span>${p.changes?.find(c=>c.name===f.name)?.status||''} ${T3Model.formatBytes(f.bytes)}${f.executable?' · executable':''}</span></summary>${p.changes?.find(c=>c.name===f.name)?.beforeText?html`<p class="tc-hint">Installed version</p><pre class="tc-code tc-plugin-code" tabindex="0">${p.changes.find(c=>c.name===f.name).beforeText}</pre><p class="tc-hint">Incoming version</p>`:''}${typeof f.text==='string'?html`<pre class="tc-code tc-plugin-code" tabindex="0">${f.text}</pre>`:html`<p class="tc-hint">Text preview unavailable for this binary or large file.</p>`}</details></li>`)}</ul>${p.changes?.filter(f=>f.status==='removed').map(f=>html`<details><summary><code>${f.name}</code> removed</summary>${typeof f.beforeText==='string'?html`<p class="tc-hint">Installed version · will be removed</p><pre class="tc-code tc-plugin-code" tabindex="0">${f.beforeText}</pre>`:html`<p class="tc-hint">Text preview unavailable for this binary or large file.</p>`}</details>`)||''}</details>`;
      const body=()=>view.result?html`<div class="tc-empty"><span class="tc-empty-icon">${icon(view.result.state==='succeeded'?'check':'triangle-alert')}</span><span class="tc-empty-title">${view.result.state==='succeeded'?'Saved for '+agentName:'The operation needs attention'}</span><span class="tc-empty-desc">${view.result.message||view.result.error}</span></div><p class="tc-hint">${row.provider==='opencode'?'OpenCode can load or reload changes in running sessions.':'Start a new '+agentName+' session after changing plugins.'} Native permissions and service sign-in remain separate.</p>`
        :view.plan?review(view.plan)
        :html`<p>${view.row.description||'This package was found on disk.'}</p><dl class="tc-plugin-facts"><dt>Agent</dt><dd>${names[view.row.provider]||view.row.provider}</dd><dt>Scope</dt><dd>Personal · this container</dd><dt>Source</dt><dd>${view.row.source||'Native agent files'}</dd><dt>Status</dt><dd>${badge(view.row)}${view.row.enabled===null||view.row.stateCoverage==='discovery-links'?' · loading is not verified':''}</dd><dt>Version</dt><dd>${view.row.version||'Not declared'}</dd>${view.row.path?html`<dt>Location</dt><dd><code>${view.row.path}</code></dd>`:''}</dl>${components(view.row)}<p class="tc-hint">${view.row.owned?'Setup owns this repository snapshot. Updates are reviewed manually; runtime dependencies are not installed.':view.row.readOnlyReason||'Manage this package through its native agent. Setup has not verified a safe lifecycle interface for this installation.'}</p>${view.row.status&&view.row.status!=='installed'?html`<p class="tc-notice tc-notice--warn">A previous operation did not complete. Inspect the native agent before retrying.</p>`:''}`;
      view.layer=Kit.open({kind:'sheet',returnTo:document.activeElement,panel:{class:'tc-sheet tc-sheet--inset tc-plugin-sheet',role:'dialog','aria-modal':'true','aria-labelledby':'plugin-title'},focus:'[data-plugin-close]',backdrop:'ignore',onEscape:close,onClose:()=>{view.closed=true;if(active===view)active=null;for(const id of [view.plan?.planId])if(id)void call('discard',{planId:id}).catch(()=>{});},render:()=>html`<div class="tc-insp-head"><span class="tc-tile tc-tile--icon">${icon('puzzle')}</span><div class="tc-insp-title"><h2 id="plugin-title">${title()}</h2><div class="tc-insp-meta">${view.row?names[view.row.provider]:'Reviewed repository snapshot'}</div></div><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-plugin-close aria-label="Close plugin inspector"${off(view.pending)}>${icon('x')}</button></div><div class="tc-insp-body tc-plugin-body" aria-busy="${String(view.pending)}">${view.error?html`<p class="tc-notice tc-notice--danger" role="alert">${view.error}</p>`:''}${body()}</div><div class="tc-sheet-foot">${view.pending?html`<span class="tc-hint" role="status"><span class="tc-spinner"></span> ${view.plan?'Working…':'Reading source…'}</span>`:''}<span class="tc-spacer"></span>${!view.result&&view.row&&!view.plan?html`${view.row.provider==='codex'?html`<button class="tc-btn" type="button" data-plugin-hooks${off(view.pending)}>Review hooks</button>`:''}${view.row.owned&&view.row.status!=='installed'?html`<button class="tc-btn" type="button" data-plugin-operation="reconcile"${off(view.pending)}>Check installation</button>`:''}${view.row.owned&&view.row.status==='installed'?html`<button class="tc-btn" type="button" data-plugin-operation="update"${off(view.pending)}>Review update</button><button class="tc-btn" type="button" data-plugin-operation="state"${off(view.pending||view.row.enabled===null||view.row.capabilities?.state===false)}>${view.row.enabled?'Disable':'Enable'}</button><button class="tc-btn tc-btn--danger" type="button" data-plugin-operation="remove"${off(view.pending)}>Remove…</button>`:''}`:''}${view.plan&&!view.result?html`<button class="tc-btn" type="button" data-plugin-back${off(view.pending)}>Back</button><button class="tc-btn ${view.plan.operation==='remove'?'tc-btn--danger':'tc-btn--primary'}" type="button" data-plugin-apply${off(view.pending||!view.plan.canApply)}>${labels[view.plan.operation]||'Apply'}</button>`:''}<button class="tc-btn tc-btn--ghost" type="button" data-plugin-close${off(view.pending)}>Done</button></div>`});
      if(operation)void safe(()=>plan({id:row.id,revision:row.revision,operation,enabled:!row.enabled}))();
      view.layer.panel.addEventListener('click',e=>{
        const b=e.target.closest('button');if(!b||b.disabled)return;
        if(b.hasAttribute('data-plugin-close'))close();
        else if(b.hasAttribute('data-plugin-operation'))void safe(()=>plan({id:view.row.id,revision:view.row.revision,operation:b.dataset.pluginOperation,enabled:!view.row.enabled}))();
        else if(b.hasAttribute('data-plugin-apply'))void apply();
        else if(b.hasAttribute('data-plugin-back')){const id=view.plan.planId;view.plan=null;void call('discard',{planId:id}).catch(()=>{});draw();}
        else if(b.hasAttribute('data-plugin-hooks')){const id=view.row.nativeId;close();reviewHooks(id);}
      });
    };
    const install = (options={}) => {
      if(!close())return;
      const view={source:options.source||'',preview:null,prefix:null,provider:options.provider||'',plans:[],result:null,error:null,pending:false,step:1,selected:new Set(),agents:new Set(options.provider?[options.provider]:[]),queue:[],completed:[],retryInstall:false,consent:false,closed:false,layer:null,railOpen:!Kit.isPhone()};
      active=view;
      const draw=(step=false)=>{if(view.closed)return;view.layer.render();if(step){const main=view.layer.panel.querySelector('.tc-wizard-main');main.scrollTop=0;const heading=main.querySelector('h3')||main;heading.tabIndex=-1;heading.focus({preventScroll:true});}};
      const chosen=()=>view.preview?.packages.find(p=>p.prefix===view.prefix);
      const selected=()=>(view.preview?.packages||[]).filter(p=>view.selected.has(p.prefix));
      const support=(pkg,id)=>pkg?.providers?.find(p=>p.id===id)||{id,detected:false,compatible:false,reason:'This source has no detected integration for this agent.'};
      const compatible=id=>selected().length>0&&selected().every(p=>support(p,id).compatible);
      const resetQueue=()=>{view.queue=[];};
      const dispose=id=>{if(id)void call('discard',{planId:id}).catch(()=>{});};
      const invalidate=()=>{for(const entry of view.plans)dispose(entry.plan?.planId);view.plans=[];view.consent=false;view.result=null;};
      const safe=task=>async()=>{if(view.pending)return;const previousStep=view.step;view.pending=true;view.error=null;draw();try{await task();}catch(e){if(!view.closed)view.error=e.message;}finally{view.pending=false;draw(view.step!==previousStep);}};
      const readSource=safe(async()=>{
        invalidate();dispose(view.preview?.previewId);view.preview=null;view.prefix=null;view.selected.clear();resetQueue();view.step=1;
        const response=await call('source',{source:view.source.trim()});
        if(view.closed){dispose(response.previewId);return;}
        view.preview=response;
        if(response.packages.length===1){view.prefix=response.packages[0].prefix;view.selected.add(view.prefix);}
      });
      const buildQueue=()=>{view.queue=selected().flatMap(p=>[...view.agents].map(provider=>({prefix:p.prefix,provider})));};
      const planAll=safe(async()=>{
        for(const entry of view.plans)dispose(entry.plan?.planId);
        view.plans=[];view.consent=false;view.result=null;view.completed=[];
        if(!view.queue.length)buildQueue();
        if(!view.queue.length)throw Error('Choose at least one compatible agent.');
        if(![...view.agents].every(compatible))throw Error('One selected agent has no compatible package. Deselect it to continue.');
        for(const target of view.queue){
          try{
            const plan=await call('plan',{previewId:view.preview.previewId,prefix:target.prefix,provider:target.provider});
            if(view.closed){dispose(plan.planId);return;}
            view.plans.push({...target,plan});
          }catch(e){view.plans.push({...target,error:e.message});}
          draw();
        }
        const first=view.plans.find(entry=>entry.plan);
        if(first){view.prefix=first.prefix;view.provider=first.provider;}
      });
      const runAll=safe(async()=>{
        view.retryInstall=true;
        const display=view.plans.map(entry=>({...entry}));
        for(const entry of display)if(entry.plan)void call('discard',{planId:entry.plan.planId}).catch(()=>{});
        view.plans=[];view.completed=[];
        const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
        for(const target of view.queue){
          try{
            const plan=await call('plan',{previewId:view.preview.previewId,prefix:target.prefix,provider:target.provider});
            if(view.closed){dispose(plan.planId);return;}
            const prev=display.find(entry=>entry.prefix===target.prefix&&entry.provider===target.provider)?.plan;
            if(prev&&!same([prev.digest,prev.canApply,prev.blocked,prev.effects],[plan.digest,plan.canApply,plan.blocked,plan.effects]))throw Error('Changed since review for '+names[target.provider]+'. Review again.');
            if(!plan.canApply)throw Error((plan.blocked||[]).join(' ')||('Not installable for '+names[target.provider]));
            const response=await call('apply',{planId:plan.planId});
            let settled=null;
            for(let i=0;i<360;i++){
              const status=await api('/context/plugins/job?id='+encodeURIComponent(response.jobId));
              if(!status.ok)throw Error(status.error+' Retry this same reviewed operation to recover its result.');
              if(status.data.state!=='running'){settled=status.data;break;}
              await new Promise(resolve=>setTimeout(resolve,500));
            }
            if(!settled)throw Error('The job is still running. Retry this same plan to recover its result.');
            view.completed.push({name:plan.name,prefix:target.prefix,provider:target.provider,state:settled.state,message:settled.message||settled.error,digest:plan.digest});
            if(settled.state!=='succeeded')throw Error(settled.error||('Install failed for '+names[target.provider]));
          }catch(e){
            if(!view.completed.some(entry=>entry.provider===target.provider&&entry.prefix===target.prefix))view.completed.push({name:view.preview?.packages.find(p=>p.prefix===target.prefix)?.name||target.prefix||target.provider,prefix:target.prefix,provider:target.provider,state:'failed',message:e.message});
            view.error=e.message;
          }
          draw();
        }
        view.retryInstall=false;
        const ok=view.completed.length>0&&view.completed.every(entry=>entry.state==='succeeded');
        const agentList=[...new Set(view.completed.filter(entry=>entry.state==='succeeded').map(entry=>names[entry.provider]))].join(', ');
        view.result={state:ok?'succeeded':'failed',message:ok?'Installed for '+agentList:'Some installations need attention.',error:ok?null:view.error};
        view.step=3;
        await load();
        for(const entry of view.completed){
          if(entry.state!=='succeeded'||entry.provider!=='codex'||entry.nativeId)continue;
          const row=(data?.plugins||[]).find(p=>p.provider==='codex'&&p.owned&&p.digest===entry.digest&&p.nativeId);
          if(row)entry.nativeId=row.nativeId;
        }
      });
      const packageFiles=p=>html`<details class="tc-plugin-files"><summary>${p.files?.length||0} package files</summary><ul class="tc-plugin-file-list">${(p.files||[]).map(f=>html`<li><details><summary><code>${f.name}</code><span>${T3Model.formatBytes(f.bytes)}${f.executable?' · executable':''}</span></summary>${typeof f.text==='string'?html`<pre class="tc-code tc-plugin-code" tabindex="0">${f.text}</pre>`:html`<p class="tc-hint">Text preview unavailable for this binary or large file.</p>`}</details></li>`)}</ul></details>`;
      const integrations=p=>{
        const found=(p.providers||[]).filter(a=>a.detected||a.compatible),ready=found.filter(a=>a.compatible),manual=found.filter(a=>!a.compatible);
        const chips=agents=>html`<div class="tc-plugin-components">${agents.map(a=>html`<span class="tc-badge" title="${a.reason||a.format||''}">${names[a.id]}${a.experimental?' · Experimental':''}</span>`)}</div>`;
        return html`${ready.length?html`<span class="tc-hint">Install with Setup</span>${chips(ready)}`:''}${manual.length?html`<span class="tc-hint">Other detected integrations · native setup required</span>${chips(manual)}${p.files?.some(f=>/^readme(?:\.md)?$/i.test(f.name))?html`<span class="tc-hint">Check the package README below for native setup.</span>`:''}`:''}`;
      };
      const sourcePicker=()=>html`<div class="tc-source"><label class="tc-label" for="plugin-source">Repository or container folder</label><div class="tc-source-input">${icon('link')}<input class="tc-input" id="plugin-source" data-key="plugin-source" value="${view.source}" placeholder="https://github.com/microsoft/TokenEconomizer" maxlength="2048" autocapitalize="none" spellcheck="false"${off(view.pending)}><button class="tc-btn tc-btn--sm" type="button" data-plugin-read${off(view.pending||!view.source.trim())}>${view.preview?'Read again':'Read'}</button></div><p class="tc-hint">Public GitHub repositories and absolute folders in this container. Reading a source never runs its plugin code.</p></div>
        ${view.preview?html`<div class="tc-source-found">${icon('check')}<strong>Source read</strong><code>${view.preview.source}</code><span>· ${T3Model.plural(view.preview.packages.length,'plugin')}</span></div><div class="tc-picklist"><div class="tc-picklist-head"><span class="tc-hint">Choose complete packages</span></div><div class="tc-picklist-body">${view.preview.packages.map((p,i)=>html`<div class="tc-pick tc-plugin-pick" data-key="plugin-pick-${i}"><input class="tc-checkbox" id="plugin-pick-${i}" type="checkbox" data-plugin-pick="${p.prefix}"${view.selected.has(p.prefix)?raw(' checked'):''}${off(view.pending)}><div><label class="tc-pick-name" for="plugin-pick-${i}">${p.name}</label><p class="tc-pick-desc">${p.description||'No description provided.'}</p><span class="tc-hint">${T3Model.plural(p.files?.length||0,'file')} · ${p.version||'Version not declared'} · ${p.prefix||'Repository root'}</span>${integrations(p)}${packageFiles(p)}</div></div>`)}</div></div>`:html`<div class="tc-empty"><span class="tc-empty-icon">${icon('puzzle')}</span><span class="tc-empty-title">Install a complete plugin</span><span class="tc-empty-desc">Choose a package, choose its agent, then review every change. Skill folders alone belong in Skills.</span></div>`}`;
      const reviewAll=()=>{
        const allOk=view.plans.length>0&&view.plans.every(entry=>entry.plan&&entry.plan.canApply);
        const needsCodex=view.plans.some(entry=>entry.provider==='codex'&&entry.plan);
        const needsOpenCode=view.plans.some(entry=>entry.provider==='opencode'&&entry.plan);
        return html`${view.plans.map(entry=>{
          if(entry.error||!entry.plan)return html`<section class="tc-insp-section"><h3 class="tc-step-title">Review installation for ${names[entry.provider]}</h3><p class="tc-notice tc-notice--danger" role="alert">${entry.error||'Could not review this destination.'}</p></section>`;
          const p=entry.plan;
          return html`<section class="tc-insp-section"><h3 class="tc-step-title">Review installation for ${names[p.provider]}</h3><p class="tc-hint">${p.description||''}</p><div class="tc-notice tc-notice--warn"><div class="tc-notice-body"><strong>What will change</strong><ul>${p.effects.map(effect=>html`<li>${effect}</li>`)}</ul></div></div>${(p.blocked||[]).map(reason=>html`<p class="tc-notice tc-notice--danger" role="alert">${reason}</p>`)}<div class="tc-plugin-components">${(p.components||[]).map(c=>html`<span class="tc-badge">${c.type}: ${c.name}</span>`)}</div>${p.hooks?.length?html`<h4>Automatic commands</h4>${p.hooks.map(h=>html`<div><strong>${h.event}</strong><pre class="tc-code tc-plugin-code" tabindex="0">${h.command||'Native '+h.handlerType+' hook'}</pre></div>`)}`:''}${packageFiles(p)}</section>`;
        })}<label class="tc-import-consent"><input class="tc-checkbox" type="checkbox" data-plugin-consent${view.consent?raw(' checked'):''}${off(view.pending||!allOk)}><span><strong>I reviewed ${view.plans.length>1?'these plugins and their code access':'this plugin and its code access'} for ${view.plans.map(entry=>names[entry.provider]).join(', ')}</strong><span class="tc-hint">${needsCodex?'Codex hooks still need separate trust. ':''}${needsOpenCode?'OpenCode may immediately load or reload this module, including in running sessions. ':''}${!needsCodex&&!needsOpenCode?'Hooks and extensions may run automatically in a new session. ':''}Plugin code can access this container’s projects, home files and network.</span></span></label></section>`;
      };
      const agentPicker=()=>html`<div class="tc-import-step-head"><div><h3 class="tc-step-title">Which agents get these plugins?</h3><p class="tc-hint">Each agent needs its own package format and permissions. Choose agents now; one review covers all, one install does them all.</p></div></div><div class="tc-group tc-route-list">${Object.entries(names).map(([id,name])=>{
        const capability={compatible:compatible(id),detected:selected().every(p=>{const a=support(p,id);return a.detected||a.compatible;})}, reason=selected().map(p=>support(p,id).reason||support(p,id).format||'Native package').filter((r,i,a)=>a.indexOf(r)===i).join(' ');
        return html`<label class="tc-route-row"${!view.agents.has(id)?raw(' data-off'):''}><input class="tc-checkbox" type="checkbox" data-plugin-agent="${id}"${view.agents.has(id)?raw(' checked'):''}${off(view.pending||view.retryInstall||!capability.compatible)}>${mark(id)}<span class="tc-row-main"><span class="tc-avail-name">${name}</span><span class="tc-avail-note">${!installed().includes(id)?'Not detected. ':''}${reason}</span></span>${!capability.compatible?html`<span class="tc-badge">${capability.detected?'Native setup':'No integration'}</span>`:''}</label>`;
      })}</div>${view.queue.length?html`<p class="tc-hint">${view.queue.length} ${view.queue.length===1?'destination':'destinations'}: ${view.queue.map(target=>names[target.provider]).join(', ')}.</p>`:''}${view.plans.length?reviewAll():html`<p class="tc-hint">Choose available agents, then review every destination and permission change together.</p>`}`;
      const verifyFor=(provider,pluginNames)=>{
        const [first]=pluginNames;
        if(provider==='codex')return 'Start a new Codex session, trust hooks when asked, then run the plugin’s slash commands'+(first?' (for example, $'+first+':status — the package README lists its exact commands)':' (the package README lists its exact commands)')+'.';
        if(provider==='claude')return 'Start a new Claude Code session, then run the plugin’s slash commands'+(first?' (for example, /'+first+':… — the package README lists its exact commands)':' (the package README lists its exact commands)')+'.';
        if(provider==='opencode')return 'OpenCode has no plugin commands in its UI. Restart OpenCode if it has not reloaded the module, then check the package README for terminal commands.';
        if(provider==='pi')return 'Start a new Pi session and use the package’s commands (the package README lists exact names).';
        if(provider==='cursor')return 'Reload Cursor and check the plugin in Customize; the package README lists status commands.';
        if(provider==='grok')return 'Start a new Grok session; the package README lists status commands.';
        if(provider==='antigravity')return 'Rebuild the bundle if needed; the package README lists status commands.';
        return 'Start a new '+names[provider]+' session to use this plugin.';
      };
      const resultPage=()=>{
        const ok=view.completed.length>0&&view.completed.every(entry=>entry.state==='succeeded');
        const total=view.queue.length||view.completed.length||1;
        const agentList=[...new Set(view.completed.map(entry=>names[entry.provider]))].join(', ');
        const succeededByAgent=[...new Set(view.completed.filter(entry=>entry.state==='succeeded').map(entry=>entry.provider))].map(id=>({id,plugins:[...new Set(view.completed.filter(entry=>entry.state==='succeeded'&&entry.provider===id).map(entry=>entry.name||entry.prefix))]}));
        return html`<div class="tc-result-hero" data-state="${ok?'ok':'partial'}"><span class="tc-result-mark">${icon(ok?'check':'triangle-alert')}</span><div><h3>${ok?(view.completed.length===1?'Installed for '+names[view.completed[0].provider]:'Installed for '+agentList):'Installation needs attention'}</h3><p class="tc-hint">${ok?'Installed '+view.completed.length+' of '+total+'.':(view.result?.message||view.result?.error||view.error||'Some installations need attention.')}</p></div></div><ul class="tc-plan-list">${view.completed.map(r=>html`<li>${mark(r.provider)}${r.name} · ${names[r.provider]}<span class="tc-plan-end">${r.state==='succeeded'?'Installed':'Needs attention'}</span>${r.message&&r.state!=='succeeded'?html`<span class="tc-hint">${r.message}</span>`:''}</li>`)}</ul>${succeededByAgent.length?html`<div class="tc-notice tc-notice--info"><div class="tc-notice-body"><strong>Check it works</strong><ul>${succeededByAgent.map(({id,plugins})=>html`<li><strong>${names[id]}:</strong> ${verifyFor(id,plugins)}</li>`)}</ul>Service sign-in and native permissions remain separate.</div></div>`:''}${view.completed.some(entry=>entry.state==='succeeded'&&entry.provider==='codex'&&entry.nativeId)?html`<p class="tc-hint">Codex runs hooks only after their exact definitions are trusted. This never happens automatically: ${view.completed.filter(entry=>entry.state==='succeeded'&&entry.provider==='codex'&&entry.nativeId).map(entry=>html`<button class="tc-btn tc-btn--sm" type="button" data-plugin-trust-hooks="${entry.nativeId}">Review hooks for ${entry.name}</button>`)}</p>`:''}`;
      };
      const rail=()=>html`<div class="tc-plan-source"><span class="tc-plan-label">Source</span><code>${view.preview?.source||view.source||'Choose a source'}</code>${view.preview?.commit?html`<span class="tc-hint">Snapshot ${view.preview.commit.slice(0,7)}</span>`:''}</div><div class="tc-plan-section"><span class="tc-plan-label">Packages</span><strong>${selected().map(p=>p.name+' ('+(p.prefix||'root')+')').join(', ')||'Choose plugins'}</strong><span class="tc-hint">${chosen()?.version||''}</span></div><div class="tc-plan-section"><span class="tc-plan-label">Agents</span>${view.agents.size?html`${[...view.agents].map(id=>html`<span class="tc-plugin-agent-label">${mark(id)}${names[id]}</span>`)}`:html`<span class="tc-hint">Choose on the next step</span>`}<p class="tc-plan-note">Personal · this container</p></div><p class="tc-plan-note tc-plan-bottom">The reviewed snapshot is held for 10 minutes. Nothing is installed until you approve the exact plan. Plugin packages keep their provider’s native format.</p>`;
      const next=async()=>{
        if(view.pending)return;
        if(view.step===1&&view.selected.size){
          view.step=2;view.error=null;
          view.agents=new Set([...view.agents].filter(compatible));
          if(!view.agents.size){const initial=Object.keys(names).find(id=>compatible(id)&&installed().includes(id))||Object.keys(names).find(compatible);if(initial)view.agents.add(initial);}
          buildQueue();draw(true);return;
        }
        if(view.step===2&&!view.plans.length&&view.agents.size&&[...view.agents].every(compatible))return planAll();
        if(view.step===2&&view.plans.length&&view.consent&&view.plans.every(entry=>entry.plan&&entry.plan.canApply))return runAll();
      };
      const beforeUnload=e=>{if(view.pending){e.preventDefault();e.returnValue='';}};
      view.layer=Kit.open({kind:'center',returnTo:document.activeElement,panel:{class:'tc-wizard tc-skill-import tc-plugin-import'+(Kit.isPhone()?' tc-sheet--bottom':''),role:'dialog','aria-modal':'true','aria-labelledby':'plugin-install-title'},focus:'#plugin-source',backdrop:'ignore',onEscape:close,onClose:()=>{view.closed=true;if(active===view)active=null;dispose(view.preview?.previewId);for(const entry of view.plans)dispose(entry.plan?.planId);window.removeEventListener('beforeunload',beforeUnload);},render:()=>html`<div class="tc-wizard-head"><span class="tc-tile tc-tile--icon tc-tile--lg">${icon('download')}</span><div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="plugin-install-title">Install from source</h2><span class="tc-small tc-muted">Complete plugins, with their skills, tools and hooks.</span></div><ol class="tc-steps" aria-label="Installation steps">${['Plugins','Agents','Install'].flatMap((label,i)=>[i?html`<li class="tc-step-line"${view.step>i?raw(' data-done'):''} aria-hidden="true"></li>`:'',html`<li class="tc-step" data-state="${view.step===i+1?'active':view.step>i+1?'done':'pending'}"${view.step===i+1?raw(' aria-current="step"'):''}><span class="tc-step-mark">${view.step>i+1?icon('check'):i+1}</span><span>${label}</span></li>`])}</ol><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-plugin-exit aria-label="Close plugin installation"${off(view.pending)}>${icon('x')}</button></div><div class="tc-wizard-grid"><div class="tc-wizard-main" aria-busy="${String(view.pending)}">${view.error?html`<p class="tc-notice tc-notice--danger" role="alert">${view.error}</p>`:''}${view.step===1?sourcePicker():view.step===2?agentPicker():resultPage()}${view.pending?html`<p class="tc-hint" role="status"><span class="tc-spinner"></span>${view.step===3||view.retryInstall?'Applying the reviewed operations…':'Reading package information…'}</p>`:''}</div><div class="tc-wizard-rail-wrap"${view.railOpen?raw(' data-open'):''}><button class="tc-wizard-rail-toggle" type="button" data-plugin-rail aria-controls="plugin-install-plan" aria-expanded="${String(view.railOpen)}">Install plan${icon('chevron-down')}</button><aside class="tc-wizard-rail" id="plugin-install-plan" aria-label="Install plan">${rail()}</aside></div></div><div class="tc-wizard-foot">${view.step===3?html`<button class="tc-btn" type="button" data-plugin-another${off(view.pending)}>Install for another agent</button><span class="tc-spacer"></span><button class="tc-btn tc-btn--primary" type="button" data-plugin-exit>Done</button>`:html`<span class="tc-hint tc-wizard-keyboard">${view.step===1?'Choose packages to continue':'Review permissions before installing'}</span><span class="tc-spacer"></span>${view.step===2?html`<button class="tc-btn" type="button" data-plugin-previous${off(view.pending||view.retryInstall)}>Back</button>`:html`<button class="tc-btn tc-btn--ghost" type="button" data-plugin-exit${off(view.pending)}>Close</button>`}<button class="tc-btn tc-btn--primary" type="button" data-plugin-next${off(view.pending||(view.step===1?!view.selected.size:view.plans.length?(!view.consent||!view.plans.every(entry=>entry.plan&&entry.plan.canApply)):(!view.agents.size||![...view.agents].every(compatible))))}>${view.step===1?'Choose agents':view.plans.length?('Install '+view.queue.length+' plugin'+(view.queue.length===1?'':'s')):'Review '+(view.queue.length||selected().length*view.agents.size||'')+' installation'+((view.queue.length||selected().length*view.agents.size)===1?'':'s')}</button>`}</div>`});
      window.addEventListener('beforeunload',beforeUnload);
      view.layer.panel.addEventListener('input',e=>{
        if(e.target.id==='plugin-source'){view.source=e.target.value;invalidate();dispose(view.preview?.previewId);view.preview=null;view.prefix=null;view.selected.clear();resetQueue();draw();}
      });
      view.layer.panel.addEventListener('change',e=>{
        if(view.pending)return;
        if(e.target.hasAttribute('data-plugin-pick')){const prefix=e.target.getAttribute('data-plugin-pick');e.target.checked?view.selected.add(prefix):view.selected.delete(prefix);invalidate();resetQueue();}
        if(e.target.hasAttribute('data-plugin-agent')){const id=e.target.getAttribute('data-plugin-agent');e.target.checked?view.agents.add(id):view.agents.delete(id);invalidate();resetQueue();}
        if(e.target.hasAttribute('data-plugin-consent'))view.consent=e.target.checked;
        draw();
      });
      view.layer.panel.addEventListener('click',e=>{
        const b=e.target.closest('button');if(!b||b.disabled)return;
        if(b.hasAttribute('data-plugin-exit'))close();
        else if(b.hasAttribute('data-plugin-trust-hooks')){const nativeId=b.getAttribute('data-plugin-trust-hooks');close();reviewHooks(nativeId);}
        else if(b.hasAttribute('data-plugin-rail')){view.railOpen=!view.railOpen;draw();}
        else if(b.hasAttribute('data-plugin-read'))void readSource();
        else if(b.hasAttribute('data-plugin-next'))void next();
        else if(b.hasAttribute('data-plugin-previous')){invalidate();resetQueue();view.step=1;view.error=null;draw(true);}
        else if(b.hasAttribute('data-plugin-another')){invalidate();resetQueue();view.completed=[];view.agents.clear();view.step=2;view.error=null;draw(true);}
      });
      view.layer.panel.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.id==='plugin-source'){e.preventDefault();void readSource();}else if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();void next();}});
      if(options.source)void readSource();
    };
    const physical=()=>data?.plugins||[];
    // Curated provenance is a browsing filter, not a trust or installation claim.
    const bundled=row=>!row.owned&&(row.scope==='system'||row.bundled===true||row.provider==='codex'&&row.nativeId?.endsWith('@openai-curated-remote'));
    const visibleRows=()=>hideBundled?physical().filter(row=>!bundled(row)):physical();
    const toggleBundled=()=>{hideBundled=!hideBundled;remember('hide-bundled',hideBundled);paint();};
    const displayed=()=>{
      if(!unified||section==='updates')return visibleRows().map(p=>({...p,key:p.id,installations:[p]}));
      const groups=new Map();
      for(const p of visibleRows()){
        // Only explicit unified view combines names; native records stay distinct.
        if(!groups.has(p.name))groups.set(p.name,{...p,key:p.id,installations:[]});
        groups.get(p.name).installations.push(p);
      }
      return [...groups.values()];
    };
    const filtered=()=>displayed().filter(p=>(!provider||p.installations.some(r=>r.provider===provider))&&(!query||[p.name,p.description,...p.installations.flatMap(r=>[r.source,names[r.provider]])].join(' ').toLowerCase().includes(query.toLowerCase()))&&(section!=='attention'||p.installations.some(attention))&&(section!=='updates'||p.owned));
    const groups=rows=>{
      const result=new Map();
      for(const row of rows){const label=unified&&section!=='updates'?'All plugins · unified by name':row.source||names[row.provider]+' · native files';if(!result.has(label))result.set(label,[]);result.get(label).push(row);}
      return [...result].map(([label,items])=>({label,items}));
    };
    const groupHead=g=>html`<button class="tc-mx-group-toggle" type="button" data-cmd="plugins.group" data-id="${g.label}" aria-expanded="${String(!collapsed.has(g.label))}">${icon(collapsed.has(g.label)?'chevron-right':'chevron-down')}${g.label}</button><span>· ${g.items.length}</span>`;
    const stateCell=(p,id)=>{
      const matches=p.installations.filter(r=>r.provider===id),row=matches[0];
      if(!row)return p.source?html`<button class="tc-cell tc-cell--none" type="button" data-cmd="plugins.copy" data-id="${p.id}" data-provider="${id}" aria-label="Install ${p.name} for ${names[id]}"><span class="tc-cell-dash">—</span><span class="tc-cell-add">${icon('plus')}Add</span></button>`:html`<span class="tc-cell tc-cell--none" aria-label="Not found for ${names[id]}">—</span>`;
      if(matches.length===1&&row.owned&&typeof row.enabled==='boolean'&&row.capabilities?.state!==false)return html`<span class="tc-cell tc-cell--switch" title="${badge(row)}"><button class="tc-switch tc-switch--sm" type="button" role="switch" aria-checked="${String(row.enabled)}" aria-label="${names[id]} setting for ${p.name}; review before changing" data-cmd="plugins.state" data-id="${row.id}"></button><span class="tc-small tc-muted">${row.enabled?'On':'Off'}</span></span>`;
      return html`<button class="tc-cell" type="button" data-cmd="${matches.length>1?'plugins.locations':'plugins.open'}" data-id="${p.id}" data-provider="${id}" title="${row.path||badge(row)}" aria-label="${names[id]} settings for ${p.name}: ${badge(row)}" data-tone="${row.enabled===false?'muted':''}">${matches.length>1?matches.length+' locations':row.stateCoverage==='discovery-links'?(row.enabled?'Registered':'Not registered'):row.enabled===true?'On':row.enabled===false?'Off':attention(row)?'Attention':'Found'}${icon('chevron-right')}</button>`;
    };
    const table=rows=>html`<div class="tc-mx-scroll tc-sk-matrix" tabindex="0" aria-label="Plugins by agent"><div class="tc-mx" role="table" aria-label="Plugins and agent settings" style="--mx-agent-count:${columns().length};${!columns().length?'--mx-cols:minmax(0,1fr);min-width:0;':''}"><div class="tc-mx-head" role="row"><div class="tc-mx-head-label" role="columnheader">Plugin${unified?' · unified by name':''}</div>${columns().map(id=>html`<div class="tc-mx-agent" role="columnheader"><span class="tc-mx-agent-name">${mark(id)}${names[id]}</span><span class="tc-mx-agent-kind">${installed().includes(id)?'Personal settings':'Not detected'}</span></div>`)}</div>${groups(rows).map(g=>html`<div role="rowgroup"><div role="row"><div class="tc-mx-group" role="cell" aria-colspan="${columns().length+1}">${groupHead(g)}</div></div>${collapsed.has(g.label)?'':g.items.map(p=>html`<div class="tc-mx-row" role="row" data-key="plugin-${p.key}"><div class="tc-mx-skill" role="cell"><div class="tc-mx-skill-copy"><div class="tc-mx-name"><button class="tc-skill-name" type="button" data-cmd="plugins.open" data-id="${p.id}">${p.name}</button>${p.installations.some(attention)?html`<span class="tc-badge tc-badge--warn">Needs attention</span>`:''}</div><p class="tc-mx-desc" title="${p.description||''}">${p.description||'No description provided.'}</p><span class="tc-hint">${p.version||'Version not declared'} · ${T3Model.plural(p.installations.length,'location')}</span></div></div>${columns().map(id=>html`<div class="tc-cellwrap" role="cell">${stateCell(p,id)}</div>`)}</div>`)}</div>`)}</div></div>`;
    const cards=rows=>html`<div class="tc-skill-cards">${groups(rows).map(g=>html`<section class="tc-skill-cards-group"><div class="tc-mx-group tc-skill-cards-head">${groupHead(g)}</div>${collapsed.has(g.label)?'':html`<div class="tc-skill-grid" role="list" aria-label="Plugins">${g.items.map(p=>html`<article class="tc-skill-card tc-group" role="listitem"><button class="tc-skill-card-main" type="button" data-cmd="plugins.open" data-id="${p.id}"><span class="tc-skill-card-top"><span class="tc-skill-card-name">${p.name}</span>${p.installations.some(attention)?html`<span class="tc-badge tc-badge--warn">Needs attention</span>`:''}</span><span class="tc-skill-card-desc">${p.description||'No description provided.'}</span><span class="tc-skill-card-agents"><span class="tc-agent-stack">${[...new Set(p.installations.map(r=>r.provider))].map(mark)}</span><span>${T3Model.plural(p.installations.length,'location')} · ${p.version||'Local package'}</span></span></button></article>`)}</div>`}</section>`)}</div>`;
    const phones=rows=>html`<div class="tc-sk-phone-list">${groups(rows).map(g=>html`<div class="tc-plist"><div class="tc-plist-group">${groupHead(g)}</div>${collapsed.has(g.label)?'':g.items.map(p=>html`<div class="tc-prow tc-sk-phone-row" data-cmd="plugins.open" data-id="${p.id}"><span class="tc-prow-name-line"><button class="tc-skill-name tc-prow-name" type="button" data-cmd="plugins.open" data-id="${p.id}">${p.name}</button></span><span class="tc-prow-desc">${p.description||'No description provided.'}</span><span class="tc-prow-agents"><span class="tc-agent-stack">${[...new Set(p.installations.map(r=>r.provider))].map(mark)}</span><span>${p.installations.length===1?badge(p):T3Model.plural(p.installations.length,'location')}</span></span>${icon('chevron-right')}</div>`)}</div>`)}</div>`;
    const checkUpdates=async()=>{
      if(checking)return;checking=true;paint();
      try{for(const row of physical().filter(p=>p.owned&&p.status==='installed')){
        try{const plan=await call('plan',{id:row.id,revision:row.revision,operation:'update'});checks.set(row.id,{status:plan.changes&&!plan.changes.some(f=>f.status!=='unchanged')?'current':plan.canApply?'available':(plan.blocked||[]).some(r=>/matches the installed snapshot/.test(r))?'current':'error',error:plan.canApply?null:(plan.blocked||[]).join(' '),at:Date.now()});await call('discard',{planId:plan.planId});}
        catch(e){checks.set(row.id,{status:'error',error:e.message,at:Date.now()});}
        paint();
      }}finally{checking=false;paint();}
    };
    const updates=rows=>html`<div class="tc-ut" role="table" aria-label="Plugin updates"><div class="tc-ut-head" role="row">${['Plugin','Repository','Status','Agent','Actions'].map(label=>html`<span role="columnheader">${label}</span>`)}</div>${rows.map(p=>{
      const check=checks.get(p.id);
      return html`<div class="tc-ut-row" role="row"><div class="tc-ut-skill" role="cell"><button class="tc-skill-name" type="button" data-cmd="plugins.open" data-id="${p.id}">${p.name}</button><code>${p.version||'Local snapshot'}</code></div><div class="tc-ut-src" role="cell"><code>${p.source}</code></div><div class="tc-ut-status" role="cell" data-tone="${check?.status==='available'?'accent':check?.status==='error'?'warn':'idle'}"><strong>${checking?'Checking…':check?.status==='available'?'Update available':check?.status==='current'?'Up to date':check?.status==='error'?'Couldn’t check':'Not checked yet'}</strong>${check?.error?html`<small>${check.error}</small>`:''}</div><div class="tc-ut-readers" role="cell">${mark(p.provider)}${names[p.provider]}</div><div class="tc-ut-act" role="cell"><button class="tc-btn tc-btn--sm" type="button" data-cmd="plugins.update" data-id="${p.id}"${off(checking)}>Review update…</button></div></div>`;
    })}</div><p class="tc-ut-note">${icon('info')}Updates are manual. Review changed files, hooks and native permissions before applying. Existing sessions keep their loaded plugins.</p>`;
    const actions=()=>html`<button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-cmd="plugins.add">${icon('download')}Install from source</button>`;
    const content=()=>{
      const visible=displayed(),rows=filtered(),problems=visibleRows().filter(attention),tracked=visibleRows().filter(p=>p.owned),hidden=hideBundled?physical().filter(bundled).length:0;
      const filters=css=>html`<div class="${css}" role="group" aria-label="Show plugins">${[['all','All',visible.length],...(tracked.length?[['updates','Updates',tracked.length]]:[]),...(problems.length?[['attention','Needs attention',problems.length]]:[])].map(([id,label,count])=>html`<button class="${css==='tc-lh-filters'?'tc-lh-filter':'tc-chip-btn'}" type="button" data-cmd="plugins.show" data-id="${id}" aria-pressed="${String(section===id&&!provider)}">${label}<span class="tc-tab-count">${count}</span></button>`)}</div>`;
      return html`<div id="plugin-library" class="tc-skills-library"><div class="tc-sk-toolbar"><label class="tc-sk-search">${icon('search')}<input class="tc-input" type="search" id="plugin-search" data-key="plugin-search" value="${query}" aria-label="Search plugins" placeholder="Search ${visible.length?T3Model.plural(visible.length,'plugin'):'plugins'}"></label><button class="tc-btn tc-btn--ghost tc-btn--icon tc-sk-phone-view" type="button" data-cmd="plugins.view-menu" aria-label="View options">${icon('sliders-horizontal')}</button><div class="tc-sk-desktop-filters"><button class="tc-btn tc-btn--sm" type="button" data-cmd="plugins.filter" aria-haspopup="menu">Available to <span class="tc-btn-value">${provider?names[provider]:'Any agent'}</span>${icon('chevron-down','tc-chev')}</button></div><span class="tc-spacer"></span><div class="tc-sk-desktop-actions">${actions()}</div></div><div class="tc-chipbar tc-sk-agent-chips" aria-label="Filter plugins">${filters('tc-plugin-chip-filters')}${columns().map(id=>html`<button class="tc-chip-btn" type="button" data-cmd="plugins.agent" data-provider="${id}" aria-pressed="${String(provider===id)}">${mark(id)}${names[id]}<span class="tc-tab-count">${visibleRows().filter(p=>p.provider===id).length}</span></button>`)}</div>${error?html`<p class="tc-notice tc-notice--danger" role="alert">Couldn’t read plugins. ${error}</p>`:''}<div class="tc-group tc-sk-card"><div class="tc-lh">${filters('tc-lh-filters')}<span class="tc-spacer"></span>${section==='updates'?html`<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-cmd="plugins.check-updates"${off(checking)}>${icon('refresh-cw')}${checking?'Checking…':'Check for updates'}</button>`:html`<div class="tc-seg tc-seg--sm tc-sk-layout" role="group" aria-label="Layout">${['table','cards'].map(layout=>html`<button type="button" data-cmd="plugins.layout" data-id="${layout}" aria-pressed="${String(cardView===(layout==='cards'))}">${layout==='table'?'Table':'Cards'}</button>`)}</div><div class="tc-lh-view"><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-cmd="plugins.view-menu" aria-haspopup="menu">${icon('sliders-horizontal','tc-icon--sm')}View</button></div>`}</div>${loading&&!data?html`<div class="tc-empty" role="status">Reading plugin inventories…</div>`:!rows.length?html`<div class="tc-empty"><span class="tc-empty-icon">${icon('puzzle')}</span><span class="tc-empty-title">${query||provider||section!=='all'?'No plugins match these filters':hidden?'No plugins to show':'No plugins found'}</span><span class="tc-empty-desc">${hidden&&!visibleRows().length?'Bundled and curated plugins are hidden. Show them below or install from a source.':physical().length?'Try another search or clear the library filters.':'Install a complete plugin from its repository. Choose its agent before reviewing changes.'}</span>${physical().length?html`<button class="tc-btn" type="button" data-cmd="plugins.clear">Clear filters</button>`:actions()}</div>`:section==='updates'?updates(rows):html`${cardView?cards(rows):table(rows)}${phones(rows)}`}${hidden?html`<div class="tc-mx-hidden">${icon('eye-off')}<span>${T3Model.plural(hidden,'bundled or curated plugin')} hidden</span><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-cmd="plugins.bundled">Show</button></div>`:''}<div class="tc-sk-library-foot"><span>${icon('info','tc-icon--sm')}Found on disk does not mean loaded. Changes apply when an agent loads or reloads plugins.</span><span class="tc-sk-scan-time">${loading?'Scanning…':scannedAt?'Scanned '+T3Model.relTime(scannedAt,Date.now()):''}</span><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-cmd="plugins.refresh"${off(loading)}>${icon('refresh-cw')}${loading?'Scanning':'Rescan'}</button></div></div>${data?html`<details class="tc-plugin-coverage"><summary>Inventory coverage and agent support</summary><p class="tc-hint">${data.installNote||'Each agent uses its own plugin format. Unsupported installation paths stay read-only.'}</p>${data.providers.filter(p=>!provider||p.id===provider).map(p=>html`<div><strong>${p.name}</strong><span class="tc-hint"> · ${p.coverage}</span><p class="tc-hint">${p.installReason||p.unsupportedReason||''}</p>${p.warnings?.length?html`<ul>${p.warnings.map(w=>html`<li class="tc-hint">${w}</li>`)}</ul>`:''}</div>`)}${(data.warnings||[]).map(w=>html`<p class="tc-hint">${w}</p>`)}</details>`:''}<div class="tc-sk-phone-actions">${actions()}</div></div>`;
    };
    const find=id=>physical().find(p=>p.id===id);
    const inspect=(id,agent=null)=>{
      const grouped=displayed().find(p=>p.id===id),locations=(grouped?.installations||[find(id)]).filter(p=>p&&(!agent||p.provider===agent));
      if(locations.length===1){open(locations[0]);return;}
      if(!locations.length||!close())return;
      const view={pending:false,layer:null};active=view;
      view.layer=Kit.open({kind:'sheet',panel:{class:'tc-sheet tc-sheet--inset tc-plugin-sheet',role:'dialog','aria-modal':'true','aria-label':'Choose plugin installation'},backdrop:'ignore',onEscape:close,onClose:()=>{if(active===view)active=null;},render:()=>html`<div class="tc-sheet-head"><h2 class="tc-sheet-title">Choose an installation</h2><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-plugin-location-close aria-label="Close installation choices">${icon('x')}</button></div><div class="tc-sheet-body"><p class="tc-hint">Each location keeps its own version and agent permissions.</p><div class="tc-list">${locations.map(p=>html`<button class="tc-row tc-plugin-location" type="button" data-plugin-location="${p.id}">${mark(p.provider)}<span class="tc-row-main"><strong>${p.name} · ${names[p.provider]}</strong><span class="tc-status">${p.version||'Local package'} · ${badge(p)}</span><code class="tc-hint">${p.path||p.nativeId}</code></span>${icon('chevron-right')}</button>`)}</div></div>`});
      view.layer.panel.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-plugin-location-close'))close();else if(b.hasAttribute('data-plugin-location')){const row=find(b.getAttribute('data-plugin-location'));if(row)open(row);}});
    };
    const viewMenu=el=>Kit.menu(el,{label:'Plugin view options',head:{title:'Agent columns'},items:[
      {label:'Installed agents',description:'Agents detected here or with plugins on disk.',radio:true,checked:!showAll,run:()=>{showAll=false;remember('columns','installed');paint();}},
      {label:'All agents',description:'Show every agent, including those without verified install support.',radio:true,checked:showAll,run:()=>{showAll=true;remember('columns','all');paint();}},
      {sep:true},{label:'Show bundled and curated plugins',description:'Includes Codex curated marketplace packages, even ones installed separately. Setup-installed plugins stay visible.',checkbox:true,checked:!hideBundled,run:toggleBundled},
      {sep:true},{label:'Unified view · one row per plugin name',description:'Keep each agent’s locations and permissions separate.',checkbox:true,checked:unified,run:()=>{unified=!unified;remember('unified',unified);paint();}},
      ...(Kit.isPhone()?[{sep:true},...Object.entries(names).map(([id,name])=>({label:name,radio:true,checked:provider===id,run:()=>{provider=provider===id?'':id;paint();}}))]:[])
    ],footer:'Remembered in this browser.'});
    return {content,openNative:async(agent,nativeId)=>{if(!data)await load();const row=physical().find(p=>p.provider===agent&&p.nativeId===nativeId);if(row)open(row);else Kit.toast('This plugin is outside the inspected inventory',{detail:'Refresh Plugins or review it in its native agent.'});},activate:()=>{if(!started)void load();},refresh:load,add:()=>install(),open:inspect,locations:inspect,update:id=>{const row=find(id);if(row)open(row,'update');},state:id=>{const row=find(id);if(row?.capabilities?.state!==false&&row?.owned&&typeof row.enabled==='boolean')open(row,'state');},copy:(id,target)=>{const row=find(id);if(row?.source)install({source:row.source,provider:target});},search:value=>{query=value;paint();},filter:el=>Kit.menu(el,{label:'Filter plugins by agent',items:[{label:'Any agent',run:()=>{provider='';paint();}},...Object.entries(names).map(([id,name])=>({label:name,radio:true,checked:provider===id,run:()=>{provider=id;paint();}}))]}),show:id=>{section=id;provider='';paint();},agent:id=>{provider=provider===id?'':id;section='all';paint();},clear:()=>{provider=query='';section='all';hideBundled=false;remember('hide-bundled',false);paint();},layout:id=>{cardView=id==='cards';remember('view',id);paint();},group:id=>{collapsed.has(id)?collapsed.delete(id):collapsed.add(id);paint();},toggleBundled,viewMenu,checkUpdates,beforeNavigate:async()=>close(),count:()=>displayed().length};
  };
  return {create};
})();
