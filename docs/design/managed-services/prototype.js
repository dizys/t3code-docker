/* Reference interaction model. No network requests, persistence, or real operations. */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => ICONS[name] || ICONS.info;
const state = {
  scenario: 'ready', page: 'access', tab: 'ssh', client: 'terminal', view: 'installed', query: '',
  mode: 'tailscale', host: 't3-workstation.example.ts.net', port: '2222', deviceObserved: false,
  checked: false, keys: [], installStep: 2, operationId: 'op-demo-4c91', activeVersion: '9.9p2',
  disabled: false, tailDisabled: false, connectorPending: false, modal: null, wizard: {step: 1, mode: 'tailscale', label: '', key: '', host: '', error: ''},
  customServices: [], customDraft: customDraft(), customSequence: 2, customLogQuery: '', customLogsPaused: false
};
const SAMPLE_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea work-laptop';
const HOST_FP = 'SHA256:cP3cQyHXsThH9D6ubZMrF9YrQ4k5JcVWFGbK69M9h0k';
const KEY_FP = 'SHA256:bbXpuKG6zhzdmnxq256TlqzFBzRl2f6OOg722cYNbU8';
let returnFocus = null;
let toastTimer;
const sheet = $('#sheet');
const btn = (label, action, kind = '', attrs = '') => `<button type="button" class="tc-btn ${kind}" data-action="${action}" ${attrs}>${label}</button>`;
const badge = (text, tone = 'muted', mark = 'circle-check') => `<span class="inline-status ${tone}">${icon(mark)}${esc(text)}</span>`;
const row = (mark, title, meta, actions = '', status = '') => `<div class="tc-row"><span class="tc-row-lead">${icon(mark)}</span><div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">${esc(title)}</span>${status}</div><div class="tc-row-meta wrap-anywhere">${meta}</div></div><div class="tc-row-actions">${actions}</div></div>`;
const section = (id, title, body, action = '', sub = '') => `<section class="tc-section" aria-labelledby="${id}"><div class="tc-section-head"><h2 id="${id}" class="tc-section-title">${title}</h2><div class="tc-section-actions">${action}</div></div>${sub ? `<p class="section-sub">${sub}</p>` : ''}${body}</section>`;
const notice = (title, text, tone = '', actions = '') => `<div class="notice ${tone}">${icon(tone ? 'circle-alert' : 'info')}<div><h3>${title}</h3><p>${text}</p>${actions ? `<div class="notice-actions">${actions}</div>` : ''}</div></div>`;
const kv = items => `<dl class="review-list">${items.map(([k,v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
function announce(text) { $('#announcement').textContent = text; }
function toast(text) {
  clearTimeout(toastTimer);
  $('#toast').innerHTML = `${icon('check')}<span>${esc(text)}</span>`;
  $('#toast').hidden = false;
  announce(text);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}
function ready() { return !['fresh','storage','installing','failed','expired','stale'].includes(state.scenario) && !state.disabled && !state.tailDisabled && !state.connectorPending; }
function connectionLabel() { return state.mode === 'tailscale' ? 'Work tailnet' : state.mode === 'cloudflare' ? 'Cloudflare Access' : 'Existing network'; }
function tailConsumers() { return hasInstall()&&state.mode==='tailscale'?'SSH and Workspace preview':'Workspace preview'; }
function command() {
  if (state.mode === 'cloudflare') return `ssh -o 'ProxyCommand=cloudflared access ssh --hostname %h' t3@ssh.example.com`;
  return `ssh -p ${state.port} t3@${state.host}`;
}
function hasInstall() { return !['fresh','storage'].includes(state.scenario); }
function serviceStatus() {
  if (state.disabled) return badge('Disabled','muted','clock');
  if (state.scenario === 'failed') return badge('Failed','danger','circle-alert');
  if (state.scenario === 'stale') return badge('Status unavailable','muted','wifi-off');
  if (state.scenario === 'installing') return badge('Installing','muted','download');
  if (!hasInstall()) return badge('Not installed','muted','download');
  return badge('Running','ok');
}
function routeStatus() {
  if (state.connectorPending) return badge('Setup required','warn','circle-alert');
  if (state.tailDisabled || state.disabled) return badge('Disabled','muted','clock');
  if (state.scenario === 'expired') return badge('Sign-in expired','warn','circle-alert');
  if (state.scenario === 'stale') return badge('Status unavailable','muted','wifi-off');
  if (state.scenario === 'installing') return badge('Pending','muted','clock');
  return badge('Ready','ok');
}
function setScenario(scenario, focus = true) {
  if (sheet.open) sheet.close();
  state.scenario = scenario; state.page = 'access'; state.tab = 'ssh'; state.client = 'terminal'; state.view = 'installed';
  state.checked = false; state.deviceObserved = false; state.disabled = false; state.tailDisabled = false; state.connectorPending = false;
  state.mode = 'tailscale'; state.host = 't3-workstation.example.ts.net'; state.port = '2222'; state.activeVersion = '9.9p2';
  state.installStep = 2; state.modal = null; state.query = '';
  state.keys = hasInstall() ? [{id:1,label:'Work laptop',type:'ED25519',fp:KEY_FP,last:'No sign-in observed yet'}] : [];
  state.wizard = {step:1,mode:'tailscale',label:'',key:'',host:'',error:''};
  state.customServices = scenario==='custom'?[sampleCustomService()]:[];state.customDraft=customDraft();state.customSequence=2;
  if(scenario==='custom')state.page='services';
  $('#scenario').value = scenario;
  renderApp();
  if (focus) announce(`Scenario: ${$('#scenario').selectedOptions[0].textContent}. Simulated data.`);
}
function navigate(page, tab = state.tab) {
  state.page = page; state.tab = tab;
  try { history.pushState(null,'',page === 'access' ? `#access/${tab}` : '#services'); } catch {}
  renderApp(); $('#page-title').focus();
}
function renderApp(focusId) {
  const servicePage = state.page === 'services';
  const pageName = servicePage ? 'Services' : 'Access';
  $('#app').innerHTML = `<aside class="tc-sidebar" aria-label="Setup navigation">
    <div class="tc-brand"><span class="tc-wordmark"><span>Code</span></span><span class="tc-badge tc-badge--outline">Setup</span></div>
    <nav class="tc-nav" aria-label="Prototype destinations">
      <button class="tc-nav-item" data-action="nav-access" ${!servicePage?'aria-current="page"':''}>${icon('smartphone')}Access</button>
      <div class="tc-nav-label">System</div>
      <button class="tc-nav-item" data-action="nav-services" ${servicePage?'aria-current="page"':''}>${icon('server')}Services${['failed','expired','stale'].includes(state.scenario)?'<span class="tc-badge tc-badge--warn tc-badge--count">1</span>':''}</button>
    </nav><div class="tc-sidebar-foot"><div class="tc-server"><div class="tc-server-row"><span class="tc-dot tc-dot--ok"></span><strong>T3 Code running</strong></div><span>Optional services prototype</span></div></div>
  </aside>
  <main class="tc-main"><header class="tc-topbar"><ol class="tc-crumbs" aria-label="Breadcrumb"><li>Setup</li><li aria-current="page">${pageName}</li></ol>
  <label for="page-select" class="tc-sr">Setup page</label><select id="page-select" class="tc-select compact-page-select"><option value="access" ${!servicePage?'selected':''}>Access</option><option value="services" ${servicePage?'selected':''}>Services</option></select></header>
  <div class="tc-page"><div class="page-heading"><div class="page-title-row"><h1 id="page-title" tabindex="-1">${pageName}</h1>${servicePage?btn(`${icon('plus')} Add service`,'add-service','tc-btn--primary'):''}</div><p>${servicePage?'Manage catalogue services and your own background commands.':'Pair devices and choose how you reach this server.'}</p></div>
  ${servicePage ? services() : access()}
  <p class="demo-note">Design reference. All service states, versions, identities, and operations are illustrative. No installation or account changes occur.</p></div></main>`;
  if (focusId) document.getElementById(focusId)?.focus();
}
function access() {
  return `<div class="access-tabs" role="tablist" aria-label="Access tasks">${[['devices','Devices'],['connections','Connections'],['ssh','SSH']].map(([id,label]) => `<button id="access-${id}" role="tab" aria-controls="access-panel" aria-selected="${state.tab===id}" tabindex="${state.tab===id?0:-1}" data-action="tab-${id}">${label}</button>`).join('')}</div><div class="page-body" id="access-panel" role="tabpanel" aria-labelledby="access-${state.tab}">${state.tab==='ssh'?ssh():state.tab==='connections'?connections():devices()}</div>`;
}
function ssh() {
  if (['fresh','storage'].includes(state.scenario)) return `${state.scenario === 'storage' ? notice('Persistent service storage required','Add a protected volume to this deployment before installing SSH. Your current T3 access remains available.','warn',btn('Review deployment change','storage')) : ''}
  ${section('ssh-setup','SSH access',`<div class="tc-group"><div class="empty-content">${icon('terminal')}<h2>Connect from your terminal or editor</h2><p>Install SSH when you need it. Use your own public key and choose how this server is reached.</p>${btn(`${icon('plus')} Set up SSH`,'setup','tc-btn--primary')}</div><div class="tc-card-foot">Public-key sign-in · Persistent server identity · Optional download</div></div>`)}`;
  let alert = '';
  if (state.scenario==='installing') alert = notice('SSH setup is in progress','Verifying the downloaded packages. You can leave this page and return to the same operation.','',btn('View progress','progress'));
  if (state.scenario==='expired') alert = notice('Sign in to restore this connection','The tailnet sign-in has expired. SSH is still running; this Tailscale route is unavailable.','warn',btn('Sign in again','signin','tc-btn--primary'));
  if (state.scenario==='failed') alert = notice('SSH could not start','The configured port is already in use. Automatic retries have stopped. Your keys and server identity are retained.','danger',btn('Review error','error'));
  if (state.scenario==='rollback') alert = notice('Update rolled back','The new SSH version did not pass its readiness check. Previous version 9.9p2 is running.','warn',btn('View update result','rollback'));
  if (state.scenario==='stale') alert = notice('Current status is unavailable','The service controller stopped responding. Last known: SSH running, checked 8 minutes ago.','',btn('Retry check','recheck'));
  if (state.disabled) alert = notice('SSH is disabled','Your keys, server identity, and installed version are retained.', '', btn('Enable SSH','enable-ssh','tc-btn--primary'));
  if (state.tailDisabled) alert = notice('Tailscale is disabled','SSH is running, but this route is disabled.', '', btn('Enable connection','enable-tail','tc-btn--primary'));
  if (state.connectorPending) alert = notice('Finish the Cloudflare connection','SSH is installed. Configure the hostname and Access policy before using this route.','warn',btn('Finish setup','cloudflare-finish','tc-btn--primary'));
  const runtime = row('terminal','SSH server',`OpenSSH ${state.activeVersion} · Account t3`,btn(`${icon('chevron-right')}<span class="tc-sr">View SSH service</span>`,'inspect-ssh','tc-btn--ghost tc-btn--icon'),serviceStatus());
  const network = row('globe',connectionLabel(),`${esc(state.host)} · ${state.mode==='existing'?'Managed externally':'Managed here'}`,btn('Details',state.mode==='existing'?'external':state.mode==='cloudflare'?'cloudflare-finish':'connection','tc-btn--ghost'),routeStatus());
  const result = ready() ? `<div class="tc-card-foot">${icon('circle-check')}Service and route checks passed${state.checked?' just now':'.'} <span class="tc-spacer"></span>${badge('Ready to connect','ok')}</div>` : `<div class="tc-card-foot">${icon('info')}Local service and connection checks have separate results.</div>`;
  return `${alert}${section('ssh-connection','Connection',`<div class="tc-group">${runtime}${network}${result}</div>`,btn(`${icon('refresh-cw')} Check readiness`,'recheck','tc-btn--ghost'))}
  ${section('ssh-connect','Connect',connectPanel())}
  ${section('ssh-keys',`Authorized keys <span class="tc-badge tc-badge--count">${state.keys.length}</span>`,`<div class="tc-group">${state.keys.length?state.keys.map(k=>row('key-round',k.label,`${esc(k.type)} · <span class="fingerprint">${esc(k.fp)}</span>`,btn(`${icon('ellipsis')}<span class="tc-sr">Manage ${esc(k.label)} key</span>`,`key-${k.id}`,'tc-btn--ghost tc-btn--icon'))).join(''):'<div class="skeleton">No public keys authorized.</div>'}<div class="tc-card-foot">Incoming SSH access. Your client private keys stay on your devices.</div></div>`,btn(`${icon('plus')} Add key`,'add-key','tc-btn--ghost'))}`;
}
function connectPanel() {
  const tabs = `<div class="segmented" role="tablist" aria-label="Client instructions">${[['terminal','Terminal'],['config','SSH config'],['vscode','VS Code']].map(([id,label])=>`<button type="button" role="tab" id="client-${id}" aria-controls="client-panel" aria-selected="${state.client===id}" tabindex="${state.client===id?0:-1}" data-action="client-${id}">${label}</button>`).join('')}</div>`;
  let text = command();
  let help = state.mode==='cloudflare'?'Install cloudflared on your device and complete the Cloudflare Access sign-in when prompted.':'Run this on a device that can reach this connection. Keep host-key checking enabled.';
  if (state.client==='config') { text = `Host t3-workstation\n  HostName ${state.host}\n  User t3\n  Port ${state.port}${state.mode==='cloudflare'?'\n  ProxyCommand cloudflared access ssh --hostname %h':''}`; help='Add this entry to ~/.ssh/config on your device. Choose your own local IdentityFile if needed.'; }
  if (state.client==='vscode') { text = `Remote-SSH: Connect to Host…\nt3-workstation`; help='Add the SSH config entry first, then use the Remote-SSH extension in VS Code on your device.'; }
  if (!ready()) help = 'Resolve the connection status above before trying this route. Your saved client configuration is retained.';
  return `<div class="tc-group"><div class="connect-panel">${tabs}<div id="client-panel" role="tabpanel" aria-labelledby="client-${state.client}"><div class="command"><pre id="client-command">${esc(text)}</pre>${btn(`${icon('copy')}<span class="tc-sr">Copy ${state.client==='terminal'?'SSH command':state.client==='config'?'SSH configuration':'VS Code instructions'}</span>`,'copy-command','tc-btn--ghost tc-btn--icon')}</div></div><p class="helper">${help}</p><div class="fingerprint-line"><div class="fingerprint-detail"><p class="helper">Server fingerprint</p><span class="fingerprint">${HOST_FP}</span></div>${btn(`${icon('copy')}<span class="tc-sr">Copy server fingerprint</span>`,'copy-fingerprint','tc-btn--ghost tc-btn--icon')}</div></div><div class="tc-card-foot evidence-foot">${icon(state.deviceObserved?'circle-check':'info')}<span>${state.deviceObserved?'SSH sign-in observed just now. The exact network route has not been verified.':'No device sign-in observed yet. Readiness checks run on this server.'}</span>${btn('Verification details','verify','tc-btn--ghost')}</div></div>`;
}
function connections() {
  return `${section('application-access','Application access',`<div class="tc-group">${row('globe','Public URL','https://t3.example.com · Existing deployment',btn('Details','public-url','tc-btn--ghost'),badge('Configured','muted','link'))}${row('link','T3 Connect','For the T3 app · Managed by T3',btn('Details','t3-connect','tc-btn--ghost'),badge('Available','ok'))}</div>`)}
  ${section('network-connections','Network connections',`<div class="tc-group">${row('globe','Work tailnet',`Managed here · Used by ${tailConsumers()}`,btn('Details','connection','tc-btn--ghost'),state.mode==='tailscale'?routeStatus():badge('Ready','ok'))}${state.mode==='cloudflare'&&hasInstall()?row('cloud','Cloudflare Access',`${esc(state.host)} · Used by SSH`,btn('Details','cloudflare-finish','tc-btn--ghost'),routeStatus()):''}${row('server','Office network','Managed on host · Container port mapping required',btn('Details','external','tc-btn--ghost'),badge('Not checked','muted','info'))}<div class="tc-card-foot">Connections can be shared by several services. Each route has its own readiness.</div></div>`,btn(`${icon('plus')} Add connection`,'add-connection','tc-btn--ghost'))}`;
}
function devices() {
  return `${section('pair-device','Pair a device',`<div class="tc-group"><div class="tc-card-body"><p class="helper">Pairing and device revocation keep their existing behavior. This prototype focuses on connections and optional services.</p></div>${row('smartphone','Work laptop','Current device · Browser access',btn('Details','device','tc-btn--ghost'),badge('Active','ok'))}</div>`)}${notice('Choose how you connect','Use Connections for network access, or SSH for terminal and editor setup.','',btn('Open SSH','open-ssh'))}`;
}
function serviceItems() {
  if (state.view==='available') return [
    {id:'openssh',name:'SSH server',mark:'terminal',meta:'Terminal, SFTP, and editor access · Optional download',status:hasInstall()?badge('Installed','muted','check'):badge('Available','muted','download'),action:hasInstall()?'inspect-ssh':'setup',label:hasInstall()?'Details':'Set up'},
    {id:'cloudflare',name:'Cloudflare connector',mark:'cloud',meta:'Named tunnels for supported application and SSH routes',status:state.mode==='cloudflare'&&hasInstall()?badge('Installed','muted','check'):badge('Available','muted','download'),action:state.mode==='cloudflare'&&hasInstall()?'cloudflare-finish':'cloudflare',label:state.mode==='cloudflare'&&hasInstall()?'Details':'Set up'}
  ];
  const rows = [
    ...(hasInstall()?[{id:'openssh',name:'SSH server',mark:'terminal',meta:`OpenSSH ${state.activeVersion} · Used by SSH access`,status:serviceStatus(),action:'inspect-ssh',label:'Details'}]:[]),
    {id:'tailscale',name:'Tailscale',mark:'globe',meta:`1.82.5 · Used by ${tailConsumers()}`,status:state.tailDisabled?badge('Disabled','muted','clock'):state.scenario==='expired'?badge('Sign-in expired','warn','circle-alert'):state.scenario==='stale'?badge('Status unavailable','muted','wifi-off'):badge('Running','ok'),action:'inspect-tail',label:'Details'},
    ...(state.mode==='cloudflare'&&hasInstall()?[{id:'cloudflare',name:'Cloudflare connector',mark:'cloud',meta:'Example installation · Used by SSH',status:state.connectorPending?badge('Setup required','warn','circle-alert'):badge('Running','ok'),action:'cloudflare-finish',label:'Details'}]:[])
  ];
  rows.push(...customServiceItems());
  if(state.view==='attention') return rows.filter(r => r.needsAttention||(state.scenario==='failed'&&r.id==='openssh')||(state.scenario==='expired'&&r.id==='tailscale')||state.scenario==='stale');
  return rows;
}
function serviceRows() {
  const items = serviceItems().filter(r=>`${r.name} ${r.meta} ${r.searchText||''}`.toLowerCase().includes(state.query.toLowerCase()));
  return items.length ? items.map(r=>row(r.mark,r.name,esc(r.meta),btn(r.label,r.action,'tc-btn--ghost'),r.status)).join('') : `<div class="empty-content"><h2>${state.query?'No matching services':state.view==='attention'?'No services need attention':'No optional services installed'}</h2><p>${state.query?'Try another name or clear your search.':state.view==='attention'?'Service issues that need action will appear here.':'Browse the catalogue to add a capability when you need it.'}</p>${btn(state.query?'Clear search':'Browse available',state.query?'clear-search':'browse')}</div>`;
}
function services() {
  return `<div class="page-body"><div class="service-toolbar"><div class="segmented" role="tablist" aria-label="Service views">${[['installed','Configured'],['attention','Needs attention'],['available','Available']].map(([id,label])=>`<button role="tab" id="view-${id}" aria-controls="services-panel" aria-selected="${state.view===id}" tabindex="${state.view===id?0:-1}" data-action="view-${id}">${label}</button>`).join('')}</div><div class="service-search">${icon('search')}<label class="tc-sr" for="service-search">Search services</label><input id="service-search" class="tc-input" placeholder="Search services" value="${esc(state.query)}"></div></div><div id="services-panel" role="tabpanel" aria-labelledby="view-${state.view}"><div class="tc-group" id="service-results">${serviceRows()}</div></div><p class="section-sub">Custom services reuse your installed tools and run as t3. Ports and tunnels are configured separately.</p></div>`;
}
function openSheet(kind, id) {
  if (!sheet.open) returnFocus = document.activeElement;
  state.modal = {kind,id};
  renderSheet();
  if (!sheet.open) sheet.showModal();
  const focus = $('.autofocus',sheet) || $('#sheet-title');
  focus?.focus();
}
function sizeSheet() {
  const inset=matchMedia('(max-width:540px)').matches?16:24;
  const available=Math.min(innerHeight,window.visualViewport?.height||innerHeight);
  sheet.style.setProperty('--dialog-max-block',`${Math.max(180,available-inset)}px`);
}
function closeSheet() {
  if(state.modal?.kind==='wizard') readWizard();
  if(state.modal?.kind==='custom-create') customReadDraft();
  sheet.close(); state.modal = null;
  if(returnFocus?.isConnected) returnFocus.focus(); else $('#page-title')?.focus();
}
function renderSheet() {
  sizeSheet();
  const {kind,id} = state.modal;
  let title='',description='',body='',footer='';
  const close = btn('Close','close');
  const custom = customSheet(kind,id);
  if(custom)({title,description,body,footer}=custom);
  if(kind==='wizard') {
    const w = state.wizard;
    title = 'Set up SSH'; description = `Step ${w.step} of 3 · ${['Choose a connection','Authorize your device','Review changes'][w.step-1]}`;
    if(w.step===1) body=`<p class="helper">Use a connection you already have, or add one for this server.</p><div class="option-list">${[
      ['tailscale','Work tailnet','Use the existing managed Tailscale connection.','globe'],
      ['existing','Existing network','Use a LAN, VPN, host connector, or mapped port.','server'],
      ['cloudflare','Add Cloudflare','Install a connector and configure an SSH hostname.','cloud']
    ].map(([v,t,d,i])=>`<label class="option"><input type="radio" name="connection" value="${v}" ${w.mode===v?'checked':''}><span><span class="option-title">${t}</span><small>${d}</small></span>${icon(i)}</label>`).join('')}</div><div id="external-field" class="field" ${w.mode!=='existing'?'hidden':''}><label for="external-host" class="tc-label">Client-visible hostname</label><input id="external-host" class="tc-input" value="${esc(w.host)}" placeholder="e.g. workstation.example.com" aria-describedby="external-help${w.error?' external-error':''}" ${w.error?'aria-invalid="true"':''}><p class="helper" id="external-help">The production flow also checks listener and port-mapping topology.</p>${w.error?`<p id="external-error" class="field-error" role="alert">${esc(w.error)}</p>`:''}</div>${notice('T3 Connect stays separate','T3 Connect connects the T3 app. SSH needs a network path that supports its protocol.')}`;
    if(w.step===2) body=keyFields(w.label,w.key,w.error,true);
    if(w.step===3) body=`${kv([['Install','OpenSSH 9.9p2'],['Connection',w.mode==='tailscale'?'Reuse Work tailnet':w.mode==='cloudflare'?'Install Cloudflare connector':'Existing network'],['Account','t3 · Public key only'],['Key label',esc(w.label||'My device')],['Listener',w.mode==='existing'?'Container interface :2222':'Container loopback :2222'],['Download','Size unavailable in prototype'],['Persistence','Protected service storage']])}<p class="helper">${w.mode==='existing'?'A reachable host port must map to the configured container listener. Review that deployment change before connecting.':w.mode==='cloudflare'?'After installation, finish account authorization, hostname, and Access policy setup.':'Reuse the signed-in connection. No new tailnet node is created.'}</p>${notice('What this changes','Installs and starts SSH, authorizes your public key, and adds the selected route. Existing T3 runtime and channel are preserved.')}`;
    footer=`${w.step>1?btn('Back','wizard-back','','data-left'):btn('Cancel','close','','data-left')}${btn(w.step===3?'Install and enable':'Continue','wizard-next','tc-btn--primary')}`;
  }
  if(kind==='progress') {
    title='Setting up SSH'; description='One saved operation · Safe to leave this view';
    const phases=['Checking requirements','Downloading packages','Verifying packages','Installing SSH','Checking service and route'];
    body=`<ol class="timeline">${phases.map((p,i)=>`<li class="${i>state.installStep?'pending':''}">${icon(i<state.installStep?'check':i===state.installStep?'refresh-cw':'clock')}<span>${p}${i===state.installStep?'<small>In progress · simulated step</small>':''}</span></li>`).join('')}</ol><p class="operation-id">${state.operationId}</p>${notice('Continue where you left off','Closing this view does not cancel the operation. Every entry point returns to this same operation ID.')}`;
    footer=`${btn('Continue in background','close','tc-btn--ghost')}${btn(state.installStep>=4?'Finish simulation':'Advance simulation','advance','tc-btn--primary')}`;
  }
  if(kind==='signin') {
    title='Sign in to Tailscale'; description='Restore Work tailnet';
    body=`${notice('Your SSH setup is retained','The installed service, authorized keys, and server identity stay in place. Only this connection needs sign-in.')}<p class="helper">In production, a short-lived provider link opens from this action. This prototype simulates completion without opening a provider or changing an account.</p>${kv([['Connection','Work tailnet'],['Used by','SSH and Workspace preview'],['Current status','Sign-in expired']])}`;
    footer=`${close}${btn(`${icon('external-link')} Simulate sign-in`,'complete-signin','tc-btn--primary')}`;
  }
  if(kind==='ssh'||kind==='tail') {
    const sshService=kind==='ssh'; title=sshService?'SSH server':'Tailscale'; description=sshService?'Incoming terminal and editor access':'Shared network connection';
    body=`${kv([['Status',sshService?serviceStatus():routeStatus()],['Version',sshService?`OpenSSH ${state.activeVersion}`:'1.82.5'],['Lifecycle owner','Managed here'],['Used by',sshService?'SSH access':tailConsumers()],['Storage','Protected persistent volume'],['Identity','Retained across disable and updates']])}<h3>Latest operation</h3><p class="helper">${state.scenario==='rollback'&&sshService?'Update rolled back. Previous version is running.':state.scenario==='failed'&&sshService?'Start failed: configured port is in use.':'Last readiness result is shown separately from device connection evidence.'}</p><div class="action-list">${btn(`${icon('activity')} Diagnostics`,sshService?'error':'tail-diagnostics','tc-btn--ghost')}${sshService?btn(`${icon('arrow-up')} Review update`,'update','tc-btn--ghost'):''}${btn(`${icon('clock')} ${sshService&&state.disabled?'Enable SSH':!sshService&&state.tailDisabled?'Enable connection':'Disable service'}`,sshService?(state.disabled?'enable-ssh':'disable-ssh'):(state.tailDisabled?'enable-tail':'disable-tail'),'tc-btn--ghost')}${btn(`${icon('box')} Uninstall`,sshService?'uninstall-ssh':'uninstall-tail','tc-btn--ghost tc-btn--danger')}</div>`;
    footer=close;
  }
  if(kind==='dependencies') {
    title=id==='uninstall'?'Tailscale is still in use':'This connection has dependents'; description='Review what would lose connectivity';
    body=`${notice('Resolve these routes first','Tailscale cannot be removed while these routes depend on it. Manage the routes or choose a replacement connection.','warn')}<div class="tc-group">${hasInstall()&&state.mode==='tailscale'?row('terminal','SSH access','Terminal and editor connections use Work tailnet'):''}${row('globe','Workspace preview','Private preview route uses Work tailnet')}</div><p class="helper">Your current access path cannot be confirmed from these server checks. Establish another way in before disabling a shared connection.</p>`;
    footer=`${close}${btn('Manage routes','manage-routes','tc-btn--primary')}`;
  }
  if(kind==='disable-ssh') {
    title='Disable SSH?'; description='This stops SSH and its owned routes';
    body=`${notice('New SSH connections will be unavailable','Active SSH sessions may be interrupted. Browser access remains available in this example.','warn')}<p class="helper">Retain authorized keys, server identity, configuration, and the installed version. Tailscale is shared and will stay running.</p>`;
    footer=`${btn('Cancel','close')}${btn('Disable SSH','confirm-disable','tc-btn--danger-solid')}`;
  }
  if(kind==='uninstall-ssh') {
    title='Uninstall SSH?'; description='Remove its payload after stopping the service';
    body=`<p class="helper">Remove SSH and its owned routes. Keep its public-key authorizations, configuration, and server identity for a later reinstall. Shared Tailscale remains installed.</p>${notice('Access will be interrupted','Review another access path before removing this service. Identity deletion is a separate action.','warn')}`;
    footer=`${btn('Cancel','close')}${btn('Uninstall SSH','confirm-uninstall','tc-btn--danger-solid')}`;
  }
  if(kind==='connection') {
    title='Work tailnet'; description='Tailscale · Managed here';
    body=`${kv([['Connection',routeStatus()],['Hostname',esc(state.host)],['Supported routes','SSH, HTTP, TCP'],['Used by','SSH, Workspace preview'],['Checked',state.scenario==='stale'?'8 minutes ago · stale':'30 seconds ago']])}<p class="helper">Provider and local checks do not prove that a particular device can reach this route. Account logout and local disable are separate operations.</p><div class="action-list">${btn('View service','inspect-tail','tc-btn--ghost')}${btn('Disable connection','disable-tail','tc-btn--ghost')}${btn('Disconnect account','disconnect','tc-btn--ghost tc-btn--danger')}</div>`;
    footer=close;
  }
  if(kind==='disconnect') {
    title='Disconnect Work tailnet?'; description='Provider access must be revoked separately from stopping locally';
    body=`${notice('Two routes depend on this account','Move or disable SSH and Workspace preview routes before disconnecting.','warn')}<p class="helper">If provider logout cannot be confirmed, cleanup stays pending. The console must not report revocation merely because the local process stopped.</p>`;
    footer=`${close}${btn('Manage routes','manage-routes','tc-btn--primary')}`;
  }
  if(kind==='error'||kind==='tail-diagnostics') {
    title=kind==='error'?'SSH diagnostics':'Connection diagnostics'; description='Sanitized example · No secrets';
    const failed=kind==='error'&&state.scenario==='failed';
    const log=state.scenario==='stale'?'controller observation unavailable\nlast known state: stale':kind==='error'?(failed?'sshd: bind to port 2222: Address already in use\nretry budget exhausted; service stopped\nretained: host identity and authorized keys':state.disabled?'desired state: disabled\nidentity and configuration retained':'local SSH handshake: passed\nclient route evidence: not verified'):(state.scenario==='expired'?'provider: sign-in expired\nroute: unavailable\nSSH service: still running':'provider: signed in\nroute: declared local endpoint\nclient reachability: not verified');
    body=`${failed?notice('Port 2222 is already in use','SSH stopped after its retry budget was exhausted. Review the conflicting listener before retrying.','danger'):notice('Service checks','These diagnostics are simulated. They show the distinction between local readiness and client evidence.')}<pre class="log-view">${log}</pre><p class="operation-id">${state.operationId} · ${failed?'SSH_LISTENER_CONFLICT':kind==='error'?'SSH_CHECK':'CONNECTION_CHECK'}</p>`;
    footer=`${close}${btn(state.scenario==='failed'?'Simulate conflict resolved':'Run checks',state.scenario==='failed'?'resolve-failure':'recheck','tc-btn--primary')}`;
  }
  if(kind==='update') {
    title='Update SSH server'; description='Review the service change';
    body=`${kv([['Current','9.9p2'],['Candidate','10.0p2 · Example version'],['Source','Curated, verified artifact'],['Affected','SSH service and owned routes'],['Core runtime','No version or channel change'],['Recovery','Retain 9.9p2 and current configuration']])}${notice('SSH access will be interrupted','Sessions may disconnect during replacement. If readiness fails, restore the previous version.','warn')}<p class="helper">The simulation deliberately exercises a readiness failure and rollback. It does not claim a real update was tested.</p>`;
    footer=`${btn('Cancel','close')}${btn('Simulate update and rollback','simulate-update','tc-btn--primary')}`;
  }
  if(kind==='rollback') {
    title='Update rolled back'; description='Previous version is running';
    body=`${notice('Candidate did not pass readiness','OpenSSH 10.0p2 failed its local handshake check. Restored OpenSSH 9.9p2 with the previous configuration.','warn')}<ol class="timeline"><li>${icon('check')}<span>Candidate verified and installed</span></li><li>${icon('circle-alert')}<span>Readiness failed<small>No successful local SSH handshake</small></span></li><li>${icon('check')}<span>Previous version restored<small>OpenSSH 9.9p2 running · Route check passed</small></span></li></ol><p class="operation-id">op-demo-update-7b32</p><p class="helper">Reconnect from your device. A server-local check does not verify your current client route.</p>`;
    footer=`${close}${btn('View service','inspect-ssh','tc-btn--primary')}`;
  }
  if(kind==='storage') {
    title='Add persistent service storage'; description='One deployment change before installation';
    body=`<p class="helper">Optional service binaries and identities need a protected persistent volume. A container restart alone does not attach one.</p><div class="command"><pre id="deployment-patch">services:\n  t3code:\n    volumes:\n      - t3code-services:/var/lib/t3code/services\nvolumes:\n  t3code-services:</pre>${btn(`${icon('copy')}<span class="tc-sr">Copy illustrative volume fragment</span>`,'copy-patch','tc-btn--ghost tc-btn--icon')}</div>${notice('Illustrative fragment only','Merge this with the actual deployment. Keep existing mounts, environment, image pin, ports, and runtime selection. A recreate is required.')}<p class="helper">The production console must inspect your deployment before generating an exact patch. This prototype cannot inspect or modify it.</p>`;
    footer=`${close}${btn('Simulate storage attached','storage-fixed','tc-btn--primary')}`;
  }
  if(kind==='add-key') {
    title='Add an SSH key'; description='Authorize another device'; body=keyFields('','','',false);
    footer=`${btn('Cancel','close')}${btn('Add key','save-key','tc-btn--primary')}`;
  }
  if(kind==='key') {
    const key=state.keys.find(k=>k.id===id); title=key?.label||'SSH key'; description='Incoming SSH authorization';
    body=`${kv([['Type',esc(key?.type||'ED25519')],['Fingerprint',`<span class="fingerprint">${esc(key?.fp||'')}</span>`],['Last sign-in',state.deviceObserved?'Observed in simulation':'Not observed']])}<p class="helper">Removing a public key blocks future authentication. Existing sessions may remain connected.</p>`;
    footer=`${close}${btn('Remove key',`remove-key-${id}`,'tc-btn--danger')}`;
  }
  if(kind==='remove-key') {
    title='Remove SSH key?'; description=state.keys.find(k=>k.id===id)?.label||'Selected device';
    body=`${notice(state.keys.length===1?'This is the last authorized key':'Future sign-ins will be blocked',state.keys.length===1?'Make sure you can still use browser or host access before removing it. Existing sessions may remain.':'Existing sessions may remain connected. Other keys are unaffected.','warn')}`;
    footer=`${btn('Cancel','close')}${btn('Remove key',`confirm-remove-${id}`,'tc-btn--danger-solid')}`;
  }
  if(kind==='verify') {
    title='Connection evidence'; description='Each check has a different scope';
    body=`${kv([['Local service',ready()?'SSH handshake passed':'See current service status'],['Connection',routeStatus()],['Device sign-in',state.deviceObserved?'Observed in simulation':'Not observed'],['Exact client route','Not verified']])}<p class="helper">An authenticated route challenge is needed to verify the exact path from your device. A login alone only establishes that a sign-in occurred.</p><p class="helper">Use the action below to explore the observed-login copy. It does not make a real connection.</p>`;
    footer=`${close}${btn('Simulate SSH sign-in','simulate-login','tc-btn--primary')}`;
  }
  if(kind==='add-connection') {
    title='Add a connection'; description='Choose who manages the network path';
    body=`<div class="action-list">${btn(`${icon('globe')} Tailscale`,'tailscale-options','tc-btn--ghost')}${btn(`${icon('cloud')} Cloudflare`,'cloudflare','tc-btn--ghost')}${btn(`${icon('server')} Existing host or sidecar`,'external','tc-btn--ghost')}</div><p class="helper">Connections are shared resources. Reuse an existing one before creating another identity.</p>`;
    footer=close;
  }
  if(kind==='cloudflare'||kind==='tailscale-options') {
    const cloud=kind==='cloudflare'; title=cloud?'Cloudflare connection':'Tailscale connection'; description='Configuration contract';
    body=`${notice(cloud?'SSH requires a named route':'Reuse your existing connection',cloud?'Configure a hostname, tunnel and Access policy. Client-side cloudflared may be required. An HTTP quick tunnel is not a raw SSH endpoint.':'Work tailnet already serves this container. Reuse it to avoid creating another node.')}<p class="helper">${cloud?'The full provider configuration is specified in the UI contract. This reference implements the shared service shell and SSH setup, rather than simulating an entire Cloudflare account console.':'The installation review checks kernel or proven userspace mode, persistent identity, and required deployment permissions.'}</p>`;
    footer=`${close}${btn(cloud?'Explore SSH setup':'Use Work tailnet','connector-setup','tc-btn--primary')}`;
  }
  if(kind==='cloudflare-finish') {
    title='Cloudflare SSH route';description=state.connectorPending?'Finish account and route setup':'Managed connection · Example configuration';
    body=`${kv([['Hostname',esc(state.host)],['Route','SSH to local endpoint :2222'],['Client helper','cloudflared on your device'],['Authorization','Cloudflare Access and your SSH key']])}<p class="helper">Production requires account authorization, a named tunnel, a hostname, and a checked Access policy. The provider-specific steps must reconcile independently.</p>${notice('Simulation only','Completing this example stands in for those configuration steps. It opens no provider page and makes no network changes.')}`;
    footer=`${close}${state.connectorPending?btn('Simulate route configured','complete-cloudflare','tc-btn--primary'):''}`;
  }
  if(kind==='external') {
    title='Office network'; description='Managed on host';
    body=`${kv([['Lifecycle owner','Host or Compose'],['Local service','SSH listener on container interface'],['Client endpoint','Operator-provided host and port'],['External status','Unknown until checked']])}<p class="helper">A host port mapping cannot reach a daemon bound only to container loopback. Configure the listener and mapping together. Setup can export guidance and test declared endpoints, but cannot restart your host connector.</p>`;
    footer=close;
  }
  if(['public-url','t3-connect','device'].includes(kind)) {
    title=kind==='public-url'?'Public URL':kind==='t3-connect'?'T3 Connect':'Work laptop'; description='Existing Access behavior';
    body=notice('Kept in its existing flow',kind==='t3-connect'?'T3 owns its application connection. It is not advertised as an SSH transport.':kind==='public-url'?'The configured application URL remains unchanged by optional service setup.':'Pairing and device revocation remain independent of SSH public-key authorization.');
    footer=close;
  }
  sheet.innerHTML=`<div class="sheet-layout"><header class="sheet-header"><div><h2 id="sheet-title" tabindex="-1">${esc(title)}</h2><p id="sheet-description">${esc(description)}</p></div>${btn(`${icon('x')}<span class="tc-sr">Close ${esc(title)}</span>`,'close','tc-btn--ghost tc-btn--icon')}</header><div class="sheet-body">${body}</div><footer class="sheet-footer">${footer}</footer></div>`;
}
function keyFields(label,key,error,onboarding) {
  return `<div class="field"><label class="tc-label" for="key-label">Key label <span class="tc-label-opt">optional</span></label><input class="tc-input autofocus" id="key-label" value="${esc(label)}" placeholder="e.g. Work laptop" maxlength="80"></div><div class="field"><label class="tc-label" for="public-key">Public key</label><textarea class="tc-input tc-input--mono" id="public-key" placeholder="ssh-ed25519 AAAA…" aria-describedby="key-help${error?' key-error':''}" ${error?'aria-invalid="true"':''}>${esc(key)}</textarea><p id="key-help" class="helper">Paste a public key from your device, usually a file ending in .pub. Your private key stays on your device.</p>${error?`<p id="key-error" class="field-error" role="alert">${esc(error)}</p>`:''}</div>${btn('Use sample public key','sample-key','tc-btn--ghost')}<p class="helper">${onboarding?'Authorize at least one device before enabling SSH. ':''}This prototype checks basic format only. Production uses OpenSSH validation and computes the actual fingerprint.</p>`;
}
function readWizard() {
  const w=state.wizard;
  if($('input[name="connection"]:checked',sheet)) w.mode=$('input[name="connection"]:checked',sheet).value;
  if($('#external-host')) w.host=$('#external-host').value;
  if($('#key-label')) w.label=$('#key-label').value;
  if($('#public-key')) w.key=$('#public-key').value;
}
function keyError(value) {
  if(/PRIVATE KEY/.test(value)) return 'This is a private key. Paste only its public key.';
  if(!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))\s+[A-Za-z0-9+/]{24,}={0,2}(?:\s+[^\r\n]*)?$/.test(value.trim())) return 'Paste a complete supported public key.';
  return '';
}
async function copyText(value,source) {
  let copied=false;
  try { if(navigator.clipboard?.writeText) {await navigator.clipboard.writeText(value);copied=true;} } catch {}
  if(!copied) {
    const area=document.createElement('textarea'); area.value=value; area.style.cssText='position:fixed;left:-9999px;top:0'; (sheet.open?sheet:document.body).append(area); area.select();
    try { copied=document.execCommand('copy'); } catch {} area.remove();
  }
  if(copied) toast('Copied');
  else {
    const range=document.createRange();range.selectNodeContents(source);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    announce(`Text selected. Press ${/Mac|iPhone|iPad/.test(navigator.platform)?'Command C':'Ctrl C'} to copy.`);
    toast(`Text selected. Press ${/Mac|iPhone|iPad/.test(navigator.platform)?'Command C':'Ctrl C'} to copy.`);
  }
}
async function act(action) {
  if(action==='add-service'||action.startsWith('custom-'))return customAct(action);
  if(action==='close') return closeSheet();
  if(action==='nav-access') return navigate('access');
  if(action==='nav-services') return navigate('services');
  if(action.startsWith('tab-')) {state.tab=action.slice(4);try{history.pushState(null,'',`#access/${state.tab}`);}catch{}renderApp(`access-${state.tab}`);return;}
  if(action.startsWith('client-')) {state.client=action.slice(7);renderApp(`client-${state.client}`);return;}
  if(action.startsWith('view-')) {state.view=action.slice(5);renderApp(`view-${state.view}`);return;}
  if(action==='open-ssh') return navigate('access','ssh');
  if(action==='setup') return openSheet(state.scenario==='storage'?'storage':'wizard');
  if(action==='wizard-back') {readWizard();state.wizard.step--;state.wizard.error='';renderSheet();$('#sheet-title').focus();return;}
  if(action==='wizard-next') {
    readWizard();const w=state.wizard;
    if(w.step===1&&w.mode==='existing'&&!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(w.host.trim())) {w.error='Enter a client-visible hostname.';renderSheet();$('#external-host').focus();return;}
    if(w.step===1)w.error='';
    if(w.step===2) {w.error=keyError(w.key);if(w.error){if(/PRIVATE KEY/.test(w.key))w.key='';renderSheet();$('#public-key').focus();return;}}
    if(w.step<3) {w.step++;renderSheet();$('#sheet-title').focus();return;}
    state.mode=w.mode;state.host=w.mode==='tailscale'?'t3-workstation.example.ts.net':w.mode==='cloudflare'?'ssh.example.com':w.host;
    state.keys=[{id:1,label:w.label||'My device',type:'ED25519',fp:w.key===SAMPLE_KEY?KEY_FP:'Pending server validation (prototype)',last:'Not observed'}];
    state.scenario='installing';state.installStep=0;$('#scenario').value='installing';renderApp();return openSheet('progress');
  }
  if(action==='sample-key') {$('#public-key').value=SAMPLE_KEY;if(!$('#key-label').value)$('#key-label').value='Work laptop';$('#public-key').removeAttribute('aria-invalid');$('#public-key').focus();return;}
  if(action==='advance') {if(state.installStep<4) {state.installStep++;renderSheet();$('#sheet-title').focus();announce('Next simulated installation step.');} else {state.scenario='ready';state.connectorPending=state.mode==='cloudflare';state.wizard.step=1;$('#scenario').value='ready';renderApp();closeSheet();toast(state.connectorPending?'SSH installed in simulation. Finish connection setup.':'Simulation complete. Ready to connect.');}return;}
  if(action==='complete-cloudflare') {state.connectorPending=false;renderApp();closeSheet();toast('Simulation: route configured. Ready to connect.');return;}
  if(action==='recheck') {state.checked=true;if(state.scenario==='stale'){state.scenario='ready';$('#scenario').value='ready';}if(sheet.open)closeSheet();renderApp();toast(state.scenario==='failed'?'SSH check failed. Review the listener conflict.':state.scenario==='expired'?'SSH is running. Connection sign-in is still required.':'Readiness checked. Device reachability has not been verified.');return;}
  if(action==='resolve-failure') {state.scenario='ready';$('#scenario').value='ready';renderApp();closeSheet();toast('Simulation: SSH started after the listener conflict was resolved.');return;}
  if(action==='complete-signin') {state.scenario='ready';$('#scenario').value='ready';renderApp();closeSheet();toast('Simulation: connection sign-in restored.');return;}
  if(action==='simulate-update') {state.scenario='rollback';$('#scenario').value='rollback';renderApp();return openSheet('rollback');}
  if(action==='storage-fixed') {state.scenario='fresh';$('#scenario').value='fresh';renderApp();return openSheet('wizard');}
  if(action==='disable-tail'||action==='uninstall-tail') return openSheet('dependencies',action==='uninstall-tail'?'uninstall':'disable');
  if(action==='manage-routes') {closeSheet();return navigate('access','connections');}
  if(action==='confirm-disable') {state.disabled=true;renderApp();closeSheet();toast('SSH disabled. Keys and identity retained.');return;}
  if(action==='enable-ssh'||action==='enable-tail') {state[action==='enable-ssh'?'disabled':'tailDisabled']=false;if(sheet.open)closeSheet();renderApp();toast('Enabled in simulation.');return;}
  if(action==='confirm-uninstall') {setScenario('fresh',false);closeSheet();toast('SSH payload removed in simulation. Identity retention is specified in the design.');return;}
  if(action==='simulate-login') {state.deviceObserved=true;renderApp();renderSheet();$('#sheet-title').focus();announce('SSH sign-in observed. Exact route remains unverified.');return;}
  if(action==='copy-command') return copyText($('#client-command').textContent,$('#client-command'));
  if(action==='copy-fingerprint') return copyText(HOST_FP,$('.fingerprint'));
  if(action==='copy-patch') return copyText($('#deployment-patch').textContent,$('#deployment-patch'));
  if(action==='save-key') {
    const value=$('#public-key').value,label=$('#key-label').value||'My device',error=keyError(value);
    if(error){const privateKey=/PRIVATE KEY/.test(value);$('.sheet-body',sheet).innerHTML=keyFields(label,privateKey?'':value,error,false);$('#public-key').focus();return;}
    if(state.keys.some(k=>k.fp===KEY_FP)&&value===SAMPLE_KEY){announce('This sample key is already authorized.');$('.sheet-body',sheet).innerHTML=keyFields(label,value,'This public key is already authorized.',false);$('#public-key').focus();return;}
    state.keys.push({id:Date.now(),label,type:'ED25519',fp:value===SAMPLE_KEY?KEY_FP:'Pending server validation (prototype)',last:'Not observed'});renderApp();closeSheet();toast('Public key added in simulation.');return;
  }
  if(action.startsWith('confirm-remove-')) {state.keys=state.keys.filter(k=>k.id!==Number(action.slice(15)));renderApp();closeSheet();toast('Key removed in simulation. Existing sessions may remain.');return;}
  if(action.startsWith('remove-key-')) return openSheet('remove-key',Number(action.slice(11)));
  if(action.startsWith('key-')) return openSheet('key',Number(action.slice(4)));
  if(action==='clear-search') {state.query='';$('#service-search').value='';$('#service-results').innerHTML=serviceRows();$('#service-search').focus();return;}
  if(action==='browse') {state.view='available';state.query='';renderApp('view-available');return;}
  if(action==='connector-setup') {state.wizard.mode=state.modal.kind==='cloudflare'?'cloudflare':'tailscale';return openSheet('wizard');}
  const map={'inspect-ssh':'ssh','inspect-tail':'tail','progress':'progress','signin':'signin','error':'error','rollback':'rollback','storage':'storage','add-key':'add-key','disable-ssh':'disable-ssh','uninstall-ssh':'uninstall-ssh','connection':'connection','update':'update','verify':'verify','add-connection':'add-connection','cloudflare':'cloudflare','cloudflare-finish':'cloudflare-finish','tailscale-options':'tailscale-options','external':'external','public-url':'public-url','t3-connect':'t3-connect','device':'device','disconnect':'disconnect','tail-diagnostics':'tail-diagnostics'};
  if(map[action])return openSheet(map[action]);
  throw new Error(`Unimplemented prototype action: ${action}`);
}
document.addEventListener('click',e=>{const button=e.target.closest('[data-action]');if(button)act(button.dataset.action).catch(error=>{console.error(error);announce('Prototype interaction failed.');});});
document.addEventListener('input',e=>{if(e.target.id==='service-search'){state.query=e.target.value;$('#service-results').innerHTML=serviceRows();}customInput(e.target);});
document.addEventListener('change',e=>{
  customChange(e.target);
  if(e.target.id==='scenario')setScenario(e.target.value);
  if(e.target.id==='appearance'){const val=e.target.value;document.documentElement.dataset.theme=val==='host'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):val;$('#prototype').dataset.palette=val==='host'?'host':'standalone';}
  if(e.target.id==='page-select')navigate(e.target.value);
  if(e.target.name==='connection'){$('#external-field').hidden=e.target.value!=='existing';}
});
document.addEventListener('keydown',e=>{
  const tab=e.target.closest('[role="tab"]');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
  const tabs=[...tab.parentElement.querySelectorAll('[role="tab"]')],i=tabs.indexOf(tab);
  const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  e.preventDefault();tabs[next].click();
});
sheet.addEventListener('cancel',e=>{e.preventDefault();closeSheet();});
window.addEventListener('resize',sizeSheet);
window.visualViewport?.addEventListener('resize',sizeSheet);
window.addEventListener('popstate',()=>{state.page=location.hash.startsWith('#services')?'services':'access';const tab=location.hash.split('/')[1];if(['devices','connections','ssh'].includes(tab))state.tab=tab;renderApp();});
document.documentElement.dataset.theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
setScenario(window.__PROTOTYPE_SCENARIO__||'ready',false);
if(location.hash.startsWith('#services')){state.page='services';renderApp();}
window.__prototype = {state,act,setScenario,renderApp,openSheet,closeSheet,keyError,command};
