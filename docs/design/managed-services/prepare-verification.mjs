import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Creates self-contained inputs for T3 html_preview. No browser driver or server.
const here=path.dirname(fileURLToPath(import.meta.url));
const original=fs.readFileSync(path.join(here,'prototype.html'),'utf8');
const out=path.join(os.tmpdir(),'t3-managed-services-design-qa');
fs.mkdirSync(out,{recursive:true});
const variants={
  'mobile-ready': ``,
  'phone-large-text': `document.documentElement.style.setProperty('--prototype-font-size','20px');`,
  'small-text': `document.documentElement.style.setProperty('--prototype-font-size','12px');`,
  'services': `__prototype.state.page='services';__prototype.renderApp();`,
  'wizard-key': `__prototype.setScenario('fresh',false);__prototype.openSheet('wizard');__prototype.act('wizard-next');__prototype.act('sample-key');`,
  'wizard-key-large': `document.documentElement.style.setProperty('--prototype-font-size','20px');__prototype.setScenario('fresh',false);__prototype.openSheet('wizard');__prototype.act('wizard-next');__prototype.act('sample-key');`,
  'dependencies': `__prototype.openSheet('dependencies','disable');`,
  'rollback': `__prototype.setScenario('rollback',false);__prototype.openSheet('rollback');`,
  'expired': `__prototype.setScenario('expired',false);`,
  'storage': `__prototype.setScenario('storage',false);__prototype.openSheet('storage');`
  ,'custom-list': `__prototype.setScenario('custom',false);`
  ,'custom-command': `__prototype.setScenario('custom',false);__prototype.act('custom-new');__prototype.act('custom-example');`
  ,'custom-behavior': `__prototype.setScenario('custom',false);__prototype.act('custom-new');__prototype.act('custom-example');__prototype.act('custom-next');`
  ,'custom-review': `__prototype.setScenario('custom',false);__prototype.act('custom-new');__prototype.act('custom-example');__prototype.act('custom-next');__prototype.act('custom-next');`
  ,'custom-inspector': `__prototype.setScenario('custom',false);__prototype.act('custom-inspect-demo-user-1');`
  ,'custom-review-large': `document.documentElement.style.setProperty('--prototype-font-size','20px');__prototype.setScenario('custom',false);__prototype.act('custom-new');__prototype.act('custom-example');__prototype.act('custom-next');__prototype.act('custom-next');`
};
const measure=String.raw`
const isVisible=el=>!!(el.getBoundingClientRect().width&&el.getBoundingClientRect().height)&&!el.closest('[hidden]');
const overflow=[...document.querySelectorAll('#prototype *')].filter(isVisible).filter(el=>{
 const r=el.getBoundingClientRect();return r.left<-.5||r.right>document.documentElement.clientWidth+.5;
}).map(el=>el.id||el.className?.baseVal||el.className||el.tagName).slice(0,12);
const dialog=document.getElementById('sheet'),footer=dialog.querySelector('.sheet-footer');
const footerVisible=!dialog.open||(footer.getBoundingClientRect().bottom<=dialog.getBoundingClientRect().bottom+1&&footer.getBoundingClientRect().top>=dialog.getBoundingClientRect().top);
console.info('LAYOUT '+JSON.stringify({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow,fontLoaded:document.fonts.check('14px "Inter Variable"'),fontSize:getComputedStyle(document.documentElement).fontSize,dialogOpen:dialog.open,dialogHeight:dialog.getBoundingClientRect().height,footerVisible}));`;
for(const [name,script] of Object.entries(variants)) {
  const extra=`<script>(async()=>{${script}\nawait document.fonts.ready;${measure}})().catch(console.error);</script>`;
  fs.writeFileSync(path.join(out,`${name}.html`),original.replace('</body>',`${extra}</body>`));
}
const checks=String.raw`
const p=__prototype, results=[];
const assert=(name,ok)=>{results.push({name,passed:!!ok});if(!ok)throw Error('QA failed: '+name);};
const click=async action=>{await p.act(action);};
assert('default states distinguish local ready and unobserved device',document.body.textContent.includes('Ready to connect')&&document.body.textContent.includes('No device sign-in observed'));
await click('tab-connections');assert('Access tab retains keyboard focus',document.activeElement.id==='access-connections');
document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
assert('ArrowRight operates Access tabs',p.state.tab==='ssh'&&document.activeElement.id==='access-ssh');
await click('client-config');assert('client config derives from selected route',document.getElementById('client-command').textContent.includes('Port 2222'));
await click('verify');await click('simulate-login');assert('ordinary sign-in never proves exact route',document.body.textContent.includes('exact network route has not been verified')&&document.getElementById('sheet').textContent.includes('Not verified'));
p.closeSheet();p.setScenario('fresh',false);await click('setup');assert('setup dialog named and open',document.getElementById('sheet').open&&!!document.getElementById('sheet-title').textContent);
await click('wizard-next');await click('wizard-next');assert('missing key focuses inline invalid field',document.activeElement.id==='public-key'&&document.getElementById('public-key').getAttribute('aria-invalid')==='true');
document.getElementById('public-key').value='-----BEGIN OPENSSH PRIVATE KEY----- CANARY_NEVER_ECHO';
await click('wizard-next');assert('private key is cleared without echo',!document.getElementById('public-key').value&&!document.getElementById('sheet').textContent.includes('CANARY_NEVER_ECHO'));
await click('sample-key');document.getElementById('key-label').value='My studio laptop';await click('wizard-back');await click('wizard-next');assert('wizard back preserves key draft',document.getElementById('key-label').value==='My studio laptop');
await click('wizard-next');assert('review includes install and dependency changes',document.getElementById('sheet').textContent.includes('Reuse Work tailnet'));
await click('wizard-next');const op=p.state.operationId;assert('submit creates simulated durable operation',p.state.scenario==='installing');await click('close');await click('progress');assert('background returns to same operation',p.state.operationId===op&&document.getElementById('sheet').textContent.includes(op));
for(let i=0;i<5;i++)await click('advance');assert('setup reaches ready with key label intact',p.state.scenario==='ready'&&p.state.keys[0].label==='My studio laptop');
p.state.keys[0].label='<img src=x onerror=alert(1)>';p.renderApp();assert('user labels remain literal text',!document.querySelector('#app img')&&document.getElementById('app').textContent.includes('<img src=x onerror=alert(1)>'));
await click('add-key');await click('sample-key');await click('save-key');assert('duplicate authorization rejected',document.getElementById('sheet').textContent.includes('already authorized')&&p.state.keys.length===1);p.closeSheet();
await click('disable-tail');assert('dependency review lists both consumers',document.getElementById('sheet').textContent.includes('SSH access')&&document.getElementById('sheet').textContent.includes('Workspace preview')&&!p.state.tailDisabled);p.closeSheet();
await click('update');await click('simulate-update');assert('rollback restores and labels previous version',p.state.activeVersion==='9.9p2'&&document.getElementById('sheet-title').textContent==='Update rolled back');p.closeSheet();
p.setScenario('expired',false);const fp=p.state.keys[0].fp;await click('signin');await click('complete-signin');assert('sign-in repair preserves authorization',p.state.keys[0].fp===fp&&p.state.scenario==='ready');
p.setScenario('failed',false);await click('error');assert('failure provides actionable cause',document.getElementById('sheet').textContent.includes('already in use'));await click('resolve-failure');assert('failure remedy does not reinstall identity',p.state.keys[0].fp===fp&&p.state.scenario==='ready');
p.setScenario('storage',false);await click('setup');assert('storage gate does not pretend patch is applied',document.getElementById('sheet').textContent.includes('Illustrative fragment only'));await click('storage-fixed');assert('storage remedy returns to setup',p.state.modal.kind==='wizard');p.closeSheet();
p.setScenario('fresh',false);await click('setup');document.querySelector('input[value=existing]').checked=true;document.querySelector('input[value=existing]').dispatchEvent(new Event('change',{bubbles:true}));await click('wizard-next');assert('hostname error is visible and focused',document.getElementById('external-error').textContent&&document.activeElement.id==='external-host');p.closeSheet();
p.setScenario('fresh',false);p.state.wizard.mode='cloudflare';await click('setup');await click('wizard-next');await click('sample-key');await click('wizard-next');await click('wizard-next');for(let i=0;i<5;i++)await click('advance');assert('Cloudflare install waits for separate route setup',p.state.connectorPending&&document.body.textContent.includes('Finish the Cloudflare connection'));await click('cloudflare-finish');await click('complete-cloudflare');assert('Cloudflare instructions include client helper',p.command().includes('cloudflared access ssh'));
p.setScenario('stale',false);assert('stale includes last-known time',document.body.textContent.includes('8 minutes ago'));await click('recheck');assert('recheck does not invent device evidence',!p.state.deviceObserved);
await click('nav-services');document.getElementById('service-search').focus();document.getElementById('service-search').value='zzzzz';document.getElementById('service-search').dispatchEvent(new Event('input',{bubbles:true}));assert('filter preserves focus and gives empty recovery',document.activeElement.id==='service-search'&&document.getElementById('service-results').textContent.includes('No matching services'));await click('clear-search');assert('clear filter restores results',document.getElementById('service-results').textContent.includes('Tailscale'));
await click('view-available');document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));assert('Home operates Services tablist',p.state.view==='installed'&&document.activeElement.id==='view-installed');
for(const scenario of ['ready','fresh','installing','expired','failed','storage','rollback','stale','custom']){p.setScenario(scenario,false);assert('scenario '+scenario+' renders without overflow',document.documentElement.scrollWidth<=innerWidth+1);}
p.setScenario('ready',false);
await click('nav-services');await click('add-service');assert('Add service offers both sources',document.getElementById('sheet').textContent.includes('From catalogue')&&document.getElementById('sheet').textContent.includes('Custom service'));
await click('custom-new');await click('custom-next');assert('custom name validation is inline and focused',document.activeElement.id==='custom-name'&&document.getElementById('custom-name').getAttribute('aria-invalid')==='true');
await click('custom-example');document.getElementById('custom-name').value='My preview';document.getElementById('custom-args').value+='\nhello world\n$(touch CANARY)';
await click('close');await click('add-service');await click('custom-new');assert('closing custom form preserves draft',document.getElementById('custom-name').value==='My preview'&&document.getElementById('custom-args').value.includes('hello world'));
await click('custom-next');document.getElementById('custom-health').value='http';document.getElementById('custom-health').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('custom-port').value='0';await click('custom-next');assert('invalid local probe port is focused',document.activeElement.id==='custom-port'&&document.getElementById('custom-port-error').textContent.includes('65535'));
document.getElementById('custom-port').value='8081';document.querySelector('.custom-advanced').open=true;document.getElementById('custom-env').value='PREVIEW_API_KEY';document.getElementById('custom-vault').value='demo-preview-token';await click('custom-next');
assert('custom review pins version account and selected secret reference',document.getElementById('sheet').textContent.includes('python@3.13.2')&&document.getElementById('sheet').textContent.includes('t3 · Custom service')&&document.getElementById('sheet').textContent.includes('PREVIEW_API_KEY ← Development preview token'));
assert('command review preserves literal shell metacharacters',document.getElementById('sheet').textContent.includes("'hello world'")&&document.getElementById('sheet').textContent.includes('$(touch CANARY)'));
await click('custom-next');const cs=p.state.customServices[0],cid=cs.id;assert('custom creation registers only one user service',p.state.customServices.length===1&&cs.runtime==='running'&&cs.tool==='python@3.13.2');await click('custom-next');assert('duplicate UI submission does not create another registration',p.state.customServices.length===1);
const beforeRun=cs.run;await click('custom-edit-'+cid);document.getElementById('custom-name').value='<img src=x onerror=alert(1)>';await click('custom-next');await click('custom-next');await click('custom-next');assert('name-only edit preserves process run',p.state.customServices[0].run===beforeRun);assert('custom inspector headings escape user names',!document.querySelector('#sheet img')&&document.getElementById('sheet-title').textContent==='<img src=x onerror=alert(1)>');
await click('custom-stop-'+cid);assert('temporary stop keeps startup policy and explains resumption',p.state.customServices[0].enabled&&p.state.customServices[0].runtime==='stopped'&&document.getElementById('sheet').textContent.includes('next container startup'));
await click('custom-enable-'+cid);await click('custom-restart-'+cid);assert('start and restart update the owned simulated run',p.state.customServices[0].runtime==='running'&&p.state.customServices[0].run===beforeRun+2);
await click('custom-logs-'+cid);document.getElementById('custom-log-search').focus();document.getElementById('custom-log-search').value='no match';document.getElementById('custom-log-search').dispatchEvent(new Event('input',{bubbles:true}));assert('log filtering preserves focus and has empty result',document.activeElement.id==='custom-log-search'&&document.getElementById('custom-log-output').textContent==='No matching log messages.');await click('custom-pause');assert('pausing logs leaves service running',p.state.customLogsPaused&&p.state.customServices[0].runtime==='running');
await click('custom-disable-'+cid);assert('disable persists startup off',!p.state.customServices[0].enabled&&p.state.customServices[0].runtime==='disabled');
await click('custom-remove-'+cid);assert('custom removal does not uninstall tools or data',document.getElementById('sheet').textContent.includes('Keep installed mise tools, application files, Vault entries'));await click('custom-confirm-remove-'+cid);assert('removal unregisters the selected service only',p.state.customServices.length===0&&document.getElementById('service-results').textContent.includes('Tailscale'));
await click('custom-new');document.getElementById('custom-mode').value='shell';document.getElementById('custom-mode').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('custom-name').value='Worker';document.getElementById('custom-directory').value='/home/t3/workspace';await click('custom-next');assert('empty explicit script is rejected',document.activeElement.id==='custom-script');document.getElementById('custom-script').value='exec node worker.js';await click('custom-next');document.getElementById('custom-enabled').checked=false;await click('custom-next');await click('custom-next');assert('shell mode can create disabled without claiming a running process',p.state.customServices[0].mode==='shell'&&p.state.customServices[0].runtime==='disabled'&&p.state.customServices[0].run===0);
p.closeSheet();p.setScenario('custom',false);p.state.customServices[0].runtime='missing';p.state.view='attention';p.renderApp();assert('missing custom tool appears in Needs attention',document.getElementById('service-results').textContent.includes('Tool unavailable'));await click('custom-inspect-demo-user-1');assert('missing-tool remedy does not promise automatic reinstall',document.getElementById('sheet').textContent.includes('will not fall back to latest'));
p.closeSheet();p.setScenario('ready',false);
const ids=[...document.querySelectorAll('[id]')].map(el=>el.id);assert('rendered IDs unique',new Set(ids).size===ids.length);
const controls=[...document.querySelectorAll('#app button,#app input,#app select')];assert('visible controls have names',controls.every(el=>!el.getBoundingClientRect().width||el.textContent.trim()||el.getAttribute('aria-label')||document.querySelector('label[for="'+el.id+'"]')));
assert('reduced motion and forced colors recipes are present',[...document.styleSheets].some(s=>[...s.cssRules].some(r=>r.conditionText?.includes('prefers-reduced-motion')))&&[...document.styleSheets].some(s=>[...s.cssRules].some(r=>r.conditionText?.includes('forced-colors'))));
document.getElementById('toast').hidden=true;
console.info('INTERACTIONS '+JSON.stringify({total:results.length,passed:results.filter(r=>r.passed).length}));
window.__QA_RESULTS__=results;
`;
const extra=`<script>(async()=>{${checks}\nawait document.fonts.ready;${measure}})().catch(e=>console.error(e.stack));</script>`;
fs.writeFileSync(path.join(out,'interactions.html'),original.replace('</body>',`${extra}</body>`));
fs.writeFileSync(path.join(out,'interactions-large.html'),original.replace('</body>',`<script>document.documentElement.style.setProperty('--prototype-font-size','20px');</script>${extra}</body>`));
console.log(out);
