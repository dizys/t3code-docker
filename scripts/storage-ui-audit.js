#!/usr/bin/env node
// Storage UI states and keyboard flow against a running console. All storage
// mutations are intercepted: this audit cannot clear a real cache or save a
// policy. Usage: node scripts/storage-ui-audit.js <console-url> <setup-key>
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("playwright-core")); }
const base = process.argv[2] || "http://127.0.0.1:23780/__setup/";
const key = process.argv[3] || "dev";
const output = process.env.T3_STORAGE_UI_OUTPUT || "/tmp/t3-storage-ui-audit";
const GB = 1e9;

const geometry = () => {
  const issues = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.push("horizontal page overflow");
  const panel = document.querySelector('.tc-layer [role="dialog"], .tc-layer [role="alertdialog"]');
  if (panel) {
    const rect = panel.getBoundingClientRect();
    if (rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) issues.push("dialog outside viewport");
  }
  for (const el of document.querySelectorAll('.tc-storage *, .tc-layer [role="dialog"] *, .tc-layer [role="alertdialog"] *')) {
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!rect.width || !rect.height || el.matches('input, .tc-storage-path, .tc-switch')) continue;
    if (style.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1) issues.push(`${el.className || el.tagName} clipped`);
    if (el.matches('.tc-tile--icon') && !el.querySelector('svg')) issues.push("missing row icon");
  }
  return issues;
};

(async () => {
  await fs.mkdir(output, { recursive: true });
  const statusUrl = new URL('status', base.endsWith('/') ? base : base + '/');
  const initial = await fetch(statusUrl, { headers: { 'x-t3-setup-key': key } });
  assert.equal(initial.ok, true, 'console must accept the supplied setup key');
  const fixtureStatus = await initial.json();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] });
  try {
    const runs = [[360,800,false],[390,844,false],[820,1180,false],[1100,1000,false],[1440,1000,false],[390,844,true],[1198,878,true]];
    const widths = process.env.T3_STORAGE_UI_WIDTHS?.split(',').map(Number);
    for (const [width,height,embed] of runs.filter(([width])=>!widths || widths.includes(width))) for (const theme of ['light','dark']) {
      const context = await browser.newContext({ viewport: { width,height }, colorScheme: theme, reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = [], requests = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let state = 'ready', policyFailure = false, versionFailure = false, versionOnlyPrevious = false, versionLong = false, versionGate = null;
      let versionRequests = 0, versionOperation = null;
      const policy = { schema:1, automatic:false, retainManagedVersions:true, goBudgetBytes:10*GB, npmBudgetBytes:2*GB };
      const storage = () => ({ at:Date.now(), refreshing:state === 'scanning', policy,
        error:state === 'partial' ? 'Some folders could not be read. Sizes are partial estimates.' : null,
        operation:state === 'running' ? { id:'mock-job',state:'running',phase:'npm' } : versionOperation,
        disk:{usedPercent:state === 'critical' ? 96 : 89,totalBytes:207*GB,usedBytes:183*GB,availableBytes:24*GB},
        categories:state === 'loading' ? [] : [
          {id:'go',label:'Go build cache',path:'/home/t3/.cache/go-build',bytes:state === 'empty' ? 0 : 39*GB,cleanable:true,description:'Compiled packages. Builds recreate these when needed.'},
          {id:'npm',label:'npm downloads',path:'/home/t3/.npm/_cacache',bytes:state === 'empty' ? 0 : 6.5*GB,cleanable:true,description:'Downloaded packages. Installs fetch them again when needed.'},
          {id:'backups',label:'Upgrade backups',path:'/home/t3/.t3/backups',bytes:13.6*GB},
          {id:'workspace',label:'Projects',path:'/workspace/a-project-with-a-long-name/local-application-state',bytes:22*GB},
        ] });
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url()), method = route.request().method();
        if (url.pathname.endsWith('/status')) {
          return route.fulfill({ json:{ ...fixtureStatus, storage:storage() } });
        }
        if (/\/storage(?:\/|$)/.test(url.pathname)) {
          if (method === 'POST') {
            requests.push({route:url.pathname,body:route.request().postDataJSON()});
            if (url.pathname.endsWith('/policy') && policyFailure) return route.fulfill({status:503,json:{error:'Preferences could not be saved. Try again.'}});
            if (url.pathname.endsWith('/policy')) Object.assign(policy,route.request().postDataJSON());
            if (url.pathname.endsWith('/prune')) return route.fulfill({status:202,json:{ok:true,operation:{id:'version-job',state:'running'}}});
            return route.fulfill({json:{ok:true}});
          }
          if (url.pathname.endsWith('/versions')) {
            versionRequests++;
            const includePrevious = url.searchParams.get('includePrevious') === 'true', gate = versionGate;
            await gate;
            if (versionFailure) return route.fulfill({status:503,json:{ok:false,error:'Version discovery is temporarily unavailable.'}});
            return route.fulfill({json:{ok:true,includePrevious,token:(includePrevious?'b':'a').repeat(64),estimatedBytes:5.2*GB,removableCount:(versionOnlyPrevious?0:2)+(includePrevious?1:0),items:[
            ...(versionOnlyPrevious ? [] : [{name:'Claude Code',version:'2.0.1',eligible:true},{name:'Codex',version:'0.110.0',eligible:true}]),
            {name:'Claude Code',version:'2.0.3',eligible:false,reason:'Current version'},
            {name:'Codex',version:'0.111.0',eligible:includePrevious,reason:includePrevious?null:'Previous version'},
            {name:'Go',version:'1.25.0',eligible:false,reason:'Required by a project or tool selection'},
            ...(versionLong ? Array.from({length:40},(_,i)=>({name:'Tool with a longer managed name',version:'1.'+i+'.0',eligible:false,reason:'Required by a project or tool selection'})) : []),
          ]}}); }
          return route.fulfill({json:storage()});
        }
        return route.continue();
      });
      const url = new URL(base); url.hash = 'storage'; if(embed) { url.searchParams.set('embed','t3'); url.searchParams.set('theme',theme); }
      await page.goto(url.href);
      await page.getByLabel('Setup key',{exact:true}).fill(key); await page.getByRole('button',{name:'Unlock',exact:true}).click();
      await page.locator('[data-key=storage-clean-all]:not([disabled])').waitFor();
      const tag = `${width}-${theme}${embed ? '-embedded' : ''}`;
      const check = async (name) => { assert.deepEqual(await page.evaluate(geometry),[],`${tag} ${name}`); };
      await page.locator('.tc-storage').scrollIntoViewIfNeeded(); await check('card');
      await page.screenshot({path:path.join(output,`${tag}-card.png`)});
      await page.locator('[data-key=storage-details]').click(); await check('folder usage');
      await page.locator('[data-key=storage-clean-all]').click(); await page.getByRole('alertdialog').waitFor(); await check('confirmation');
      assert.equal(await page.evaluate(()=>document.activeElement.textContent.trim()),'Cancel');
      await page.keyboard.press('Escape'); assert.equal(requests.length,0);
      await page.locator('[data-key=storage-preferences]').click(); await page.getByRole('dialog').waitFor(); await check('preferences');
      await page.screenshot({path:path.join(output,`${tag}-preferences.png`)});
      await page.locator('#storage-go-limit').fill('0'); await page.locator('[data-storage-save]').click();
      assert.equal(await page.locator('#storage-go-limit').getAttribute('aria-invalid'),'true'); assert.equal(requests.length,0);
      await page.locator('#storage-go-limit').fill('12.5');
      const toggle=page.locator('[data-storage-switch=automatic]'); await toggle.focus(); await page.keyboard.press('Space');
      assert.equal(await toggle.getAttribute('aria-checked'),'true');
      // A real status poll while editing must keep both the value and focus.
      if(width === 390 && theme === 'dark' && !embed) {
        await page.locator('#storage-go-limit').focus();
        const poll=page.waitForResponse((response)=>new URL(response.url()).pathname.endsWith('/status'));
        await poll;
        assert.equal(await page.locator('#storage-go-limit').inputValue(),'12.5');
        assert.equal(await page.evaluate(()=>document.activeElement.id),'storage-go-limit');
      }
      policyFailure=true; await page.locator('[data-storage-save]').click();
      await page.locator('#storage-settings-error:not([hidden])').waitFor(); assert.equal(await page.locator('#storage-go-limit').inputValue(),'12.5'); await check('save failure');
      policyFailure=false; await page.locator('[data-storage-save]').click(); await page.getByRole('dialog').waitFor({state:'hidden'});
      assert.equal(policy.goBudgetBytes,12.5*GB); assert.equal(policy.automatic,true);
      await page.locator('[data-key=storage-review]').click(); await page.getByRole('dialog').waitFor();
      await page.locator('[data-storage-trim]:not([disabled])').waitFor(); await check('version review');
      await page.screenshot({path:path.join(output,`${tag}-versions.png`)});
      await page.locator('[data-storage-trim]').focus(); await page.keyboard.press('Enter');
      assert.equal(requests.some((request)=>request.route.endsWith('/prune')),false);
      await page.locator('[data-storage-cancel]').click();
      // The dangerous option is available even when safe cleanup has no work.
      versionOnlyPrevious=true;
      await page.locator('[data-key=storage-review]').click();
      await page.getByText('No older versions to remove',{exact:true}).waitFor();
      assert.equal(await page.locator('[data-storage-trim]').isDisabled(),true);
      const previous=page.locator('[data-storage-previous]');
      assert.equal(await previous.isChecked(),false);
      versionFailure=true; await previous.check();
      await page.getByText('Version discovery is temporarily unavailable.',{exact:true}).waitFor();
      assert.equal(await previous.isChecked(),true); assert.equal(await page.locator('[data-storage-trim]').isDisabled(),true);
      versionFailure=false; await page.locator('[data-storage-retry]').click();
      await page.getByRole('button',{name:'Remove 1 version',exact:true}).waitFor();
      await check('including previous versions');
      await page.screenshot({path:path.join(output,`${tag}-versions-including-previous.png`)});
      // A late response from a different mode cannot replace the visible review.
      let release;
      versionGate=new Promise(resolve=>{release=resolve;});
      const count=versionRequests; await previous.uncheck();
      await page.waitForFunction(()=>document.querySelector('.tc-storage-review-loading')!==null);
      for(let attempt=0;versionRequests===count && attempt<200;attempt++) await new Promise(resolve=>setTimeout(resolve,5));
      assert(versionRequests>count,'changed mode starts a new preview');
      assert.equal(await page.locator('[data-storage-trim]').isDisabled(),true);
      versionGate=null; await previous.check();
      await page.getByRole('button',{name:'Remove 1 version',exact:true}).waitFor();
      release(); await page.waitForTimeout(80);
      assert.equal(await previous.isChecked(),true);
      assert.equal(await page.locator('[data-storage-trim]').textContent(),'Remove 1 version');
      await page.locator('[data-storage-trim]').click();
      await page.getByRole('dialog').waitFor({state:'hidden'});
      await page.locator('.tc-storage-operation').waitFor();
      assert.equal(await page.locator('[data-key=storage-review]').isDisabled(),true,'accepted cleanup stays busy before its first status snapshot');
      const pruning=requests.filter(request=>request.route.endsWith('/prune'));
      assert.deepEqual(pruning.map(request=>request.body),[{token:'b'.repeat(64),includePrevious:true}]);
      versionOperation={id:'version-job',state:'succeeded',ids:['versions'],removedCount:1,finishedAt:Date.now()};
      await page.locator('[data-key=storage-review]:not([disabled])').waitFor();
      versionOperation=null;
      await page.locator('[data-key=storage-review]').click();
      await page.getByText('No older versions to remove',{exact:true}).waitFor();
      assert.equal(await page.locator('[data-storage-previous]').isChecked(),false,'destructive mode does not persist');
      await page.locator('[data-storage-cancel]').click();
      versionLong=true; await page.locator('[data-key=storage-review]').click();
      await page.getByText('No older versions to remove',{exact:true}).waitFor();
      const fixed=await page.locator('.tc-storage-review').evaluate(panel=>{
        const body=panel.querySelector('.tc-dialog-body'),foot=panel.querySelector('.tc-dialog-foot').getBoundingClientRect();
        body.scrollTop=body.scrollHeight;
        return {scrolls:body.scrollHeight>body.clientHeight,footerVisible:foot.top>=0&&foot.bottom<=innerHeight+1};
      });
      assert(fixed.scrolls&&fixed.footerVisible,'a long inventory scrolls without hiding cleanup controls');
      await check('long version inventory'); await page.locator('[data-storage-cancel]').click();
      for(const scenario of ['critical','empty','scanning','running','partial','loading']) {
        state=scenario; await page.reload(); await page.locator('.tc-storage').waitFor(); await check(scenario);
        if(['scanning','running','empty','loading'].includes(scenario)) assert.equal(await page.locator('[data-key=storage-clean-all]').isDisabled(),true);
      }
      assert.deepEqual(errors,[]); await context.close(); console.log(`PASS ${tag}: layouts, keyboard, drafts, failures, six storage states`);
    }
  } finally { await browser.close(); }
})().catch((error)=>{console.error(error);process.exitCode=1;});
