#!/usr/bin/env node
const { runCases } = require('./lib/browser-audit-cases.cjs');
// Real console + in-memory API. No mutations reach a running agent or server.
// See CONTRIBUTING.md for the documented Playwright browser-audit workflow.
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { statusFor, portsFor, fixture, framed } = require('./lib/console-fixtures.cjs');
const { createSkillsFixtures } = require('./lib/skills-fixtures.cjs');
const { checkChipFocus } = require('./lib/chip-focus.cjs');
const base = process.argv[2] || 'http://127.0.0.1:23780/__setup/';
const key = process.argv[3] || 'dev';
const TAB = process.env.T3_UI_AUDIT_TAB === '1';
const output = process.env.T3_SKILLS_UI_OUTPUT || '/tmp/t3-skills-ui-audit';
fs.mkdirSync(output, { recursive: true });
const deferred = (timeoutMs = 15000) => { let resolve; const promise = new Promise((done, reject) => { const timer = setTimeout(() => reject(new Error('Timed out waiting for a fixture gate')), timeoutMs); timer.unref(); resolve = () => { clearTimeout(timer); done(); }; }); return { promise, resolve }; };
const visible = (target, selector) => target.locator(selector).filter({ visible: true });
const checkNoticeContrast = async notice => {
  const ratio = await notice.evaluate(element => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'), parents = [];
    for (let node = element; node; node = node.parentElement) parents.unshift(node);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1, 1);
    for (const node of parents) { ctx.fillStyle = getComputedStyle(node).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
    const background = ctx.getImageData(0, 0, 1, 1).data;
    const style = getComputedStyle(element); ctx.globalAlpha = Number(style.opacity); ctx.fillStyle = style.color; ctx.fillRect(0, 0, 1, 1);
    const foreground = ctx.getImageData(0, 0, 1, 1).data;
    const luminance = rgb => [...rgb].slice(0, 3).map(value => {
      value /= 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const a = luminance(background), b = luminance(foreground);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  assert(ratio >= 4.5, `recovery text contrast ${ratio.toFixed(2)}:1 must be at least 4.5:1`);
  return ratio;
};
const checkSelect = async (page, select, theme) => {
  await select.focus();
  const normal = await select.evaluate(control => {
    const style = getComputedStyle(control), option = getComputedStyle(control.options[0]);
    return { scheme: style.colorScheme, color: style.color, optionColor: option.color, optionBackground: option.backgroundColor, appearance: style.appearance, arrow: style.backgroundImage };
  });
  assert.equal(normal.scheme, theme);
  assert.equal(normal.color, normal.optionColor);
  assert.notEqual(normal.optionColor, normal.optionBackground);
  assert(normal.appearance !== 'none' || normal.arrow !== 'none');
  await page.emulateMedia({ forcedColors: 'active' });
  const contrast = await select.evaluate(control => ({ focus: control === document.activeElement, appearance: getComputedStyle(control).appearance, outline: parseFloat(getComputedStyle(control).outlineWidth) }));
  assert(contrast.focus); assert.notEqual(contrast.appearance, 'none'); assert(contrast.outline >= 2);
  await page.emulateMedia({ forcedColors: 'none' });
};
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const variants = TAB ? [480,639,640,704,1040].map(w=>[w,900,true]) : [[1440, 900], [1024, 900], [390, 844], [360, 720], [820, 900], [1198, 878, true]];
    const cases = ['light', 'dark'].filter(theme => !process.env.T3_SKILLS_UI_THEMES || process.env.T3_SKILLS_UI_THEMES.split(',').includes(theme)).flatMap(theme => variants.filter(([width]) => !process.env.T3_SKILLS_UI_WIDTHS || process.env.T3_SKILLS_UI_WIDTHS.split(',').includes(String(width))).map(variant => [theme, ...variant]));
    await runCases(cases, async ([theme, width, height, embedded], scope) => {
      console.log('Starting', theme, width);
      const page = await scope.page(browser, { viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
      await page.addInitScript(mode => localStorage.setItem('t3-console-theme', mode), theme);
      const api = createSkillsFixtures(), status = statusFor('skills'), errors = [], writes = [], gets = {};
      // Keep the longstanding draft/reinstall cases about a local skill. The
      // dedicated update audit covers the four tracked-source fixture states.
      for (const inventory of Object.values(api.inventories)) for (const skill of inventory.skills) if (skill.name === 'deep-research') delete skill.origin;
      api.inventories.antigravity.adapter = { detected: false };
      page.setDefaultTimeout(8000);
      page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
      let stateGate, stateStarted, planGate, planStarted, sourceGate, sourceStarted, readGate, readStarted, installGate, installStarted, saveGate, saveStarted, reachGate, reachStarted;
      let updateStatus = 'available', updateGate, updateStarted;
      let stateFail = false, saveFail = false, partial = false, blocked = false, expire = false, providerError = null, loseInstallResponse = false;
      let readFailId = null, readGateId = null;
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method();
        const input = method === 'POST' ? request.postDataJSON() : {};
        const at = suffix => url.pathname.endsWith(suffix);
        if (url.pathname.includes('/context/skills')) {
          if (method === 'GET') gets[url.pathname + url.search] = (gets[url.pathname + url.search] || 0) + 1;
          else writes.push({ path: url.pathname, input });
          if (at('/skills') && (providerError === 'all' || url.searchParams.get('provider') === providerError)) return route.fulfill({ status: 503, json: { ok: false, error: 'Fixture agent is temporarily unavailable' } });
          if (at('/check-update')) {
            if (updateGate) { updateStarted.resolve(); await updateGate.promise; updateGate = null; }
            const update = { status: updateStatus, checkedAt: Date.now(), error: updateStatus === 'error' ? 'Fixture repository unavailable' : undefined };
            return route.fulfill({ json: { ok: true, results: input.skills.map(skill => ({ ok: true, ...skill, update })) } });
          }
          if (at('/state')) {
            if (stateGate) { stateStarted.resolve(); await stateGate.promise; stateGate = null; }
            if (stateFail) return route.fulfill({ status: 409, json: { ok: false, error: 'Settings changed outside the console. Rescan before trying again.' } });
          }
          if (at('/install') && installGate) { installStarted.resolve(); await installGate.promise; installGate = null; }
          if (at('/read') && readGate && (!readGateId || url.searchParams.get('id') === readGateId)) { readStarted.resolve(); await readGate.promise; readGate = null; }
          if (at('/read') && readFailId && url.searchParams.get('id') === readFailId) return route.fulfill({ status: 404, json: { ok: false, error: 'This location was removed. Choose another location.' } });
          if (at('/source') && sourceGate) { sourceStarted.resolve(); await sourceGate.promise; sourceGate = null; }
          if (at('/plan') && planGate) { planStarted.resolve(); await planGate.promise; planGate = null; }
          if (at('/save') && saveGate) { saveStarted.resolve(); await saveGate.promise; saveGate = null; }
          if (at('/reach') && reachGate) { reachStarted.resolve(); await reachGate.promise; reachGate = null; }
          if (at('/save') && saveFail) return route.fulfill({ status: 409, json: { ok: false, error: 'The skill changed outside the console. Your draft is kept.' } });
        }
        let response = api.respond(method, url, input);
        if (response && at('/read') && url.searchParams.get('id')?.startsWith('unified-check-')) {
          response.body.content += '\nLocation: ' + url.searchParams.get('id');
          response.body.bytes = Buffer.byteLength(response.body.content);
        }
        if (response && at('/reach') && reachStarted) {
          response = structuredClone(response);
          response.body.roots[0].paths = [...(response.body.roots[0].paths || []), '/fixture/additional-alias'];
        }
        if (response && at('/source') && expire) response.body.expiresAt = Date.now() + 1000;
        if (response && at('/plan') && blocked) { response.body.canInstall = false; response.body.destinations[0] = { ...response.body.destinations[0], action: 'blocked', error: 'This folder is read-only' }; }
        if (response && at('/install') && partial) response.body.results[0] = { ...response.body.results[0], status: 'failed', error: 'Fixture disk is temporarily full' };
        if (response && at('/install') && loseInstallResponse) { loseInstallResponse = false; return route.abort('connectionreset'); }
        if (!response && at('/status')) response = { body: status };
        if (!response && at('/ports')) response = { body: portsFor('ready') };
        if (!response && at('/providers')) response = { body: fixture('providers.json') };
        if (!response && method === 'POST' && !at('/login')) response = { body: { ok: true } };
        if (response) return route.fulfill({ status: response.status || 200, json: response.body });
        return route.continue();
      });
      const target = embedded ? await framed(page, base + '?embed=t3&theme=' + theme + (TAB?'&host=tab&layout='+(width<640?'compact':'wide'):'')) : page;
      if (!embedded) await page.goto(base);
      if (await target.locator('input[type=password]').count()) {
        await target.locator('input[type=password]').fill(key);
        await target.locator('button[type=submit]').click();
      }
      await target.waitForSelector('#app');
      const navigate = async hash => { await target.evaluate(value => { location.hash = value; window.scrollTo(0, 0); }, hash); };
      const shot = async step => { console.log('Captured', theme, width, step); return page.screenshot({ path: path.join(output, `${theme}-${width}${embedded ? '-embedded' : ''}-${step}.png`) }); };
      const close = async () => { await page.keyboard.press('Escape'); await target.locator('.tc-layer:not([data-closing]) [role=dialog]').waitFor({ state: 'hidden' }); };
      const openSource = async () => { await visible(target, '[data-cmd="skills.import"]').click(); await target.locator('#skill-source').fill('vercel-labs/skills'); await target.locator('#skill-source').press('Enter'); await target.locator('[data-import-all]').waitFor(); };
      const next = () => target.locator('[data-import-next]');
      const checkColumns = async () => {
        const columnButton = target.locator('[data-key=skills-view-menu]');
        await columnButton.click();
        assert.equal(await target.getByRole('menuitemradio',{name:/Installed agents/}).getAttribute('aria-checked'),'true');
        await page.keyboard.press('Escape');
        assert(await columnButton.evaluate(el=>el===document.activeElement),'column menu returns keyboard focus');
        await columnButton.click();
        await target.getByRole('menuitemradio',{name:/All agents/}).click();
        await target.waitForFunction(() => document.querySelectorAll('.tc-mx-agent').length === 8);
        assert.equal(await target.locator('.tc-mx-agent[data-uninstalled]').count(), 3);
        await target.waitForFunction(() => { const table=document.querySelector('.tc-mx'); return table.scrollWidth <= table.clientWidth + 1 && ![...table.querySelectorAll('.tc-mx-agent-kind')].some(el=>el.textContent.includes('Reading')); });
        const containment = await target.locator('.tc-mx').evaluate(table => {
          const right = table.getBoundingClientRect().right;
          return {overflow:table.scrollWidth-table.clientWidth,rows:[...table.querySelectorAll('.tc-mx-head,.tc-mx-row')].map(row=>({right:row.getBoundingClientRect().right,cells:row.querySelectorAll(':scope > [role=cell],:scope > [role=columnheader]').length,last:row.lastElementChild.getBoundingClientRect().right})),right};
        });
        assert(containment.overflow<=1,'expanded agent columns stay within the table background: '+containment.overflow+'px overflow');
        assert(containment.rows.every(row=>row.cells===9&&Math.abs(row.right-containment.right)<1&&Math.abs(row.right-row.last-8)<1),'headers and every data row share the same nine columns and end inset');
        assert.equal(await target.locator('.tc-mx-row > .tc-mx-actions').count(),0,'row actions do not reserve an anonymous trailing column');
        const sticky = await target.locator('.tc-mx-scroll').evaluate(scroll => {
          scroll.scrollLeft=scroll.scrollWidth-scroll.clientWidth;
          const left=scroll.getBoundingClientRect().left, first=scroll.querySelector('.tc-mx-skill').getBoundingClientRect(), button=scroll.querySelector('.tc-mx-actions button').getBoundingClientRect();
          const header=scroll.querySelector('.tc-mx-head'), label=scroll.querySelector('.tc-mx-head-label'), group=scroll.querySelector('.tc-mx-group').getBoundingClientRect();
          return {first:first.left-left,button:button.left-left,width:scroll.clientWidth,headerCover:header.getBoundingClientRect().height-label.getBoundingClientRect().height,groupLeft:group.left-left,groupWidth:group.width};
        });
        assert(Math.abs(sticky.first)<1 && sticky.button>=0 && sticky.button<sticky.width,'skill names and row actions remain visible at the far scroll edge');
        assert(sticky.headerCover<=1&&Math.abs(sticky.groupLeft)<1&&Math.abs(sticky.groupWidth-sticky.width)<1,'fixed headers cover scrolling text and folder context fits the visible table');
        await shot('all-agent-columns');
        const firstPolicy = target.locator('.tc-mx-row .tc-cellwrap button').first();
        await firstPolicy.focus();
        const focusClear = await firstPolicy.evaluate(button => button.getBoundingClientRect().left >= button.closest('.tc-mx-row').querySelector('.tc-mx-skill').getBoundingClientRect().right - 1);
        assert(focusClear,'keyboard focus scrolls policy controls clear of the fixed skill column');
        await columnButton.click(); await shot('agent-columns-menu');
        assert.equal(await target.getByRole('menuitemradio',{name:/All agents/}).getAttribute('aria-checked'),'true');
        await target.getByRole('menuitemradio',{name:/Installed agents/}).click();
        await target.waitForFunction(() => document.querySelectorAll('.tc-mx-agent').length === 5);
      };
      if (process.env.T3_SKILLS_UI_RESOURCES_ONLY === '1') {
        await checkNativeResources();
        assert.deepEqual(errors, []);
        console.log(`${theme} ${width}${embedded ? ' embedded' : ''}: native availability and placement passed`);
        return;
      }
      if (process.env.T3_SKILLS_UI_UNIFIED_ONLY === '1') {
        await checkUnifiedLocations();
        assert.deepEqual(errors, []);

        console.log(`${theme} ${width}${embedded ? ' embedded' : ''}: unified locations, draft protection, exact save target and failed/late reads passed`);
        return;
      }
      await navigate('instructions/skills');
      await target.locator('.tc-mx-row').first().waitFor({ state: 'attached' });
      await target.waitForFunction(() => !document.querySelector('.tc-mx-agent-kind')?.textContent.includes('Reading'));
      assert.equal(await target.locator('.tc-mx-row').count(), 20);
      assert.equal(await target.locator('.tc-mx-agent').count(), 5);
      assert.equal(await target.locator('#cx-tab-skills').innerText(), 'Skills 24');
      if (width >= (TAB ? 640 : 1024) && width !== 1440) await checkColumns();
      const inventoryCount = Object.values(gets).reduce((a, b) => a + b, 0);
      await target.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForTimeout(300);
      assert.equal(Object.values(gets).reduce((a, b) => a + b, 0), inventoryCount, 'routine status polling must not discover skills');
      await target.locator('#skill-search').fill('__no_skill_matches__');
      await target.getByText('No skills match these filters',{exact:true}).waitFor();
      const clearFilters=target.getByRole('button',{name:'Clear filters',exact:true});
      if(width<(TAB?640:1024))assert((await clearFilters.boundingBox()).height>=44,'empty-state recovery keeps a 44px touch target');
      await shot('filtered-empty'); await clearFilters.click();
      await page.keyboard.press('/');
      assert.equal(await target.evaluate(() => document.activeElement.id), 'skill-search');
      await target.locator('#skill-search').fill('research narrative');
      assert.equal(await target.locator('.tc-mx-row').count(), 1);
      await target.locator('#skill-search').fill('');
      if (width >= (TAB ? 640 : 1024)) {
        await target.locator('.tc-lh [data-cmd="skills.show"][data-id=attention]').first().click();
        assert.equal(await target.locator('.tc-mx-row').count(), 1);
        await target.locator('.tc-lh [data-cmd="skills.show"][data-id=all]').click();
        await target.locator('[data-cmd="skills.filter"]').click();
        await target.getByRole('menuitemradio', { name: 'Codex', exact: true }).click();
        assert.equal(await target.locator('.tc-mx-row').count(), 3, 'off skills and collapsed system skills are not available user rows');
        await target.locator('[data-cmd="skills.filter"]').click();
        await target.getByRole('menuitemradio', { name: 'Any agent', exact: true }).click();
      } else {
        await checkChipFocus(page, target.locator('.tc-sk-agent-chips'), shot);
        await target.locator('[data-cmd="skills.agent"][data-provider=codex]').click();
        assert.equal(await target.locator('.tc-mx-row').count(), 3);
        await target.locator('.tc-sk-agent-chips [data-cmd="skills.show"][data-id=all]').click();
      }
      const beforeFilter = writes.length;
      await visible(target, '[data-cmd="skills.view-menu"]').click(); await target.getByRole('menuitemcheckbox', { name: /Show bundled skills/ }).click();
      assert.equal(await target.locator('.tc-mx-group-toggle').filter({ hasText: 'Codex system skills' }).count(), 0);
      assert.match(await target.locator('.tc-mx-hidden').innerText(), /4 bundled skills are hidden/);
      assert.equal(writes.length, beforeFilter, 'hiding bundled skills never writes provider settings');
      await shot('bundled-hidden');
      await visible(target, '[data-cmd="skills.view-menu"]').click(); await target.getByRole('menuitemcheckbox', { name: /Show bundled skills/ }).click();
      assert.equal(await target.locator('.tc-mx-row').count(), 20);
      await shot('library');
      await checkNoticeContrast(visible(target, '.tc-sk-notices .tc-notice-desc, .tc-sk-phone-summary .tc-pnote small').first());
      const deep = () => visible(target, 'button[data-cmd="skills.view"]').filter({ hasText: 'deep-research' });
      await deep().click();
      await target.locator('.tc-insp-body [data-source-editor] textarea[readonly]').waitFor();
      assert.equal(await target.evaluate(() => window.skillInjected), undefined);
      assert.equal(await target.locator('.tc-avail-row').count(), 5);
      assert.equal(await target.locator('.tc-files li').count(), 3);
      await checkSelect(page, target.getByRole('combobox', { name: /Claude Code visibility/ }), theme);
      await shot('inspector');
      if (width < (TAB ? 640 : 768)) {
        await target.locator('[data-inspect-menu]').click();
        await target.getByRole('menuitem', { name: 'Reinstall from source…', exact: true }).click();
        await target.locator('#skill-source').waitFor();
        assert.equal(await target.locator('#skill-source').inputValue(), '', 'a local skill does not invent a remembered origin');
        assert.equal(await target.evaluate(() => document.activeElement.id), 'skill-source');
        await close();
        await deep().click(); await target.locator('.tc-insp-body [data-source-editor] textarea[readonly]').waitFor();
      }
      await target.locator('[data-inspect-edit]').click();
      const draft = '---\nname: deep-research\ndescription: A reviewed draft\n---\nUnsaved draft survives status refresh.';
      await target.locator('#skill-content').fill(draft);
      await target.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForTimeout(250);
      assert.equal(await target.locator('#skill-content').inputValue(), draft);
      assert(await target.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), 'a dirty skill warns before a browser reload');
      await navigate('overview');
      await target.getByRole('alertdialog').waitFor();
      await target.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      await target.waitForFunction(() => location.hash === '#instructions/skills');
      assert.equal(await target.locator('#skill-content').inputValue(), draft, 'cancelled history navigation preserves the tab and draft');
      if (width === 1440 && theme === 'light') {
        await navigate('overview'); await target.getByRole('alertdialog').waitFor();
        await navigate('agents');
        assert.equal(await target.getByRole('alertdialog').count(), 1, 'rapid history changes share one discard decision');
        await target.getByRole('button', { name: 'Discard draft', exact: true }).click();
        await target.waitForFunction(() => document.body.dataset.consoleRoute === 'agents');
        await navigate('instructions/skills');
        await deep().click(); await target.locator('.tc-insp-body [data-source-editor] textarea[readonly]').waitFor();
        await target.locator('[data-inspect-edit]').click(); await target.locator('#skill-content').fill(draft);
      }
      await target.locator('[data-inspect-copy-to=codex]').click();
      await target.getByRole('alertdialog').waitFor();
      await shot('draft-protection');
      await target.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(await target.locator('#skill-content').inputValue(), draft, 'canceling a copy transition preserves the editor');
      assert.equal(await target.locator('.tc-skill-import').count(), 0);
      await target.locator('[data-inspect-copy-to=codex]').click();
      await target.getByRole('button', { name: 'Discard draft', exact: true }).click();
      await target.locator('[data-import-agent=codex]').waitFor();
      await close();
      await deep().click(); await target.locator('.tc-insp-body [data-source-editor] textarea[readonly]').waitFor();
      await target.locator('[data-inspect-edit]').click(); await target.locator('#skill-content').fill(draft);
      if (width === 1440 && theme === 'light') { saveGate = deferred(); saveStarted = deferred(); }
      saveFail = true; await target.locator('[data-inspect-save]').click();
      if (saveGate) {
        await saveStarted.promise;
        assert(await target.locator('[data-inspect-copy-to=codex]').isDisabled(), 'a save cannot be abandoned through Copy to');
        await page.keyboard.press('Escape'); assert(await target.locator('.tc-skill-inspector').isVisible());
        saveGate.resolve();
      }
      await target.getByRole('alert').filter({ hasText: 'Your draft is kept' }).waitFor();
      assert.equal(await target.locator('#skill-content').inputValue(), draft);
      saveFail = false;
      await page.keyboard.press('Escape');
      await target.getByRole('alertdialog').waitFor();
      await target.getByRole('button', { name: 'Discard draft', exact: true }).click();
      await target.locator('.tc-skill-inspector').waitFor({ state: 'hidden' });
      if (width === 1440 && theme === 'light') {
        // Separate settings files stay usable while one provider is writing.
        const policy = target.getByRole('button', { name: 'Claude Code visibility for deep-research: Name only', exact: true });
        await policy.click();
        assert.equal(await target.getByRole('menuitemradio', { name: /Name only/ }).getAttribute('aria-checked'), 'true');
        await page.keyboard.press('Escape'); assert(await policy.evaluate(el => el === document.activeElement));
        stateGate = deferred(); stateStarted = deferred();
        await policy.click(); await target.getByRole('menuitemradio', { name: /^Off/ }).click(); await stateStarted.promise;
        assert(await target.getByRole('button', { name: 'Claude Code visibility for built-in-browser: On', exact: true }).isDisabled());
        assert(await target.getByRole('button', { name: 'OpenCode permission for deep-research: Allowed', exact: true }).isEnabled());
        stateGate.resolve();
        await target.getByRole('button', { name: 'Claude Code visibility for deep-research: Off', exact: true }).waitFor();
        stateFail = true;
        await target.getByRole('button', { name: 'Claude Code visibility for deep-research: Off', exact: true }).click();
        await target.getByRole('menuitemradio', { name: /^On / }).click();
        await target.locator('.tc-toast[data-tone=danger]').filter({ hasText: 'Settings changed' }).waitFor();
        stateFail = false;
        providerError = 'grok'; await visible(target, '[data-cmd="skills.refresh"]').click();
        await target.getByText('Fixture agent is temporarily unavailable', { exact: true }).waitFor();
        assert(await target.getByRole('button', { name: 'OpenCode permission for deep-research: Allowed', exact: true }).isEnabled());
        await deep().click(); await target.locator('.tc-insp-body [data-source-editor] textarea[readonly]').waitFor();
        assert.equal(await target.locator('.tc-avail-row[data-reach=unknown]').count(), 1, 'failed discovery is unknown, not a missing installation');
        await close();
        providerError = null; await visible(target, '[data-cmd="skills.refresh"]').click();
        await target.getByText('Fixture agent is temporarily unavailable', { exact: true }).waitFor({ state: 'hidden' });
        providerError = 'all'; await page.reload();
        await target.getByText('Skills couldn’t be read', { exact: true }).waitFor();
        await shot('discovery-failure');
        assert.equal(await target.getByText('No skills yet', { exact: true }).count(), 0, 'discovery failures must not masquerade as an empty library');
        providerError = null; await target.getByRole('button', { name: 'Retry scan', exact: true }).click();
        await target.locator('.tc-mx-row').first().waitFor();
        await checkColumns();
        // A closed source request must release its late snapshot, never reopen.
        sourceGate = deferred(); sourceStarted = deferred();
        await visible(target, '[data-cmd="skills.import"]').click();
        await target.locator('#skill-source').fill('slow-source'); await target.locator('#skill-source').press('Enter'); await sourceStarted.promise;
        await close(); sourceGate.resolve();
        await page.waitForTimeout(200);
        assert(writes.some(write => write.path.endsWith('/discard')));
        assert.equal(await target.locator('.tc-skill-import').count(), 0);
        // A late detail must not overwrite another inspector's draft.
        readGate = deferred(); readStarted = deferred();
        await deep().click(); await readStarted.promise; await close();
        await visible(target, '[data-cmd="skills.add"]').click();
        await target.locator('#skill-slug').fill('my-workflow');
        await target.locator('#skill-content').fill(draft);
        readGate.resolve(); await page.waitForTimeout(100);
        assert.equal(await target.locator('#skill-content').inputValue(), draft);
        await page.keyboard.press('Escape'); await target.getByRole('button', { name: 'Discard draft', exact: true }).click();
      }
      const recoverResponse = width === 390;
      if (recoverResponse) {
        // Hold a scan that began before the wizard, while its cached library
        // remains usable. Let its metadata arrive only during publication.
        reachGate = deferred(30000); reachStarted = deferred();
        await visible(target, '[data-cmd="skills.refresh"]').click();
        await reachStarted.promise;
      }
      await target.locator('#skill-search').fill('design');
      await openSource();
      assert(await next().isDisabled());
      await target.locator('[data-import-skill=frontend-design]').check();
      assert.equal(await target.locator('[data-import-all]').evaluate(el => el.indeterminate), true);
      await target.locator('[data-import-all]').check();
      await target.locator('[data-import-files=frontend-design]').click();
      await target.locator('[data-import-markdown=frontend-design]').click();
      await target.locator('.tc-source-markdown .tc-code').waitFor();
      assert.equal(await target.evaluate(() => window.skillInjected), undefined);
      await page.keyboard.press('Escape');
      await shot('source');
      await next().click();
      await target.locator('[data-import-replace]').waitFor();
      assert(await next().isDisabled());
      assert.equal(writes.filter(write => write.path.endsWith('/plan')).at(-1).input.providers.join(','), 'claude,codex');
      const collapsedPlan = await target.locator('[data-import-rail]').isVisible();
      if (collapsedPlan) await target.locator('[data-import-rail]').click();
      assert((await target.locator('.tc-wizard-rail').innerText()).includes('Cursor finds 2 copies'));
      if (!collapsedPlan) {
        await target.evaluate(() => document.fonts.ready);
        await target.waitForFunction(() => {
          const rail = document.querySelector('.tc-wizard-rail');
          return rail && Math.abs(rail.getBoundingClientRect().bottom - rail.querySelector('.tc-plan-bottom').getBoundingClientRect().bottom - 20) < 2;
        });
      }
      await target.locator('[data-import-replace]').check();
      assert(await next().isEnabled());
      await shot('agents');
      if (width === 1440 && theme === 'light') {
        // Selection invalidates consent synchronously while an old plan is pending.
        planGate = deferred(); planStarted = deferred();
        await target.locator('[data-import-mode=each]').click(); await planStarted.promise;
        assert(await next().isDisabled());
        await target.locator('[data-import-mode=fewest]').click(); planGate.resolve();
        await target.locator('[data-import-replace]').waitFor();
        assert.equal(await target.locator('[data-import-replace]').isChecked(), false);
        await target.locator('[data-import-replace]').check();
        blocked = true; await target.locator('[data-import-mode=each]').click();
        await target.getByText('This folder is read-only', { exact: false }).waitFor();
        assert(await next().isDisabled());
        blocked = false; await target.locator('[data-import-mode=fewest]').click();
        await target.locator('[data-import-replace]').waitFor(); await target.locator('[data-import-replace]').check();
        partial = true;
        installGate = deferred(); installStarted = deferred();
      }
      const plannedBeforeInstall = writes.filter(write => write.path.endsWith('/plan')).length;
      if (recoverResponse) {
        loseInstallResponse = true; installGate = deferred(); installStarted = deferred();
      }
      await next().click();
      if (installGate) {
        await installStarted.promise;
        assert(await target.locator('[data-import-close]').isDisabled());
        assert(await target.locator('[data-import-agent=claude]').isDisabled(), 'publication freezes its selections');
        await page.keyboard.press('Escape');
        assert(await target.locator('.tc-skill-import').isVisible(), 'publication cannot be dismissed halfway through');
        await navigate('overview');
        await target.waitForFunction(() => location.hash === '#instructions/skills');
        assert(await target.locator('.tc-skill-import').isVisible(), 'history navigation cannot abandon publication');
        if (recoverResponse) {
          // Model an initial inventory scan finishing after publication starts.
          // The background completion must not clear the in-flight plan ID.
          reachGate.resolve();
          await target.waitForFunction(() => {
            const button = document.querySelector('.tc-sk-library-foot [data-cmd="skills.refresh"]');
            return button && !button.disabled && button.textContent.trim() === 'Rescan';
          });
        }
        installGate.resolve();
      }
      if (recoverResponse) {
        await target.getByRole('button', { name: 'Retry installation', exact: true }).waitFor();
        await target.waitForFunction(() => {
          const error = document.querySelector('#skill-import-error')?.getBoundingClientRect();
          const grid = document.querySelector('.tc-wizard-grid')?.getBoundingClientRect();
          return error && grid && error.top >= grid.top - 1 && error.bottom <= grid.bottom + 1;
        });
        assert(await target.locator('[data-import-agent=claude]').isDisabled(), 'keep the uncertain operation tied to its reviewed plan');
        assert(await target.locator('[data-import-back]').isDisabled());
        console.log('Recovery text contrast', theme, (await checkNoticeContrast(target.locator('#skill-import-error .tc-notice-desc'))).toFixed(2) + ':1');
        await shot('retry-installation');
        await next().click();
        const attempts = writes.filter(write => write.path.endsWith('/install')).slice(-2);
        assert.deepEqual(attempts[0].input, attempts[1].input, 'recover the original idempotent request');
        assert.equal(writes.filter(write => write.path.endsWith('/plan')).length, plannedBeforeInstall);
      }
      await target.locator('.tc-result-hero').waitFor();
      await target.waitForFunction(() => {
        const result = document.querySelector('.tc-result-hero')?.getBoundingClientRect();
        const grid = document.querySelector('.tc-wizard-grid')?.getBoundingClientRect();
        return result && grid && result.top >= grid.top - 1 && result.bottom <= grid.bottom + 1;
      });
      await shot('result');
      if (partial) {
        assert.equal(await target.locator('[data-import-review-again]').count(), 1);
        partial = false;
        const sourceCalls = writes.filter(write => write.path.endsWith('/source')).length;
        await target.locator('[data-import-review-again]').click();
        await target.locator('[data-import-replace]').waitFor(); await target.locator('[data-import-replace]').check();
        await next().click(); await target.locator('.tc-result-hero').waitFor();
        assert.equal(writes.filter(write => write.path.endsWith('/source')).length, sourceCalls);
      }
      await target.locator('[data-import-show]').click();
      await target.locator('.tc-skill-import').waitFor({ state: 'hidden' });
      assert.equal(await target.locator('#skill-search').inputValue(), '', 'Show in library clears the visible search field too');
      if (width === 1440 && theme === 'light') {
        expire = true; await openSource(); await target.locator('[data-import-all]').check();
        await target.getByText('This snapshot expired', { exact: true }).waitFor();
        assert(await next().isDisabled());
        expire = false; await target.locator('[data-import-reread]').click();
        await target.locator('[data-import-all]').waitFor();
        await target.getByText('This snapshot expired', { exact: true }).waitFor({ state: 'hidden' });
        await close();
        // File actions preserve drafts and carry both Markdown/tree revisions.
        await deep().click(); await target.locator('.tc-insp-body [data-source-editor] textarea[readonly]').waitFor();
        await target.locator('[data-inspect-remove]').click();
        await target.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert(!writes.some(write => write.path.endsWith('/remove')));
        await target.locator('[data-inspect-remove]').click();
        await target.getByRole('button', { name: 'Remove skill', exact: true }).click();
        await target.locator('.tc-skill-inspector').waitFor({ state: 'hidden' });
        const removal = writes.find(write => write.path.endsWith('/remove')).input;
        assert.equal(removal.revision, 'fixture-file-deep-research'); assert.equal(removal.removalRevision, 'fixture-removal');
        await visible(target, '[data-cmd="skills.add"]').first().click();
        await target.locator('#skill-slug').fill('my-workflow');
        const upload = '---\nname: my-workflow\ndescription: Uploaded workflow\n---\nSafe literal text.';
        await target.locator('#skill-file').setInputFiles({ name: 'workflow.md', mimeType: 'text/markdown', buffer: Buffer.from(upload) });
        await target.waitForFunction(text => document.querySelector('#skill-content')?.value === text, upload);
        assert(!writes.some(write => write.path.endsWith('/create')), 'upload changes only a draft');
        const download = page.waitForEvent('download');
        await target.locator('[data-inspect-download]').click();
        assert.equal((await download).suggestedFilename(), 'my-workflow.md');
        await target.locator('#skill-content').press('Control+s');
        await target.locator('.tc-skill-inspector').waitFor({ state: 'hidden' });
        assert.equal(writes.find(write => write.path.endsWith('/create')).input.content, upload);
      }
      // A tracked physical skill may be visible in several agent inventories.
      // Check it once and keep review scoped to its owning folder.
      const origin = { source: 'vercel-labs/skills', name: 'frontend-design', fingerprint: 'a'.repeat(64) };
      for (const inventory of Object.values(api.inventories)) for (const skill of inventory.skills) {
        delete skill.origin;
        if (skill.name === origin.name && skill.path.includes('/.claude/')) skill.origin = origin;
      }
      await target.locator('[data-cmd="skills.refresh"]').click();
      const checkUpdates = {
        waitFor: () => target.locator('[data-cmd="skills.check-updates"]').first().waitFor({ state: 'attached' }),
        click: async () => {
          if (width < (TAB ? 640 : 1024)) await visible(target, '.tc-sk-agent-chips [data-cmd="skills.show"][data-id=updates]').click();
          await visible(target, '[data-cmd="skills.check-updates"]').first().click();
          if (width < (TAB ? 640 : 1024)) await visible(target, '[data-cmd="skills.show"][data-id=all]').click();
        },
      };
      await checkUpdates.waitFor();
      await checkUpdates.click();
      await visible(target, '.tc-upd').first().waitFor();
      assert.equal(writes.filter(write => write.path.endsWith('/check-update')).length, 1);
      assert.equal(writes.find(write => write.path.endsWith('/check-update')).input.skills.length, 1, 'one batch contains each physical installation once');
      await visible(target, '.tc-sk-matrix .tc-skill-name, .tc-sk-phone-row').filter({ hasText: 'frontend-design' }).scrollIntoViewIfNeeded();
      await shot('repository-update');
      const trackedSkill = visible(target, '.tc-sk-matrix .tc-skill-name, .tc-sk-phone-row').filter({ hasText: 'frontend-design' });
      await trackedSkill.click(); await target.locator('[data-inspect-review-source]').first().waitFor();
      await target.locator('[data-inspect-review-source]').first().click();
      await target.locator('[data-update-consent]').waitFor();
      const review = writes.filter(write => write.path.endsWith('/update/preview')).at(-1).input;
      assert.deepEqual(review, { provider: 'claude', id: api.inventories.claude.skills.find(skill => skill.name === 'frontend-design').id });
      assert.equal(await target.locator('[data-update-consent]').isChecked(), false, 'source review retains explicit replacement consent');
      assert.equal(await target.locator('[data-import-mode]').count(), 0, 'an update cannot drift into choosing another destination');
      await shot('repository-review'); await close();
      updateStatus = 'error'; await checkUpdates.click();
      await visible(target, '.tc-tagline--src[data-tone=warn]').first().waitFor();
      updateStatus = 'current'; await checkUpdates.click();
      await visible(target, '.tc-upd').waitFor({ state: 'hidden' });
      updateGate = deferred(); updateStarted = deferred();
      await checkUpdates.click(); await updateStarted.promise;
      await target.locator('[data-cmd="skills.refresh"]').click();
      await target.waitForFunction(() => !document.querySelector('.tc-sk-scan-time')?.textContent.includes('Scanning'));
      updateGate.resolve();
      await checkUpdates.waitFor();
      assert.equal(await target.locator('.tc-badge').filter({ hasText: 'Up to date' }).count(), 0, 'late checks cannot decorate a rescanned installation');
      // The rescan above keeps painting as providers finish, and an open
      // popover closes on any scroll, so wait until the library is quiet first.
      // (Scoped to live controls: body textContent also matches inline scripts.)
      const quiet = () => !document.querySelector('.tc-lh-status')?.textContent.includes('Checking')
        && !document.querySelector('.tc-sk-scan-time')?.textContent.includes('Scanning')
        && ![...document.querySelectorAll('.tc-mx-agent-kind')].some(el => el.textContent.includes('Reading'));
      await target.waitForFunction(quiet);
      // Folder management stays available for undetected tools, including on phones.
      // N.B. force-click the menu items: a synthetic scrollIntoView scrolls the
      // page, and Kit closes popovers on any page scroll. Real pointer clicks
      // never scroll, so they don't hit this. Scroll to the top first so the
      // trigger click below settles before the menu opens.
      await target.evaluate(() => window.scrollTo(0, 0));
      await visible(target, '[data-cmd="skills.view-menu"]').click();
      const showAllAgents = target.getByRole('menuitemradio', { name: /All agents/ });
      await showAllAgents.waitFor({ state: 'visible' });
      await showAllAgents.click({ force: true });
      await target.waitForFunction(() => document.querySelectorAll('.tc-mx-agent[data-uninstalled]').length === 3);
      assert.equal(await target.locator('.tc-sk-provider-notice').filter({ hasText: 'isn’t detected' }).count(), 0);
      await shot('undetected-agent');
      await openSource();
      await target.locator('[data-import-skill="frontend-design"]').check();
      await next().click();
      await target.locator('[data-import-agent="antigravity"]').check();
      await target.getByRole('button', { name: 'Install 3 copies', exact: true }).waitFor();
      assert(writes.filter(write => write.path.endsWith('/plan')).at(-1).input.providers.includes('antigravity'), 'an explicitly selected undetected tool can receive a skill copy');
      await close();
      // Showing all agents loads the undetected providers above; wait out
      // those paints before reopening the menu.
      await target.waitForFunction(() => ![...document.querySelectorAll('.tc-mx-agent-kind')].some(el => el.textContent.includes('Reading')));
      await target.evaluate(() => window.scrollTo(0, 0));
      await visible(target, '[data-cmd="skills.view-menu"]').click();
      const installedAgents = target.getByRole('menuitemradio', { name: /Installed agents/ });
      await installedAgents.waitFor({ state: 'visible' });
      await installedAgents.click({ force: true });
      // Cards are an option on wider screens, with the table's folders and the
      // same skills. Phones keep the grouped list and have no layout switch.
      await target.waitForFunction(() => ![...document.querySelectorAll('.tc-mx-agent-kind')].some(el => el.textContent.includes('Reading')));
      if (width >= (TAB ? 640 : 1024)) {
        assert.equal(await target.locator('[data-key=skills-layout-table]').getAttribute('aria-pressed'), 'true', 'Table is the default layout');
        const tableRows = await target.locator('.tc-mx-row').count(), tableGroups = await target.locator('.tc-sk-matrix [data-cmd="skills.group"]').count();
        await target.locator('[data-key=skills-layout-cards]').click();
        await target.locator('.tc-skill-card').first().waitFor();
        assert.equal(await target.locator('.tc-skill-card').count(), tableRows, 'cards show the skills the table shows');
        assert.equal(await target.locator('.tc-skill-cards [data-cmd="skills.group"]').count(), tableGroups, 'cards keep the folder groups');
        assert.match(await target.locator('.tc-skill-card').filter({ hasText: 'computer-use' }).first().innerText(), /Ask in OpenCode/, 'a card names the agents that limit its skill');
        assert.equal(await target.evaluate(() => localStorage.getItem('t3-console-skill-view')), 'cards');
        await shot('cards');
        await target.locator('.tc-skill-card [data-cmd="skills.view"]').filter({ hasText: 'deep-research' }).first().click();
        await target.locator('#skill-view-title').waitFor(); await close();
        await target.locator('[data-key=skills-layout-table]').click();
        await target.locator('.tc-mx-row').first().waitFor();
      } else {
        assert.equal(await visible(target, '[data-key=skills-layout-cards]').count(), 0, 'phones have no layout switch');
        assert(await visible(target, '.tc-sk-phone-row').count() > 0, 'phones keep the grouped list');
      }
      await checkUnifiedLocations();
      await checkNativeResources();
      await navigate('instructions');
      await target.locator('.tc-doc-preview .tc-code').waitFor();
      assert.equal(await target.locator('.tc-reads-row').count(), 8);
      assert.equal(await target.locator('.tc-reads-row .tc-seg button').count(), 24);
      assert.equal(await target.locator('.tc-doc-preview script').count(), 0);
      await shot('instructions');
      const overflow = await target.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, 'the page never scrolls sideways');
      assert.deepEqual(errors, []);

      console.log(`${theme} ${width}${embedded ? ' embedded' : ''}: library, policies, safe inspector, draft conflicts, placement, consent, results and instructions passed`);
      async function checkUnifiedLocations() {
        // Same-named files retain their own availability, reads and write target.
        await navigate('instructions/skills');
        await target.locator('.tc-mx-row').first().waitFor({ state: 'attached' });
        await target.waitForFunction(() => ![...document.querySelectorAll('.tc-mx-agent-kind')].some(el => el.textContent.includes('Reading')));
        const copyA = '/home/t3/.codex/skills/location-review/SKILL.md', copyB = '/home/t3/.agents/skills/location-review/SKILL.md';
        const template = api.inventories.codex.skills.find(skill => skill.canEdit && skill.canToggle);
        api.inventories.codex.skills.push(...[copyA, copyB].map((file, index) => ({ ...template,
          id: 'unified-check-' + (index ? 'b' : 'a'), name: 'location-review', path: file, resolvedPath: file,
          description: 'Review the ' + (index ? 'shared' : 'Codex') + ' copy.', source: index ? 'Shared .agents' : 'Provider',
          state: index ? 'enabled' : 'disabled', origin: null, update: null })));
        await visible(target, '[data-cmd="skills.refresh"]').click();
        await target.locator('#skill-search').fill('location-review');
        await target.waitForFunction(() => document.querySelectorAll('.tc-mx-row').length === 2);
        await visible(target, '[data-cmd="skills.view-menu"]').click();
        await target.getByRole('menuitemcheckbox', { name: /Unified view/ }).click();
        assert.equal(await target.locator('.tc-mx-row').count(), 1);
        assert.equal(await target.evaluate(() => localStorage.getItem('t3-console-skill-unified')), 'true');
        const unifiedRow = target.locator('.tc-mx-row');
        assert.equal(await unifiedRow.locator('[data-cmd="skills.state"], [data-cmd="skills.policy"], [data-cmd="skills.copy"]').count(), 0, 'grouped cells require a location before changing a copy');
        if (width >= (TAB ? 640 : 1024)) await unifiedRow.getByRole('button', { name: /Codex availability.*Available in 1 of 2 locations/ }).click();
        else await visible(target, 'button[data-cmd="skills.view"]').filter({ hasText: 'location-review' }).click();
        const location = target.locator('#skill-location'), content = target.locator('#skill-content');
        await content.waitFor();
        assert.equal(await location.inputValue(), copyB);
        assert.match(await content.inputValue(), /Location: unified-check-b/);
        assert.equal(await target.locator('.tc-insp-desc').innerText(), 'Review the shared copy.');
        await checkSelect(page, location, theme);
        await target.locator('[data-inspect-edit]').click();
        await content.fill('---\nname: location-review\ndescription: A local draft\n---\nKeep this draft.');
        await location.selectOption(copyA);
        await target.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(await location.inputValue(), copyB);
        assert.match(await content.inputValue(), /Keep this draft/);
        await location.selectOption(copyA);
        await target.getByRole('button', { name: 'Discard draft', exact: true }).click();
        await target.waitForFunction(() => document.querySelector('#skill-content')?.value.includes('Location: unified-check-a'));
        assert.equal(await target.locator('.tc-insp-desc').innerText(), 'Review the Codex copy.');
        await shot('unified-location');
        await target.locator('[data-inspect-edit]').click();
        const savedCopy = '---\nname: location-review\ndescription: A local edit\n---\nOnly change the Codex copy.';
        await content.fill(savedCopy);
        await target.locator('[data-inspect-save]').click();
        await target.locator('.tc-skill-inspector').waitFor({ state: 'hidden' });
        const save = writes.findLast(write => write.path.endsWith('/save'));
        assert.equal(save.input.provider, 'codex'); assert.equal(save.input.id, 'unified-check-a'); assert.equal(save.input.content, savedCopy);
        await visible(target, 'button[data-cmd="skills.view"]').filter({ hasText: 'location-review' }).click();
        await content.waitFor();
        readFailId = 'unified-check-a';
        await location.selectOption(copyA);
        await target.getByRole('alert').filter({ hasText: 'This location was removed' }).waitFor();
        assert.equal(await content.count(), 0, 'failed reads never leave the previous copy in the editor');
        assert.equal(await target.locator('[data-inspect-edit], [data-inspect-save]').count(), 0);
        readFailId = null;
        await location.selectOption(copyB);
        await content.waitFor();
        assert.match(await content.inputValue(), /Location: unified-check-b/);
        readGateId = 'unified-check-a'; readGate = deferred(); readStarted = deferred();
        await location.selectOption(copyA); await readStarted.promise;
        assert(await location.isDisabled(), 'locations cannot change during a pending read');
        await close();
        await visible(target, 'button[data-cmd="skills.view"]').filter({ hasText: 'location-review' }).click();
        await content.waitFor();
        const lateRead = page.waitForResponse(response => new URL(response.url()).searchParams.get('id') === 'unified-check-a');
        readGate.resolve(); await lateRead;
        assert.match(await content.inputValue(), /Location: unified-check-b/, 'a closed location read cannot replace the current inspector');
        readGateId = null;
        await close();
        await shot('unified-library');
        await visible(target, '[data-cmd="skills.view-menu"]').click();
        await target.getByRole('menuitemcheckbox', { name: /Unified view/ }).click();
        await target.locator('#skill-search').fill('');
        const overflow = await target.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.equal(overflow, false, 'the page never scrolls sideways');
      }
      async function checkNativeResources() {
        for (const agent of status.harnesses) agent.installed = true;
        await target.evaluate(() => {
          localStorage.setItem('t3-console-skill-unified', 'false');
          localStorage.setItem('t3-console-skill-view', 'table');
          location.hash = 'instructions/skills';
          location.reload();
        });
        await target.waitForFunction(() => document.querySelectorAll('.tc-mx-agent').length === 8
          && ![...document.querySelectorAll('.tc-mx-agent-kind')].some(el => el.textContent.includes('Reading')));
        const openInstallation = async entry => {
          await visible(target, 'button[data-cmd="skills.view"][data-id="' + (entry.resolvedPath || entry.path) + '"]').click();
          await target.locator('.tc-skill-inspector #skill-content').waitFor();
          await target.waitForFunction(() => document.querySelector('.tc-skill-inspector .tc-insp-body')?.getAttribute('aria-busy') === 'false');
        };
        for (const provider of ['grok', 'muse', 'pi']) {
          const entry = api.inventories[provider].skills.find(row => row.canSetState);
          await openInstallation(entry);
          const select = target.locator('[data-skill-policy][data-skill-provider="' + provider + '"]');
          for (const state of provider === 'muse' ? ['off', 'user-invocable-only', 'on'] : ['disabled', 'enabled']) {
            await select.selectOption(state);
            await target.waitForFunction(([provider, state]) => document.querySelector('[data-skill-policy][data-skill-provider="' + provider + '"]')?.value === state, [provider, state]);
            const saved = writes.findLast(write => write.path.endsWith('/state'));
            assert.equal(saved.input.provider, provider); assert.equal(saved.input.id, entry.id); assert.equal(saved.input.state, state);
            assert(saved.input.stateRevision, 'native availability includes its optimistic revision');
          }
          await checkSelect(page, select, theme);
          await shot('native-policy-' + provider);
          await close();
          if (width >= (TAB ? 640 : 1024)) {
            await target.locator('[data-cmd="skills.policy"][data-provider="' + provider + '"][data-id="' + entry.id + '"]').click();
            const menu = target.getByRole('menu');
            assert.match(await menu.innerText(), /availability/);
            assert.doesNotMatch(await menu.innerText(), /Claude/);
            assert.match(await menu.innerText(), /Saved in/);
            await page.keyboard.press('Escape');
          }
        }
        for (const provider of ['cursor', 'antigravity']) {
          const entry = api.inventories[provider].skills.find(row => row.stateAuthority === 'placement' && row.canToggle);
          const originalId = entry.id, originalPath = entry.path;
          await openInstallation(entry);
          await target.locator('[data-inspect-edit]').click();
          const content = target.locator('#skill-content'), draft = '---\nname: ' + entry.name + '\ndescription: A preserved draft\n---\nKeep this draft while moving.';
          await content.fill(draft);
          const toggle = target.locator('.tc-skill-inspector [data-cmd="skills.state"][data-provider="' + provider + '"]');
          await toggle.click();
          await target.waitForFunction(provider => document.querySelector('.tc-skill-inspector [data-cmd="skills.state"][data-provider="' + provider + '"]')?.getAttribute('aria-checked') === 'false'
            && document.querySelector('#skill-content')?.readOnly, provider);
          assert.notEqual(entry.id, originalId); assert.notEqual(entry.path, originalPath);
          assert.match(await target.locator('.tc-pathlist').innerText(), /skills\.t3-disabled/);
          assert.equal(await content.inputValue(), draft, 'parking preserves the draft');
          assert(await target.locator('[data-inspect-save]').isDisabled(), 'parked files cannot be saved');
          await shot('parked-' + provider);
          await toggle.click();
          await target.waitForFunction(provider => document.querySelector('.tc-skill-inspector [data-cmd="skills.state"][data-provider="' + provider + '"]')?.getAttribute('aria-checked') === 'true'
            && document.querySelector('#skill-content')?.readOnly === false
            && document.querySelector('[data-inspect-save]')?.disabled === false, provider);
          assert.equal(entry.path, originalPath);
          assert.doesNotMatch(await target.locator('.tc-pathlist').innerText(), /skills\.t3-disabled/);
          assert.equal(await content.inputValue(), draft, 'restoring preserves the draft');
          await target.locator('[data-inspect-save]').click();
          await target.locator('.tc-skill-inspector').waitFor({ state: 'hidden' });
          const saved = writes.findLast(write => write.path.endsWith('/save'));
          assert.equal(saved.input.provider, provider); assert.equal(saved.input.id, entry.id);
          assert.equal(saved.input.revision, entry.revision, 'saving uses the restored installation’s fresh revision');
          assert.equal(saved.input.content, draft);
          await openInstallation(entry);
          await toggle.click();
          await target.waitForFunction(provider => document.querySelector('.tc-skill-inspector [data-cmd="skills.state"][data-provider="' + provider + '"]')?.getAttribute('aria-checked') === 'false'
            && document.querySelector('.tc-skill-inspector .tc-insp-body')?.getAttribute('aria-busy') === 'false', provider);
          assert.equal(await target.locator('[data-inspect-edit], [data-inspect-remove]').count(), 0, 'parked installations are read-only');
          await toggle.click();
          await target.locator('[data-inspect-edit]').waitFor();
          await close();
        }
        assert.equal(await target.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'new availability controls fit the page');
      }
    }, { name: 'Skills', output });
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
