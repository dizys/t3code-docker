#!/usr/bin/env node
// Complete Storage journey against the real console. Every storage read/write
// uses the in-memory adapter: no cache, preference, or tool can be changed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createStorageFixtures } = require('./lib/storage-fixtures.cjs');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const base = process.argv[2] || 'http://127.0.0.1:23780/__setup/';
const key = process.argv[3] || 'dev', GB = 1e9;
const output = process.env.T3_STORAGE_UI_OUTPUT || '/tmp/t3-storage-ui-audit';
const spacingOnly = process.env.T3_STORAGE_UI_SPACING_ONLY === '1';
const deferred = () => { let release; return { promise: new Promise(resolve => { release = resolve; }), release: () => release() }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const geometry = () => {
  const issues = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('horizontal page overflow');
  const panel = document.querySelector('.tc-layer [role=dialog],.tc-layer [role=alertdialog]');
  if (panel) {
    const r = panel.getBoundingClientRect();
    if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) issues.push('dialog outside viewport');
    const footer = panel.querySelector('.tc-storage-dialog-foot');
    if (footer) { const f = footer.getBoundingClientRect(); if (f.top < r.top || f.bottom > innerHeight + 1) issues.push('footer outside viewport'); }
  }
  for (const el of document.querySelectorAll('.tc-storage *, .tc-layer [role=dialog] *, .tc-layer [role=alertdialog] *')) {
    const r = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!r.width || !r.height || el.matches('input,.tc-storage-path,.tc-switch')) continue;
    if (style.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1) issues.push((el.className || el.tagName) + ' clipped');
  }
  for (const row of document.querySelectorAll('.tc-storage .tc-row')) {
    const lead = row.querySelector(':scope > .tc-tile'), main = row.querySelector(':scope > .tc-row-main');
    if (lead && main) {
      const gap = main.getBoundingClientRect().left - lead.getBoundingClientRect().right;
      if (Math.abs(gap - parseFloat(getComputedStyle(row).columnGap)) > 1) issues.push('row text is detached from its icon');
    }
  }
  // Overflow checks cannot detect a paragraph losing its indent or breathing
  // room to the shell's reset. Check relationships between rendered text boxes.
  for (const section of document.querySelectorAll('.tc-storage-policy-section')) {
    const help = section.querySelector('.tc-hint'), detail = section.querySelector('.tc-storage-policy-detail,.tc-storage-policy-state');
    if (help && detail) {
      const a = help.getBoundingClientRect(), b = detail.getBoundingClientRect(), gap = b.top - a.bottom;
      if (Math.abs(a.left - b.left) > 1) issues.push('policy explanation is not aligned with its description');
      if (gap < 8 || gap > 20) issues.push('policy explanation has uneven vertical spacing');
    }
  }
  for (const note of document.querySelectorAll('.tc-storage-cleanup .tc-storage-plan-note')) {
    const previous = note.previousElementSibling;
    if (previous && note.getBoundingClientRect().top - previous.getBoundingClientRect().bottom < 8) issues.push('cleanup note touches the preceding content');
  }
  for (const row of document.querySelectorAll('.tc-storage-plan-row[data-kept]')) {
    const name = row.querySelector('.tc-row-name'), reason = row.querySelector('.tc-small'), detail = row.querySelector('.tc-storage-plan-effect');
    if (detail) {
      const a = name.getBoundingClientRect(), b = reason.getBoundingClientRect(), c = detail.getBoundingClientRect();
      if (Math.abs(a.left - c.left) > 1) issues.push('protected-cache explanation is not aligned with its name');
      if (c.top - b.bottom < 6) issues.push('protected-cache explanation touches its status');
    }
  }
  return issues;
};

(async () => {
  await fs.mkdir(output, { recursive: true });
  const initial = await fetch(new URL('status', base), { headers: { 'x-t3-setup-key': key } });
  assert(initial.ok, 'console must accept the supplied setup key');
  const fixtureStatus = await initial.json();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const runs = [[360,800,false],[390,844,false],[390,520,false],[820,1180,false],[844,440,false],[1100,1000,false],[1440,1000,false],[390,844,true],[1198,878,true]];
    const widths = process.env.T3_STORAGE_UI_WIDTHS?.split(',').map(Number);
    for (const [width,height,embed] of runs.filter(([w]) => !widths || widths.includes(w))) for (const theme of ['light','dark']) {
      const context = await browser.newContext({ viewport: { width,height }, colorScheme: theme, reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = [], requests = [], mock = createStorageFixtures();
      page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(mode => localStorage.setItem('t3-console-theme', mode), theme);
      let previewGate = null, cleanupGate = null, forceStale = false;
      let versionFailure = false, versionOnlyPrevious = false, versionLong = false, versionGate = null, versionRequests = 0, versionOperation = null;
      const storage = () => ({ ...mock.status(), operation: versionOperation || mock.status().operation });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url()), method = route.request().method(), at = suffix => url.pathname.endsWith(suffix);
        if (at('/storage-audit-host')) {
          const child = new URL(base); child.searchParams.set('embed','t3'); child.searchParams.set('theme',theme); child.hash = 'storage';
          return route.fulfill({ contentType: 'text/html', body: `<iframe title="Setup" src="${child.href}" style="border:0;width:100%;height:100%"></iframe><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style>` });
        }
        if (at('/status')) return route.fulfill({ json: { ...fixtureStatus, storage: storage() } });
        if (at('/.well-known/t3/environment')) return route.fulfill({ json: {} });
        if (/\/storage(?:\/|$)/.test(url.pathname)) {
          const input = method === 'POST' ? route.request().postDataJSON() : {};
          if (method === 'POST') requests.push({ route: url.pathname, body: input });
          if (at('/clean/preview')) await previewGate?.promise;
          if (at('/clean')) {
            await cleanupGate?.promise;
            if (forceStale) return route.fulfill({ status:409, json:{ ok:false,code:'stale-preview',error:'A cache location changed. Review it again before cleanup.' } });
          }
          if (at('/prune')) return route.fulfill({ status:202, json:{ ok:true,operation:{ id:'version-job',state:'running' } } });
          if (at('/versions')) {
            versionRequests++; const includePrevious = url.searchParams.get('includePrevious') === 'true', gate = versionGate; await gate;
            if (versionFailure) return route.fulfill({ status:503, json:{ ok:false,error:'Version discovery is temporarily unavailable.' } });
            return route.fulfill({ json:{ ok:true,includePrevious,token:(includePrevious?'b':'a').repeat(64),estimatedBytes:5.2*GB,removableCount:(versionOnlyPrevious?0:2)+(includePrevious?1:0),items:[
              ...(versionOnlyPrevious?[]:[{name:'Claude Code',version:'2.0.1',eligible:true},{name:'Codex',version:'0.110.0',eligible:true}]),
              {name:'Claude Code',version:'2.0.3',eligible:false,reason:'Current version'},
              {name:'Codex',version:'0.111.0',eligible:includePrevious,reason:includePrevious?null:'Previous version'},
              {name:'Go',version:'1.25.0',eligible:false,reason:'Required by a project or tool selection'},
              ...(versionLong?Array.from({length:40},(_,i)=>({name:'Tool with a longer managed name',version:'1.'+i+'.0',eligible:false,reason:'Required by a project or tool selection'})):[]),
            ] } });
          }
          const result = mock.respond(method,url,input); return route.fulfill({ status:result.status,json:result.body });
        }
        return route.continue();
      });
      let surface;
      const navigate = async () => {
        const url = new URL(base); url.hash = 'storage';
        if (embed) url.pathname = url.pathname.replace(/\/$/,'') + '/storage-audit-host';
        const firstStatus = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/status'));
        await page.goto(url.href);
        if (embed) { const frame = await page.locator('iframe').elementHandle(); surface = await frame.contentFrame(); } else surface = page;
        const unlock = surface.getByLabel('Setup key',{exact:true});
        if (await unlock.count()) { await unlock.fill(key); await surface.getByRole('button',{name:'Unlock',exact:true}).click(); }
        await firstStatus;
        await surface.locator('.tc-storage').waitFor();
        await surface.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      };
      await navigate();
      const tag = `${width}x${height}-${theme}${embed?'-embedded':''}`;
      const check = async state => {
        const findings = await surface.evaluate(geometry);
        if (findings.length) {
          await page.screenshot({ path: path.join(output, tag + '-failure.png'), fullPage: true });
          console.error(await surface.evaluate(() => [...document.querySelectorAll('.tc-storage *, .tc-layer [role=dialog] *')].filter(el => el.getBoundingClientRect().width && getComputedStyle(el).overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1).slice(0, 12).map(el => ({ cls: el.className, parent: el.parentElement.className, width: el.clientWidth, content: el.scrollWidth, text: el.textContent.trim().slice(0, 90) }))));
        }
        assert.deepEqual(findings, [], tag + ' ' + state);
      };
      const snap = async name => { await check(name); await page.screenshot({path:path.join(output,`${tag}-${name}.png`)}); };
      const writes = () => requests.filter(r => !r.route.endsWith('/preview') && !r.route.endsWith('/refresh'));
      const cleanRequests = () => requests.filter(r => r.route.endsWith('/clean'));
      const cancel = () => surface.getByRole('button',{name:'Cancel',exact:true}).click();
      const review = async () => { await surface.locator('[data-key=storage-clean-all]').click(); await surface.locator('[data-cleanup-confirm]:not([disabled])').waitFor(); };
      const closeReview = () => surface.getByRole('button',{name:'Close cleanup review',exact:true}).click();
      await snap('page');
      await surface.locator('[data-key=storage-details]').click(); await check('container folders');
      await review(); await snap('cleanup-review');
      assert.equal(await surface.locator('[data-cleanup-id]').count(),5);
      assert.equal(await surface.locator('[data-cleanup-id=bun]').count(),0,'shared dependencies cannot be selected');
      assert.equal(await surface.locator('[data-cleanup-id=deno]').count(),0,'unavailable tools have an explanation');
      await surface.locator('#cleanup-go').uncheck(); assert.equal(await surface.locator('#cleanup-go').isChecked(),false);
      await surface.locator('[data-cleanup-confirm]').focus(); await page.keyboard.press('Enter'); assert.equal(cleanRequests().length,0);
      await page.keyboard.press('Escape'); await surface.locator('.tc-storage-cleanup').waitFor({state:'hidden'}); assert.equal(writes().length,0);

      await surface.locator('[data-key=storage-preferences]').click();
      assert.equal(await surface.locator('#storage-cache-limits').isVisible(),false,'off settings do not expose seven large fields');
      await snap('maintenance');
      await surface.locator('[data-storage-switch=retainManagedVersions]').click(); await snap('maintenance-retention-off');
      await surface.locator('[data-storage-switch=retainManagedVersions]').click();
      await surface.locator('[data-storage-limits]').click(); await check('expanded limits');
      if (spacingOnly) await snap('maintenance-expanded');
      const footer = await surface.locator('.tc-storage-settings .tc-storage-dialog-foot').boundingBox();
      await surface.locator('.tc-storage-settings .tc-storage-dialog-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
      assert.deepEqual(await surface.locator('.tc-storage-settings .tc-storage-dialog-foot').boundingBox(),footer,'settings footer stays fixed');
      await surface.locator('#storage-go-limit').fill('0'); await surface.locator('[data-storage-save]').click();
      assert.equal(await surface.locator('#storage-go-limit').getAttribute('aria-invalid'),'true');
      await surface.locator('#storage-go-limit').fill('12.5');
      const toggle = surface.locator('[data-storage-switch=automatic]'); await toggle.focus(); await page.keyboard.press('Space');
      assert.equal(await toggle.getAttribute('aria-checked'),'true');
      if (width===390 && height===844 && theme==='dark' && !embed) {
        await surface.locator('#storage-go-limit').focus(); await page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/status'));
        assert.equal(await surface.locator('#storage-go-limit').inputValue(),'12.5');
        assert.equal(await surface.evaluate(() => document.activeElement.id),'storage-go-limit');
      }
      await surface.getByRole('button',{name:'Close maintenance settings'}).click();
      await surface.getByRole('alertdialog').getByRole('button',{name:'Cancel',exact:true}).click();
      assert.equal(await surface.locator('#storage-go-limit').inputValue(),'12.5','cancelled discard preserves the draft');
      mock.options.failPolicy = true; await surface.locator('[data-storage-save]').click();
      await surface.locator('#storage-settings-error').waitFor(); assert.equal(await surface.locator('#storage-go-limit').inputValue(),'12.5'); await snap('maintenance-save-error');
      assert.equal(await surface.evaluate(() => document.activeElement.id),'storage-settings-error','save errors receive keyboard focus');
      assert(await surface.locator('#storage-settings-error').evaluate(el=>{
        const r=el.getBoundingClientRect(),body=el.closest('.tc-storage-dialog-scroll').getBoundingClientRect();
        return r.top>=body.top-1&&r.bottom<=body.bottom+1;
      }),'save errors scroll into view inside the dialog');
      mock.options.failPolicy = false; await surface.locator('[data-storage-save]').click(); await surface.locator('.tc-storage-settings').waitFor({state:'hidden'});
      assert.equal(mock.status().policy.goBudgetBytes,12.5*GB); assert.equal(mock.status().policy.automatic,true);
      await surface.locator('[data-key=storage-preferences]').click(); await surface.locator('#storage-go-limit').fill('13.25');
      mock.changePolicy({uvBudgetBytes:3*GB}); await surface.locator('[data-storage-save]').click();
      await surface.getByText('Preferences changed elsewhere',{exact:true}).waitFor();
      assert.equal(await surface.locator('#storage-go-limit').inputValue(),'13.25');
      await surface.locator('[data-storage-reload]').click();
      await surface.getByRole('alertdialog').getByRole('button',{name:'Load latest',exact:true}).click();
      await surface.getByRole('heading',{name:'Storage maintenance',exact:true}).waitFor();
      await surface.locator('#storage-go-limit').waitFor({state:'visible'});
      assert.equal(await surface.locator('#storage-go-limit').inputValue(),'12.5'); assert.equal(await surface.locator('#storage-uv-limit').inputValue(),'3');
      await cancel();

      if (spacingOnly) {
        assert.deepEqual(errors,[]); await context.close();
        console.log(`PASS spacing ${tag}: text alignment, paragraph gaps, on/off policies, expanded limits, save errors, drafts and conflicts`);
        continue;
      }

      // Existing previous-version consent, stale replies and long inventories.
      await surface.locator('[data-key=storage-review]').click(); await surface.getByRole('dialog').waitFor();
      await surface.locator('[data-storage-trim]:not([disabled])').waitFor(); await check('version review');
      await page.screenshot({path:path.join(output,`${tag}-versions.png`)});
      await surface.locator('[data-storage-trim]').focus(); await page.keyboard.press('Enter');
      assert.equal(requests.some((request)=>request.route.endsWith('/prune')),false);
      await surface.locator('[data-storage-cancel]').click();
      // The dangerous option is available even when safe cleanup has no work.
      versionOnlyPrevious=true;
      await surface.locator('[data-key=storage-review]').click();
      await surface.getByText('No older versions to remove',{exact:true}).waitFor();
      assert.equal(await surface.locator('[data-storage-trim]').isDisabled(),true);
      const previous=surface.locator('[data-storage-previous]');
      assert.equal(await previous.isChecked(),false);
      versionFailure=true; await previous.check();
      await surface.getByText('Version discovery is temporarily unavailable.',{exact:true}).waitFor();
      assert.equal(await previous.isChecked(),true); assert.equal(await surface.locator('[data-storage-trim]').isDisabled(),true);
      versionFailure=false; await surface.locator('[data-storage-retry]').click();
      await surface.getByRole('button',{name:'Remove 1 version',exact:true}).waitFor();
      await check('including previous versions');
      await page.screenshot({path:path.join(output,`${tag}-versions-including-previous.png`)});
      // A late response from a different mode cannot replace the visible review.
      let release;
      versionGate=new Promise(resolve=>{release=resolve;});
      const count=versionRequests; await previous.uncheck();
      await surface.waitForFunction(()=>document.querySelector('.tc-storage-review-loading')!==null);
      for(let attempt=0;versionRequests===count && attempt<200;attempt++) await new Promise(resolve=>setTimeout(resolve,5));
      assert(versionRequests>count,'changed mode starts a new preview');
      assert.equal(await surface.locator('[data-storage-trim]').isDisabled(),true);
      versionGate=null; await previous.check();
      await surface.getByRole('button',{name:'Remove 1 version',exact:true}).waitFor();
      release(); await page.waitForTimeout(80);
      assert.equal(await previous.isChecked(),true);
      assert.equal(await surface.locator('[data-storage-trim]').textContent(),'Remove 1 version');
      await surface.locator('[data-storage-trim]').click();
      await surface.getByRole('dialog').waitFor({state:'hidden'});
      await surface.locator('.tc-storage-active').waitFor();
      assert.equal(await surface.locator('[data-key=storage-review]').isDisabled(),true,'accepted cleanup stays busy before its first status snapshot');
      const pruning=requests.filter(request=>request.route.endsWith('/prune'));
      assert.deepEqual(pruning.map(request=>request.body),[{token:'b'.repeat(64),includePrevious:true}]);
      versionOperation={id:'version-job',state:'succeeded',ids:['versions'],removedCount:1,finishedAt:Date.now()};
      await surface.locator('[data-key=storage-review]:not([disabled])').waitFor();
      versionOperation=null;
      await surface.locator('[data-key=storage-review]').click();
      await surface.getByText('No older versions to remove',{exact:true}).waitFor();
      assert.equal(await surface.locator('[data-storage-previous]').isChecked(),false,'destructive mode does not persist');
      await surface.locator('[data-storage-cancel]').click();
      versionLong=true; await surface.locator('[data-key=storage-review]').click();
      await surface.getByText('No older versions to remove',{exact:true}).waitFor();
      const fixed=await surface.locator('.tc-storage-review').evaluate(panel=>{
        const body=panel.querySelector('.tc-dialog-body'),foot=panel.querySelector('.tc-dialog-foot').getBoundingClientRect();
        body.scrollTop=body.scrollHeight;
        return {scrolls:body.scrollHeight>body.clientHeight,footerVisible:foot.top>=0&&foot.bottom<=innerHeight+1};
      });
      assert(fixed.scrolls&&fixed.footerVisible,'a long inventory scrolls without hiding cleanup controls');
      await check('long version inventory'); await surface.locator('[data-storage-cancel]').click();


      mock.options.failPreview = true; await surface.locator('[data-key=storage-clean-all]').click();
      await surface.getByText('Couldn’t finish this review',{exact:true}).waitFor();
      assert.equal(await surface.locator('[data-cleanup-confirm]').count(),0,'failed reviews offer a fresh check instead of a disabled cleanup');
      assert.equal(await surface.evaluate(()=>document.activeElement.hasAttribute('data-cleanup-error')),true);
      mock.options.failPreview = false; await surface.locator('[data-cleanup-recheck]').click(); await surface.locator('[data-cleanup-confirm]:not([disabled])').waitFor(); await closeReview();
      const held = deferred(); previewGate = held; await surface.locator('[data-key=storage-clean-all]').click();
      await surface.getByText('Checking your caches',{exact:true}).waitFor(); await closeReview(); previewGate = null;
      await review(); held.release(); await pause(30); assert.equal(await surface.locator('.tc-storage-cleanup').count(),1); await closeReview();
      mock.options.lifetime = 100; await review(); await surface.getByText('This review has expired',{exact:true}).waitFor();
      assert.equal(await surface.locator('[data-cleanup-confirm]').count(),0); await check('expired cleanup review'); mock.options.lifetime = 300000;
      assert.equal(await surface.locator('.tc-storage-dialog-foot [data-cleanup-recheck]').textContent(),'Check again','the visible footer offers recovery without scrolling');
      await surface.locator('[data-cleanup-recheck]').click(); await surface.locator('[data-cleanup-confirm]:not([disabled])').waitFor();
      forceStale = true; await surface.locator('[data-cleanup-confirm]').click();
      await surface.locator('.tc-storage-cleanup').getByText('A cache location changed. Review it again before cleanup.',{exact:true}).waitFor();
      assert.equal(await surface.locator('[data-cleanup-confirm]').count(),0); forceStale = false; await closeReview();
      await review();
      for (const id of ['go','gomod','uv','mise']) await surface.locator('#cleanup-'+id).uncheck();
      const job = deferred(); cleanupGate = job; mock.options.jobDelay = 1200; const before = cleanRequests().length;
      await surface.locator('[data-cleanup-confirm]').click(); await surface.locator('[data-cleanup-confirm]').dispatchEvent('click');
      assert.equal(await surface.locator('[data-cleanup-confirm]').isDisabled(),true);
      await page.keyboard.press('Escape'); assert.equal(await surface.locator('.tc-storage-cleanup').isVisible(),true);
      assert.equal(cleanRequests().length,before+1,'repeated confirmation cannot submit twice');
      cleanupGate = null; job.release();
      await surface.getByRole('heading',{name:'Cleaning up caches',exact:true}).waitFor(); await snap('cleanup-progress');
      await closeReview(); await surface.locator('.tc-storage-active').waitFor();
      assert.equal(await surface.locator('[data-key=storage-clean-all]').isDisabled(),true);
      await surface.locator('[data-key=storage-operation]').click();
      await surface.getByRole('heading',{name:'Cleanup finished',exact:true}).waitFor(); await snap('cleanup-result');
      assert.equal(cleanRequests().length,before+1,'viewing progress never restarts cleanup'); await closeReview();
      mock.options.failAt = 'uv'; mock.options.jobDelay = 150; await review();
      for (const id of ['gomod','mise']) await surface.locator('#cleanup-'+id).uncheck();
      await surface.locator('[data-cleanup-confirm]').click();
      await surface.getByRole('heading',{name:'Cleanup needs attention',exact:true}).waitFor(); await snap('partial-cleanup');
      assert.deepEqual(mock.operation.completedIds,['go']); assert.deepEqual(mock.operation.remainingIds,['uv']);
      mock.options.failAt = null; await surface.locator('[data-cleanup-remaining]').click();
      await surface.locator('[data-cleanup-confirm]:not([disabled])').waitFor();
      assert.equal(await surface.locator('[data-cleanup-id]').count(),1,'partial retry reviews only remaining caches'); await closeReview();
      for (const scenario of ['critical','empty','scanning','running','partial','loading']) {
        mock.options.scenario = scenario; await navigate(); await check(scenario);
        if (['scanning','running','loading'].includes(scenario)) assert.equal(await surface.locator('[data-key=storage-clean-all]').isDisabled(),true,tag+' '+scenario);
        if (scenario==='empty') { await surface.locator('[data-key=storage-clean-all]').click(); await surface.getByText('Nothing can be cleaned in this review.',{exact:false}).waitFor(); await closeReview(); }
      }
      assert.deepEqual(errors,[]); await context.close();
      console.log(`PASS ${tag}: review, protection, expiry, deduplication, partial retry, drafts, conflicts, keyboard and version regression`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
