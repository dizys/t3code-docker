/* Simulated custom-service adapter. Does not invoke mise, execute code, or read secrets. */
const USER_TOOL_FIXTURES = [
  {id:'python@3.13.2',label:'Python 3.13.2',commands:['python','python3']},
  {id:'python@3.12.9',label:'Python 3.12.9',commands:['python','python3']},
  {id:'node@22.14.0',label:'Node.js 22.14.0',commands:['node','npm','npx']}
];
function customDraft() {
  return {step:1,id:null,name:'',mode:'tool',tool:'',executable:'',args:'',script:'',directory:'',enabled:true,restart:'failure',health:'process',port:'8081',envName:'',vaultRef:'',error:null};
}
function sampleCustomService() {
  return {...customDraft(),id:'demo-user-1',name:'Docs preview',tool:'python@3.13.2',executable:'python',args:'-m\nhttp.server\n8081\n--bind\n127.0.0.1',directory:'/home/t3/workspace/docs',runtime:'running',run:1,operation:'user:op-demo-1',events:['[stdout] Serving HTTP on 127.0.0.1 port 8081','[stdout] GET /index.html 200']};
}
function customStatus(service) {
  const statuses={running:['Running','ok','circle-check'],stopped:['Stopped for now','muted','clock'],disabled:['Disabled','muted','clock'],missing:['Tool unavailable','warn','circle-alert'],failed:['Failed','danger','circle-alert'],unhealthy:['Unhealthy','warn','circle-alert'],exited:['Exited (0)','muted','info']};
  return badge(...(statuses[service.runtime]||['Status unavailable','muted','wifi-off']));
}
function customServiceItems() {
  return state.customServices.map(s=>({id:`user:${s.id}`,name:s.name,mark:'terminal',meta:`Custom · ${s.mode==='tool'?s.tool:s.mode==='shell'?'Shell script':s.executable} · ${s.runtime==='running'&&s.health==='process'?'No health check configured':'Runs as t3'}`,status:customStatus(s),action:`custom-inspect-${s.id}`,label:'Details',searchText:`${customCommand(s)} ${s.directory}`,needsAttention:['failed','missing','unhealthy'].includes(s.runtime)}));
}
function customReadDraft() {
  const d=state.customDraft;
  for(const [field,id] of Object.entries({name:'custom-name',mode:'custom-mode',tool:'custom-tool',executable:'custom-executable',args:'custom-args',script:'custom-script',directory:'custom-directory',restart:'custom-restart',health:'custom-health',port:'custom-port',envName:'custom-env',vaultRef:'custom-vault'})) {
    const input=document.getElementById(id);if(input)d[field]=input.value;
  }
  const enabled=document.getElementById('custom-enabled');if(enabled)d.enabled=enabled.checked;
}
function customField(id,label,input,help='') {
  const error=state.customDraft.error?.field===id?state.customDraft.error.message:'';
  const described=[help?`${id}-help`:'',error?`${id}-error`:''].filter(Boolean).join(' ');
  return `<div class="field"><label class="tc-label" for="${id}">${label}</label>${input.replace('__ATTR__',`${described?`aria-describedby="${described}"`:''} ${error?'aria-invalid="true"':''}`)}${help?`<p id="${id}-help" class="helper">${help}</p>`:''}${error?`<p id="${id}-error" class="field-error" role="alert">${esc(error)}</p>`:''}</div>`;
}
function customOption(value,label,selected) {return `<option value="${esc(value)}" ${selected===value?'selected':''}>${esc(label)}</option>`;}
function customCommand(d) {
  if(d.mode==='shell')return `/bin/bash -c ${customQuote(d.script)}`;
  return [d.executable,...d.args.split(/\r?\n/).filter(a=>a.length)].map(customQuote).join(' ');
}
function customQuote(value) {return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)?value:`'${value.replace(/'/g,"'\\''")}'`;}
function customSheet(kind,id) {
  if(!['add-service','custom-create','custom-inspect','custom-logs','custom-remove'].includes(kind))return null;
  const close=btn('Close','close');
  if(kind==='add-service')return {title:'Add service',description:'Choose how to configure it',body:`<div class="action-list">${btn(`${icon('box')} From catalogue`,'custom-catalogue','tc-btn--ghost')}${btn(`${icon('terminal')} Custom service`,'custom-new','tc-btn--ghost')}</div><p class="helper">Use an installed mise tool, another executable, or your own script. Custom services run as t3 and share the same logs and lifecycle controls.</p>`,footer:close};
  if(kind==='custom-create') {
    const d=state.customDraft;
    let body='',footer='';
    const title=d.id?'Edit custom service':'Add custom service';
    if(d.step===1) {
      body=`${customField('custom-name','Service name',`<input id="custom-name" class="tc-input autofocus" maxlength="80" value="${esc(d.name)}" placeholder="e.g. Docs preview" __ATTR__>`)}
      ${customField('custom-mode','Run from',`<select id="custom-mode" class="tc-select" __ATTR__>${customOption('tool','Installed mise tool',d.mode)}${customOption('executable','Executable',d.mode)}${customOption('shell','Shell script',d.mode)}</select>`)}`;
      if(d.mode==='tool') {
        const tool=USER_TOOL_FIXTURES.find(t=>t.id===d.tool);
        body+=customField('custom-tool','Installed tool',`<select id="custom-tool" class="tc-select" __ATTR__>${customOption('','Choose an installed version',d.tool)}${USER_TOOL_FIXTURES.map(t=>customOption(t.id,t.label,d.tool)).join('')}</select>`,'Version stays pinned even when your interactive default changes. Inventory here is sample data.');
        body+=customField('custom-executable','Executable',`<select id="custom-executable" class="tc-select" __ATTR__>${customOption('','Choose an executable',d.executable)}${(tool?.commands||[]).map(c=>customOption(c,c,d.executable)).join('')}</select>`);
      } else if(d.mode==='executable')body+=customField('custom-executable','Executable path',`<input id="custom-executable" class="tc-input tc-input--mono" value="${esc(d.executable)}" placeholder="/home/t3/bin/my-service" __ATTR__>`,'Runs directly as t3. Put arguments in the separate field.');
      if(d.mode==='shell')body+=customField('custom-script','Shell script',`<textarea id="custom-script" class="tc-input tc-input--mono" spellcheck="false" __ATTR__>${esc(d.script)}</textarea>`,'Explicit /bin/bash script mode. Expansions and pipelines execute as t3.');
      else body+=customField('custom-args','Arguments <span class="tc-label-opt">optional</span>',`<textarea id="custom-args" class="tc-input tc-input--mono custom-args" spellcheck="false" placeholder="One literal argument per line" __ATTR__>${esc(d.args)}</textarea>`,'One literal argument per line in this prototype. Pipes and $() are not evaluated.');
      body+=customField('custom-directory','Working directory',`<input id="custom-directory" class="tc-input tc-input--mono" value="${esc(d.directory)}" placeholder="/home/t3/workspace/my-project" __ATTR__>`,'Production checks that the directory and executable are accessible. No path is read by this prototype.');
      body+=btn('Use Python preview example','custom-example','tc-btn--ghost');
    }
    if(d.step===2) {
      body=`<label class="custom-check"><input id="custom-enabled" type="checkbox" ${d.enabled?'checked':''}><span><span class="tc-label">${d.id?'Enable service':'Enable after adding'}</span><small>Start now and on container startup.</small></span></label>
      ${customField('custom-restart','Restart policy',`<select id="custom-restart" class="tc-select" __ATTR__>${customOption('failure','On failure',d.restart)}${customOption('always','Always',d.restart)}${customOption('never','Never',d.restart)}</select>`,'Automatic restarts use backoff and a retry budget. Stop for now suppresses pending retries.')}
      ${customField('custom-health','Health check',`<select id="custom-health" class="tc-select" __ATTR__>${customOption('process','Process only',d.health)}${customOption('http','Local HTTP check',d.health)}</select>`,'Process only means Running, with no claim that the application is ready.')}
      ${d.health==='http'?customField('custom-port','Local HTTP port',`<input id="custom-port" class="tc-input" inputmode="numeric" value="${esc(d.port)}" __ATTR__>`,'Check http://127.0.0.1:PORT/ inside this container. This does not publish the service.') : ''}
      <details class="custom-advanced"><summary>Environment and secrets</summary><div class="custom-fields">
      ${customField('custom-env','Environment variable',`<input id="custom-env" class="tc-input tc-input--mono" value="${esc(d.envName)}" placeholder="PREVIEW_API_KEY" __ATTR__>`)}
      ${customField('custom-vault','Value from Vault',`<select id="custom-vault" class="tc-select" __ATTR__>${customOption('','No value selected',d.vaultRef)}${customOption('demo-preview-token','Development preview token · Sample reference',d.vaultRef)}</select>`,'Only the selected reference is passed to this service. Secret values are never displayed here.')}</div></details>
      ${notice('Runs with your user permissions','Custom commands run as t3, just like a terminal process. Keep the program in the foreground. No port or tunnel is added automatically.')}`;
    }
    if(d.step===3) {
      const old=state.customServices.find(s=>s.id===d.id);
      const restart=old&&customLaunchChanged(old,d);
      body=`${kv([['Name',esc(d.name)],['Source',d.mode==='tool'?esc(d.tool):d.mode==='shell'?'Shell script':'User executable'],['Run as','t3 · Custom service'],['Working directory',esc(d.directory)],['Startup',d.enabled?'Enabled · Starts on container startup':'Disabled'],['Restart',{failure:'On failure, with backoff',always:'Always, with backoff',never:'Never'}[d.restart]],['Health',d.health==='http'?`Local HTTP :${esc(d.port)}`:'Process only'],['Secret references',d.vaultRef?`${esc(d.envName)} ← Development preview token`:'None'],['Network exposure','No automatic publishing']])}<div class="command"><pre>${esc(customCommand(d))}</pre></div><p class="helper">${old?(restart?'This launch change restarts the service. Configuration recovery cannot undo application data changes.':'Name and policy changes apply without restarting an unchanged command.'):'This reuses an installed tool. No package is installed by registering the service.'}</p>`;
    }
    footer=`${d.step>1?btn('Back','custom-back','','data-left'):btn('Cancel','close','','data-left')}${btn(d.step===3?(d.id?'Save changes':d.enabled?'Add and enable':'Add service'):'Continue','custom-next','tc-btn--primary')}`;
    return {title,description:`Step ${d.step} of 3 · ${['Command','Behavior','Review'][d.step-1]}`,body,footer};
  }
  const s=state.customServices.find(s=>s.id===id);
  if(!s)return {title:'Service unavailable',description:'This registration was removed',body:'<p class="helper">Return to the service list.</p>',footer:close};
  if(kind==='custom-inspect') {
    const primary=s.runtime==='running'?btn(`${icon('refresh-cw')} Restart`,`custom-restart-${id}`,'tc-btn--primary'):btn(s.enabled?'Start':'Enable service',`custom-enable-${id}`,'tc-btn--primary');
    const body=`${s.runtime==='missing'?notice('Pinned tool is unavailable','Choose an installed version or reinstall through Toolchains. The service will not fall back to latest.','warn',btn('Choose version',`custom-edit-${id}`)):''}${s.runtime==='stopped'?notice('Stopped for now','Automatic retries are paused. This enabled service will start at the next container startup.'):''}
    ${kv([['Status',customStatus(s)],['Source','Custom · Runs as t3'],['Tool',s.mode==='tool'?esc(s.tool):s.mode==='shell'?'Explicit shell script':'User executable'],['Working directory',esc(s.directory)],['Startup',s.enabled?'Enabled':'Disabled'],['Health',s.health==='process'?'No health check configured':`Local HTTP :${esc(s.port)}`],['Restart',{failure:'On failure',always:'Always',never:'Never'}[s.restart]],['Network exposure','No route configured']])}<div class="command"><pre>${esc(customCommand(s))}</pre></div><div class="action-list">${btn(`${icon('wrench')} Edit configuration`,`custom-edit-${id}`,'tc-btn--ghost')}${btn(`${icon('activity')} View logs`,`custom-logs-${id}`,'tc-btn--ghost')}${s.runtime==='running'?btn(`${icon('clock')} Stop for now`,`custom-stop-${id}`,'tc-btn--ghost'):''}${s.enabled?btn('Disable',`custom-disable-${id}`,'tc-btn--ghost'):''}${btn('Remove service',`custom-remove-${id}`,'tc-btn--ghost tc-btn--danger')}</div><p class="operation-id">${esc(s.operation)} · Run ${s.run}</p>`;
    return {title:s.name,description:'Custom service · Managed here',body,footer:`${close}${primary}`};
  }
  if(kind==='custom-logs') {
    const matches=s.events.filter(line=>line.toLowerCase().includes(state.customLogQuery.toLowerCase()));
    return {title:`${s.name} logs`,description:`Sample stdout/stderr · Run ${s.run}`,body:`<div class="field"><label class="tc-label" for="custom-log-search">Search logs</label><input id="custom-log-search" class="tc-input" value="${esc(state.customLogQuery)}" placeholder="Filter messages"></div><pre class="log-view" id="custom-log-output">${esc(matches.join('\n')||'No matching log messages.')}</pre><p class="helper" id="custom-log-state">${state.customLogsPaused?'Log display paused. The service keeps running.':'Showing sample retained output. No live process is running in this prototype.'}</p><p class="helper">Production rotates bounded logs and reports gaps. Custom programs may print sensitive content; preview output before sharing.</p>`,footer:`${btn(state.customLogsPaused?'Resume display':'Pause display','custom-pause','','data-left')}${btn('Back to service',`custom-inspect-${id}`)}`};
  }
  return {title:'Remove service?',description:s.name,body:`${notice('Stop and remove this registration','The service is stopped before its registration and owned routes are removed.','warn')}<p class="helper">Keep installed mise tools, application files, Vault entries, and unrelated services. Tool or data deletion is a separate action.</p>`,footer:`${btn('Cancel','close')}${btn('Remove service',`custom-confirm-remove-${id}`,'tc-btn--danger-solid')}`};
}
function customLaunchChanged(a,b) {return ['mode','tool','executable','args','script','directory','envName','vaultRef'].some(k=>a[k]!==b[k]);}
function customValidate() {
  const d=state.customDraft;
  if(d.step===1) {
    if(!d.name.trim())return {field:'custom-name',message:'Enter a service name.'};
    if(d.mode==='tool'&&!USER_TOOL_FIXTURES.some(t=>t.id===d.tool))return {field:'custom-tool',message:'Choose an installed tool version.'};
    if(d.mode!=='shell'&&!d.executable.trim())return {field:'custom-executable',message:'Choose an executable.'};
    if(d.mode==='executable'&&!d.executable.startsWith('/'))return {field:'custom-executable',message:'Enter an absolute executable path.'};
    if(d.mode==='shell'&&!d.script.trim())return {field:'custom-script',message:'Enter a foreground shell script.'};
    if(!d.directory.startsWith('/'))return {field:'custom-directory',message:'Enter an absolute working directory.'};
  }
  if(d.step===2) {
    if(d.health==='http'&&!/^\d+$/.test(d.port))return {field:'custom-port',message:'Enter a local port from 1 to 65535.'};
    if(d.health==='http'&&(Number(d.port)<1||Number(d.port)>65535))return {field:'custom-port',message:'Enter a local port from 1 to 65535.'};
    if(d.envName&&!/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.envName))return {field:'custom-env',message:'Enter a valid environment variable name.'};
    if(!!d.envName!==!!d.vaultRef)return {field:d.envName?'custom-vault':'custom-env',message:'Choose both a variable name and its Vault reference, or leave both empty.'};
  }
  return null;
}
async function customAct(action) {
  if(action==='add-service')return openSheet('add-service');
  if(action==='custom-catalogue'){closeSheet();state.view='available';return renderApp('view-available');}
  if(action==='custom-new'){if(state.customDraft.id)state.customDraft=customDraft();return openSheet('custom-create');}
  if(action==='custom-example'){const id=state.customDraft.id;state.customDraft={...sampleCustomService(),id,step:1};renderSheet();$('#custom-name').focus();return;}
  if(action==='custom-back'){customReadDraft();state.customDraft.step--;state.customDraft.error=null;renderSheet();$('#sheet-title').focus();return;}
  if(action==='custom-next') {
    if(state.modal?.kind!=='custom-create')return;
    customReadDraft();const d=state.customDraft;d.error=customValidate();
    if(d.error){renderSheet();$('#'+d.error.field).focus();return;}
    if(d.step<3){d.step++;renderSheet();$('#sheet-title').focus();return;}
    const old=state.customServices.find(s=>s.id===d.id),restart=old&&customLaunchChanged(old,d);
    const id=d.id||`demo-user-${state.customSequence++}`;
    const s={...d,id,runtime:!d.enabled?'disabled':!old||!old.enabled||restart?'running':old.runtime,run:old?old.run+(d.enabled&&(!old.enabled||restart)?1:0):d.enabled?1:0,operation:`user:op-demo-${state.customSequence++}`,events:old?[...old.events]:[d.enabled?'[manager] Started custom command as t3':'[manager] Created disabled registration']};
    if(old)state.customServices[state.customServices.indexOf(old)]=s;else state.customServices.push(s);
    state.customDraft=customDraft();state.page='services';state.view='installed';renderApp();openSheet('custom-inspect',id);announce(old?'Custom service configuration saved in simulation.':'Custom service added in simulation.');return;
  }
  if(action==='custom-pause'){state.customLogsPaused=!state.customLogsPaused;renderSheet();$('#sheet-title').focus();return;}
  const handlers=[['custom-confirm-remove-',(s)=>{state.customServices=state.customServices.filter(x=>x.id!==s.id);renderApp();closeSheet();toast('Registration removed in simulation. Tools and application files retained.');}],['custom-inspect-',s=>openSheet('custom-inspect',s.id)],['custom-edit-',s=>{state.customDraft={...s,step:1,error:null};openSheet('custom-create');}],['custom-logs-',s=>{state.customLogQuery='';state.customLogsPaused=false;openSheet('custom-logs',s.id);}],['custom-remove-',s=>openSheet('custom-remove',s.id)],['custom-stop-',s=>{s.runtime='stopped';s.events.push('[manager] Stopped for now; retries paused');renderApp();openSheet('custom-inspect',s.id);}],['custom-disable-',s=>{s.enabled=false;s.runtime='disabled';s.events.push('[manager] Disabled; startup is off');renderApp();openSheet('custom-inspect',s.id);}],['custom-enable-',s=>{s.enabled=true;s.runtime='running';s.run++;s.events.push('[manager] Started as t3');renderApp();openSheet('custom-inspect',s.id);}],['custom-restart-',s=>{s.runtime='running';s.run++;s.events.push('[manager] Restarted owned process');renderApp();openSheet('custom-inspect',s.id);}]];
  for(const [prefix,handler] of handlers)if(action.startsWith(prefix)){const s=state.customServices.find(s=>s.id===action.slice(prefix.length));if(s)return handler(s);return;}
  throw Error(`Unimplemented custom prototype action: ${action}`);
}
function customInput(target) {
  if(target.id==='custom-log-search') {
    state.customLogQuery=target.value;const s=state.customServices.find(s=>s.id===state.modal?.id);
    $('#custom-log-output').textContent=s.events.filter(line=>line.toLowerCase().includes(target.value.toLowerCase())).join('\n')||'No matching log messages.';
  }
}
function customChange(target) {
  if(!['custom-mode','custom-tool','custom-health'].includes(target.id))return;
  customReadDraft();const d=state.customDraft;d.error=null;
  if(target.id==='custom-mode')d.executable='';
  if(target.id==='custom-tool')d.executable=USER_TOOL_FIXTURES.find(t=>t.id===d.tool)?.commands[0]||'';
  renderSheet();$('#'+target.id)?.focus();
}
