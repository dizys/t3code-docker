#!/usr/bin/env node
// Global instruction editor regression checks against a disposable console.
// node scripts/context-ui-audit.js http://127.0.0.1:23780/__setup/ dev
// Read/save responses are fixtures; this audit never changes instructions.
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('playwright-core')); }
const base = process.argv[2] || 'http://127.0.0.1:23780/__setup/';
const key = process.argv[3] || 'dev';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const output = process.env.T3_CONTEXT_UI_OUTPUT || '/tmp/t3-context-ui-audit';
fs.mkdirSync(output, {recursive:true});
(async () => {
 const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/usr/bin/chromium', args:['--no-sandbox']});
 try {
 for (const theme of ['light', 'dark']) {
 for (const [width, height, embedded] of [[360, 720], [390, 844], [820, 900], [1280, 900], [1198, 878, true]]) {
 const page = await browser.newPage({viewport:{width,height},colorScheme:theme,reducedMotion:'reduce'});
 await page.addInitScript(mode => localStorage.setItem('t3-console-theme', mode), theme);
 const agentIds = ['claude','codex','opencode','cursor','grok','muse','antigravity','pi'];
 const instructionFiles = {claude:'CLAUDE.md',codex:'AGENTS.override.md',grok:'t3-instructions.md',pi:'CLAUDE.MD'};
 const agentNames = {claude:'Claude Code',codex:'Codex',opencode:'OpenCode',cursor:'Cursor',grok:'Grok Build',muse:'Muse Code',antigravity:'Antigravity',pi:'Pi'};
 const providerModes = Object.fromEntries(agentIds.map(id => [id, 'separate']));
 let oversizedStatus = false, emptyStatus = true, unreadableStatus = false;
 let previewFail = true;
 let previewContent = '# Preview instructions';
 let releasePreview, previewStarted;
 const previewGate = new Promise(resolve => { releasePreview = resolve; });
 const previewReading = new Promise(resolve => { previewStarted = resolve; });
 const oversizedError = 'Instructions are too large to edit (64 KiB maximum). Edit the file directly to reduce its size.';
 const errors=[];page.on('pageerror', e=>errors.push(e.message));
 await page.route('**/status', async route => {
   const response = await route.fetch();
   const status = await response.json();
   status.context.agentsMd = {present:true,bytes:12,path:'/home/t3/.t3/setup/context/AGENTS.md'};
   status.context.providers = agentIds.map(provider => ({provider, mode:providerModes[provider],sourceRevision:provider+'-'+providerModes[provider],path:'/home/t3/a-very-long-existing-configuration-directory-for-' + provider + '/' + (instructionFiles[provider] || 'AGENTS.md'), bytes:12}));
   if (emptyStatus) { status.context.agentsMd = {present:false,bytes:0,...(unreadableStatus ? {error:'Fixture instructions read failure'} : {})}; }
   if (oversizedStatus) {
     status.context.agentsMd = {present:true,bytes:65537,error:oversizedError};
     Object.assign(status.context.providers[1], {error:oversizedError,sourceRevision:null});
   }
   await route.fulfill({json:status});
 });
 await page.route('**/context/agents-md', async route => {
   if (route.request().method() !== 'GET') { await route.fallback(); return; }
   previewStarted(); await previewGate;
   await route.fulfill({status:previewFail ? 503 : 200,json:previewFail ? {ok:false,error:'Temporary preview read failure'} : {ok:true,content:previewContent,revision:'preview-revision'}});
 });
 await page.goto(base);
 if (await page.locator('input[type="password"]').isVisible()) {
   await page.locator('input[type="password"]').fill(key);
   await page.getByRole('button',{name:/unlock/i}).click();
   await page.locator('#app').waitFor();
 }
 await page.goto(base + (embedded ? '?embed=t3&theme=' + theme : '') + '#instructions');
 await page.locator('.tc-ins-empty').waitFor();
 assert.equal(await page.locator('.tc-reads-path').count(), 8, 'All eight agents expose their global instruction path');
 const emptyLayout = await page.locator('.tc-ins-empty').evaluate(card => {
   const box = card.getBoundingClientRect(), center = box.x + box.width / 2;
   return [...card.children].map(child => { const r=child.getBoundingClientRect();return {center:Math.abs(r.x+r.width/2-center),width:r.width}; });
 });
 assert(emptyLayout.every(child => child.center < 1), 'empty icon, copy and action share one center line');
 assert(emptyLayout[0].width <= 40, 'empty-state decoration keeps its intrinsic size');
 if(width<1024)assert((await page.locator('.tc-ins-empty > .tc-btn').boundingBox()).height>=44,'first-write actions keep a 44px touch target');
 for (const row of await page.locator('.tc-reads-path').all()) {
   const metadata = await row.evaluate(el => [...el.children].filter(child => child.tagName === 'SPAN').map(child => ({height:child.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(child).lineHeight)})));
   assert(metadata.every(item => item.height <= item.lineHeight + 1),'file sizes stay together beside long paths');
   if(width<1024)assert((await row.getByRole('button',{name:/Edit/}).boundingBox()).height>=44,'own-file edits keep a 44px touch target');
 }
 for (const button of await page.locator('[data-cmd="context.provider.mode"]').all()) {
   assert(await button.evaluate(el => {
     const text = document.createRange(); text.selectNodeContents(el);
     const label = text.getBoundingClientRect(), box = el.getBoundingClientRect();
     return label.left >= box.left - 1 && label.right <= box.right + 1;
   }), 'instruction source labels fit inside their button with native and override filenames');
 }
 assert.equal(await page.locator('[data-id="grok"][data-mode="separate"]').getAttribute('aria-label'),'Own t3-instructions.md');
 assert.equal(await page.locator('[data-id="codex"][data-mode="separate"]').getAttribute('title'),'Use AGENTS.override.md');
 await page.locator('#page-instructions').screenshot({path:path.join(output,`${theme}-${width}${embedded?'-embedded':''}-empty.png`)});
 unreadableStatus = true; await page.reload();
 await page.getByText('Shared instructions unavailable',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Write AGENTS.md',exact:true}).count(),0,'a failed read never offers to create a replacement');
 await page.locator('#page-instructions').screenshot({path:path.join(output,`${theme}-${width}${embedded?'-embedded':''}-unavailable.png`)});
 emptyStatus = false; unreadableStatus = false;
 await page.getByRole('button',{name:'Try again',exact:true}).click();
 await previewReading;
 await page.getByText('Reading shared instructions…',{exact:true}).waitFor();
 assert.equal(await page.locator('.tc-doc-preview').evaluate(el=>getComputedStyle(el,'::after').content),'none','loading text has no fading overlay');
 await page.locator('#page-instructions').screenshot({path:path.join(output,`${theme}-${width}${embedded?'-embedded':''}-preview-loading.png`)});
 releasePreview();
 await page.locator('[data-cmd="context.edit"]').waitFor();
 await page.getByRole('button',{name:'Retry preview',exact:true}).waitFor();
 assert.equal(await page.locator('.tc-doc-preview').evaluate(el=>getComputedStyle(el,'::after').content),'none','recovery notices have no fading overlay');
 const recovery = await page.getByRole('button',{name:'Retry preview',exact:true}).boundingBox(), recoveryCopy = await page.locator('.tc-doc-preview .tc-notice-body').boundingBox();
 assert(recovery.y >= recoveryCopy.y + recoveryCopy.height,'preview recovery has a separate row instead of crowding the error text');
 assert(Math.abs(recovery.x-recoveryCopy.x)<1,'preview recovery aligns with its error text');
 if(width<1024)assert(recovery.height>=44,'preview recovery keeps a 44px touch target');
 await page.locator('#page-instructions').screenshot({path:path.join(output,`${theme}-${width}${embedded?'-embedded':''}-preview-error.png`)});
 previewFail = false;
 await page.getByRole('button',{name:'Retry preview',exact:true}).click();
 await page.locator('.tc-doc-preview .tc-code').filter({hasText:'# Preview instructions'}).waitFor();
 assert.equal(await page.locator('.tc-doc-preview .tc-code').getAttribute('aria-label'),'Shared AGENTS.md preview');
 assert.equal(await page.locator('.tc-doc-preview').evaluate(el=>getComputedStyle(el,'::after').content),'none','short instructions remain fully readable');
 previewContent = '# Long instructions\n' + 'wrapped instruction '.repeat(120) + '\n' + Array.from({length:24},(_,i)=>'Line '+i).join('\n');
 await page.reload();
 await page.getByText('First 18 lines · On the state volume',{exact:true}).waitFor();
 assert.equal(await page.locator('.tc-doc-preview .tc-code > span').count(),18,'long previews keep a bounded line count');
 assert(await page.locator('.tc-doc-preview .tc-code').evaluate(el=>getComputedStyle(el).overflowY==='auto'&&el.scrollHeight>el.clientHeight),'wrapped preview lines remain reachable by scrolling');
 assert(await page.locator('.tc-doc-foot > span').evaluate(el=>el.getBoundingClientRect().height<=parseFloat(getComputedStyle(el).lineHeight)+1),'preview metadata stays together beside its file path');
 assert(await page.locator('.tc-doc-foot > code').evaluate(el=>el.getBoundingClientRect().height<=parseFloat(getComputedStyle(el).lineHeight)+1),'a normal shared-file path stays whole at narrow widths');
 await page.locator('#page-instructions').screenshot({path:path.join(output,`${theme}-${width}${embedded?'-embedded':''}-preview-content.png`)});
 previewContent = '# Preview instructions'; await page.reload();
 await page.locator('.tc-doc-preview .tc-code').filter({hasText:previewContent}).waitFor();
 const head=await page.locator('.tc-doc-head').boundingBox(), edit=await page.locator('.tc-doc-head [data-cmd="context.edit"]').boundingBox();
 assert(Math.abs(head.x+head.width-edit.x-edit.width-14)<2,'document actions align to the card end');
 assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
 assert.equal(await page.locator('#page-instructions .tc-ins-section').count(),2);
 assert.equal(await page.getByRole('tab',{name:'Instructions',exact:true}).getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('[data-cmd="context.edit"]').innerText(),'Edit');
 const checkCentered = async () => {
   const box = await page.getByRole('dialog').boundingBox();
   assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
   if (width >= 1024) assert.ok(Math.abs(box.x + box.width / 2 - width / 2) < 2);
 };
 const checkDownload = async (name, content) => {
   const downloadReady = page.waitForEvent('download');
   await page.getByRole('button',{name:'Download',exact:true}).click();
   const download = await downloadReady;
   assert.equal(download.suggestedFilename(),name);
   assert.equal(require('node:fs').readFileSync(await download.path(),'utf8'),content);
 };

 let instructionReads = 0;
 let releaseOldRead, oldReadStarted, oldReadFinished;
 const oldGate = new Promise(resolve => { releaseOldRead = resolve; });
 const started = new Promise(resolve => { oldReadStarted = resolve; });
 const finished = new Promise(resolve => { oldReadFinished = resolve; });
 await page.route('**/context/agents-md', async route => {
   const first = instructionReads++ === 0;
   if (first) { oldReadStarted(); await oldGate; }
   await route.fulfill({json:{ok:true,content:first ? '# Old response' : '# Current instructions',revision:'shared-revision'}});
   if (first) oldReadFinished();
 });
 await page.locator('[data-cmd="context.edit"]').click();
 await started;
 assert.equal(await page.locator('[data-sheet="save"]').isDisabled(),true);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.locator('[data-cmd="context.edit"]').click();
 await page.waitForFunction(() => document.querySelector('#cx-input')?.value === '# Current instructions');
 assert.equal(await page.locator('[data-sheet="save"]').isDisabled(),true,'unchanged instructions cannot be saved again');
 releaseOldRead();
 await finished;
 assert.equal(await page.locator('#cx-input').inputValue(),'# Current instructions');
 await checkCentered();
 await page.locator('#cx-file').setInputFiles({name:'AGENTS.md',mimeType:'text/markdown',buffer:Buffer.from('# Uploaded instructions')});
 await page.waitForFunction(() => document.querySelector('#cx-input')?.value === '# Uploaded instructions');
 await page.locator('#cx-input').fill('# Unsaved draft');
 assert.equal(await page.locator('[data-sheet="save"]').isDisabled(),false,'edited instructions can be saved');
 await checkDownload('AGENTS.md','# Unsaved draft');
 await page.locator('#cx-file').setInputFiles({name:'too-large.md',mimeType:'text/markdown',buffer:Buffer.alloc(65 * 1024, 'x')});
 await page.getByText('File too large (64 KB max).', {exact:true}).waitFor();
 assert.equal(await page.locator('#cx-input').inputValue(),'# Unsaved draft');
 let releaseFailedSave, saveStarted;
 const saveGate = new Promise(resolve => { releaseFailedSave = resolve; });
 const saving = new Promise(resolve => { saveStarted = resolve; });
 await page.route('**/context/agents-md', async route => {
   if (route.request().method() === 'GET') { await route.fulfill({json:{ok:true,content:'# Current instructions',revision:'shared-revision'}}); return; }
   assert.equal(route.request().postDataJSON().revision,'shared-revision');
   assert.equal(route.request().postDataJSON().content,'# Unsaved draft');
   saveStarted();
   await saveGate;
   await route.fulfill({status:409,json:{ok:false,error:'Shared instructions changed since opening'}});
 });
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await saving;
 assert.equal(await page.locator('#cx-input').isDisabled(),true);
 assert.equal(await page.locator('[data-sheet="close"]:disabled').count(),2);
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#cx-input').count(),1,'an in-flight save keeps its editor open');
 await page.evaluate(() => { location.hash = 'overview'; });
 await page.waitForFunction(() => location.hash === '#instructions');
 assert.equal(await page.locator('#cx-input').count(),1,'history navigation cannot abandon a save');
 releaseFailedSave();
 await page.getByText('Shared instructions changed since opening',{exact:true}).waitFor();
 assert.equal(await page.locator('#cx-input').inputValue(),'# Unsaved draft');
 assert(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload',{cancelable:true}))), 'unsaved instructions warn before reload');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('alertdialog').waitFor();
 await page.getByRole('alertdialog').getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await page.locator('#cx-input').inputValue(),'# Unsaved draft');
 await page.evaluate(() => { location.hash = 'instructions/skills'; });
 await page.getByRole('alertdialog').waitFor();
 await page.getByRole('alertdialog').getByRole('button',{name:'Cancel',exact:true}).click();
 await page.waitForFunction(() => location.hash === '#instructions');
 assert.equal(await page.locator('#cx-input').inputValue(),'# Unsaved draft');
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Discard draft',exact:true}).click();
 await page.locator('#cx-input').waitFor({state:'hidden'});
 assert(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload',{cancelable:true}))), 'closing the editor removes its reload guard');
 // All existing provider files are discoverable, editable and saved explicitly.
 await page.route('**/context/agents-md?provider=*', async route => {
   const provider = new URL(route.request().url()).searchParams.get('provider');
   await route.fulfill({json:{ok:true, content:'# Existing ' + provider, revision:provider + '-revision', resolvedPath:'/home/t3/existing/' + provider + '/instructions.md'}});
 });
 let expectedProvider = null;
 let conflict = false;
 let providerSaves = 0;
 let modeSaves = 0;
 let failMode = false;
 await page.route('**/context/agents-md', async route => {
   if (route.request().method() === 'GET') { await route.fulfill({json:{ok:true,content:'# Shared fixture',revision:'shared-revision'}}); return; }
   const body = route.request().postDataJSON();
   if (body.mode) {
     assert.equal(body.sourceRevision,body.provider+'-'+providerModes[body.provider]);
     modeSaves++;
     if (!failMode) providerModes[body.provider]=body.mode;
     await route.fulfill({status:failMode ? 409 : 200,json:failMode ? {ok:false,error:'Source changed while switching'} : {ok:true}});
     return;
   }
   assert.equal(body.provider,expectedProvider);
   assert.equal(body.revision,expectedProvider + '-revision');
   assert.equal(body.content,'# Edited ' + expectedProvider);
   providerSaves++;
   await route.fulfill({status:conflict ? 409 : 200,json:conflict ? {ok:false,error:'Instructions changed since you opened them.'} : {ok:true}});
 });
 assert.equal(await page.locator('[data-cmd="context.provider.edit"]').count(),8);
 for (const provider of agentIds) {
   expectedProvider = provider;
   await page.locator('[data-cmd="context.provider.edit"][data-id="' + provider + '"]').click();
   await page.waitForFunction(text => document.querySelector('#cx-input')?.value === text,'# Existing ' + provider);
   await page.getByRole('heading',{name:agentNames[provider] + '’s ' + (instructionFiles[provider] || 'AGENTS.md'),exact:true}).waitFor();
   await checkCentered();
   await page.locator('#cx-input').fill('# Edited ' + provider);
   await checkDownload(instructionFiles[provider] || 'AGENTS.md','# Edited ' + provider);
   if (provider === 'codex') {
     conflict = true;
     await page.getByRole('button',{name:'Save',exact:true}).click();
     await page.getByText('Instructions changed since you opened them.',{exact:true}).waitFor();
     assert.equal(await page.locator('#cx-input').inputValue(),'# Edited codex');
     conflict = false;
   }
   await page.getByRole('button',{name:'Save',exact:true}).click();
   await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
 }
 assert.equal(providerSaves,9);
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
 // What each agent reads is one choice, and it says what is in effect: a
 // cancelled or failed change shows the old choice again.
 const mode = page.locator('.tc-context-provider[data-key="row-agentsmd:codex"]');
 const modeValue = () => mode.locator('[aria-pressed=true]').getAttribute('data-mode');
 const chooseMode = value => mode.locator('[data-mode="' + value + '"]').click();
 assert.equal(await modeValue(),'separate');
 await chooseMode('shared');
 await page.getByRole('alertdialog').waitFor();
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(modeSaves,0);
 assert.equal(await modeValue(),'separate','a cancelled change shows the choice in effect');
 await chooseMode('shared');
 await page.getByRole('button',{name:'Use shared',exact:true}).click();
 await page.waitForFunction(() => document.querySelector('[data-cmd="context.provider.mode"][data-id="codex"][data-mode="shared"]')?.getAttribute('aria-pressed') === 'true' && !document.querySelector('[data-cmd="context.provider.mode"][data-id="codex"]').disabled);
 await page.locator('[data-cmd="context.edit"]').click();
 await page.getByRole('heading',{name:'Shared AGENTS.md',exact:true}).waitFor();
 await page.waitForFunction(() => document.querySelector('#cx-input')?.value === '# Shared fixture');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await chooseMode('separate');
 await page.waitForFunction(() => document.querySelector('#cx-input')?.value === '# Existing codex');
 assert.equal(await modeValue(),'separate');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 failMode = true;
 await chooseMode('shared');
 await page.getByRole('button',{name:'Use shared',exact:true}).click();
 await page.getByText('Source changed while switching',{exact:true}).waitFor();
 await page.waitForFunction(() => document.querySelector('[data-cmd="context.provider.mode"][data-id="codex"][data-mode="separate"]')?.getAttribute('aria-pressed') === 'true');
 assert.equal(modeSaves,3);
 // Failed reads cannot turn into a save of blank content.
 await page.route('**/context/agents-md?provider=*', route => route.fulfill({status:400,json:{ok:false,error:'Instruction file unavailable'}}));
 await page.locator('[data-cmd="context.provider.edit"][data-id="claude"]').click();
 await page.getByText('Instruction file unavailable',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Save',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 // An oversized file discovered after status cannot load an editable blank draft.
 await page.route('**/context/agents-md', route => route.fulfill({status:400,json:{ok:false,code:'too_large',error:oversizedError}}));
 await page.locator('[data-cmd="context.edit"]').click();
 await page.getByText(oversizedError,{exact:true}).waitFor();
 assert.equal(await page.locator('#cx-input').isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'Save',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 // Polling keeps oversized instructions visible while removing unsafe actions.
 oversizedStatus = true;
 await page.reload();
 await page.getByText(oversizedError,{exact:true}).first().waitFor();
 assert.equal(await page.locator('[data-cmd="context.edit"]').count(),0);
 assert.equal(await page.locator('[data-cmd="context.provider.edit"][data-id="codex"]').count(),0,'an unreadable file offers no editor');
 assert.equal(await mode.locator('button:disabled').count(),3);
 assert.equal(await modeValue(),'separate');
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
 assert.deepEqual(errors,[]);
 console.log('PASS Context interactions:',theme,width+'x'+height,embedded?'embedded':'standalone');
 await page.close();
 }
 }
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
