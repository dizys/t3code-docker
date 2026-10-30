#!/usr/bin/env node
// The actual MCP interface against isolated, synthetic settings. All POSTs
// are intercepted; no real agent configuration or MCP server is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const { statusFor, portsFor, routeConsole, framed, unlock, visit } = require('./lib/console-fixtures.cjs');
const { createMcpFixtures } = require('./lib/mcp-fixtures.cjs');
const { checkChipFocus } = require('./lib/chip-focus.cjs');
const base = process.argv[2] || 'http://127.0.0.1:23804/__setup/', key = process.argv[3] || 'dev';
const TAB = process.env.T3_UI_AUDIT_TAB === '1';
const out = process.env.T3_MCP_UI_OUTPUT || '/tmp/t3-mcp-ui-audit'; fs.mkdirSync(out, { recursive: true });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const theme of ['light', 'dark']) for (const variant of (TAB ? [480,639,640,704,1040].map(w=>'tab-'+w) : ['desktop', 'phone', 'embedded', 'embedded-phone'])) {
      const embedded = TAB || variant.startsWith('embedded'), phone = TAB ? Number(variant.slice(4))<640 : variant === 'phone' || variant === 'embedded-phone', viewport = TAB ? {width:Number(variant.slice(4)),height:900} : phone ? { width: 390, height: 844 } : variant === 'embedded' ? { width: 1198, height: 878 } : { width: 1440, height: 900 };
      const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: 'reduce' });
      const page = await context.newPage(), mcp = createMcpFixtures(), errors = [], calls = [];
      let failRead = false, failRemoval = false, linkGate = null, readGate = null, parseGate = null, createGate = null, conflictLink = false, conflictSave = false, unreadableStore = false, installedOverride = null;
      page.on('pageerror', error => errors.push(error.message));
      const status = () => { const s = statusFor('skills'); if (installedOverride) for (const agent of s.harnesses) agent.installed = installedOverride.includes(agent.id); s.context.mcp = mcp.status(); return s; };
      await routeConsole(page, { status, ports: () => portsFor('ready') });
      await page.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (!url.pathname.includes('/context/mcp')) return route.fallback();
        const input = req.method() === 'POST' ? req.postDataJSON() : {};
        if (req.method() === 'POST') calls.push({ route: url.pathname.split('/').at(-1), ...input });
        if (url.pathname.endsWith('/parse') && parseGate) await parseGate.promise;
        if (url.pathname.endsWith('/create') && createGate) await createGate.promise;
        if (url.pathname.endsWith('/link') && conflictLink) { conflictLink = false; return route.fulfill({ status: 409, json: { ok: false, code: 'conflict', error: 'Synthetic settings conflict' } }); }
        if (url.pathname.endsWith('/save') && conflictSave) { conflictSave = false; return route.fulfill({ status: 409, json: { ok: false, code: 'conflict', error: 'Synthetic shared conflict' } }); }
        if (url.pathname.endsWith('/read') && readGate) await readGate.promise;
        if (url.pathname.endsWith('/read') && failRead) return route.fulfill({ status: 500, json: { ok: false, error: 'Synthetic read failure' } });
        if (url.pathname.endsWith('/link') && input.provider === 'codex' && linkGate) await linkGate.promise;
        if (url.pathname.endsWith('/link') && !input.linked && input.provider === 'opencode' && failRemoval) return route.fulfill({ status: 503, json: { ok: false, error: 'Synthetic native write failure' } });
        const result = await mcp.respond(req.method(), url, input);
        if (unreadableStore && req.method() === 'GET' && url.pathname.endsWith('/context/mcp')) { result.body.ok = false; Object.assign(result.body.shared, { error: 'Synthetic unreadable store', revision: null, count: 0, servers: [] }); }
        return route.fulfill({ status: result.status, json: result.body });
      });
      const url = new URL(base); if (embedded) { url.searchParams.set('embed', 't3'); url.searchParams.set('theme', theme); if(TAB){url.searchParams.set('host','tab');url.searchParams.set('layout',phone?'compact':'wide');} }
      const target = embedded ? await framed(page, url.href) : page;
      if (!embedded) await page.goto(url.href);
      await unlock(target, key); await visit(target, page, 'mcp');
      assert.equal(await target.evaluate(() => document.documentElement.getAttribute('data-embed')), embedded ? 't3' : null, 'The authenticated page must retain its actual embedding mode');
      if (phone && !TAB) assert.equal(await target.getByRole(embedded ? 'button' : 'link', { name: embedded ? 'Close setup' : 'Close MCP servers', exact: true }).isVisible(), true, 'Phone close uses the applied embedding mode');
      await target.locator('#mcp-search').waitFor();
      await target.locator('[data-key="mcp-shared:docs"]').waitFor({ state: 'attached' });
      await target.evaluate(() => { location.hash = 'instructions/mcp'; });
      await target.waitForFunction(() => location.hash === '#mcp');
      await target.evaluate(() => { location.hash = 'overview'; });
      await target.locator('#page-overview:not([hidden])').waitFor();
      await page.keyboard.press('g'); await page.keyboard.press('m');
      await target.locator('#page-mcp:not([hidden])').waitFor();
      await page.keyboard.press('/');
      assert.equal(await target.evaluate(() => document.activeElement.id), 'mcp-search');
      await page.keyboard.press('Tab');
      const screenshot = async name => { await page.screenshot({ path: path.join(out, `${variant}-${theme}-${name}.png`) }); };
      const noOverflow = async () => assert.equal(await target.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Document must not overflow');
      const openServer = async name => { await target.locator(phone ? `.tc-sk-phone-list [data-cmd="mcp.view"][data-id="${name}"]` : `.tc-mx [data-cmd="mcp.view"][data-id="${name}"]`).click(); await target.locator('.tc-mcp-inspector .tc-mcp-connection').waitFor(); };
      const closeInspector = () => target.getByRole('button', { name: 'Close server inspector', exact: true }).click();
      await noOverflow(); await screenshot('library');
      if (phone) {
        await checkChipFocus(page, target.locator('.tc-mcp-library .tc-sk-agent-chips'), screenshot);
        const add = await target.locator('.tc-sk-phone-actions button').boundingBox();
        assert.ok(add && add.y + add.height <= viewport.height && add.y > 0, 'Phone Add stays reachable');
        assert.equal(await target.locator('.tc-tabbar').isVisible(), false);
      } else {
        assert.equal(await target.locator('.tc-mcp-table [role="columnheader"]').count(), 6);
        const columnButton = target.locator('[data-cmd="mcp.columns"]');
        assert.equal(await target.locator('.tc-mcp-extra').count(), 0, 'No trailing +2 control');
        await columnButton.click();
        assert.equal(await target.getByRole('menuitemradio', { name: /^Installed agents/ }).getAttribute('aria-checked'), 'true');
        await page.keyboard.press('Escape');
        assert.equal(await columnButton.evaluate(element => element === document.activeElement), true, 'Column menu restores keyboard focus');
        await columnButton.click();
        await target.getByRole('menuitemradio', { name: /^All agents/ }).click();
        await target.waitForFunction(() => document.querySelectorAll('.tc-mcp-table [role="columnheader"]').length === 8);
        assert.equal(await columnButton.innerText(), 'All agents');
        assert.equal(await target.locator('.tc-mcp-table .tc-mx-agent[data-uninstalled]').count(), 2);
        assert.equal(await target.locator('.tc-mcp-table .tc-mx-agent').filter({ hasText: 'Not managed here' }).count(), 2);
        const measureColumns = () => target.locator('.tc-mcp-table .tc-mx').evaluate(table => {
          const right = table.getBoundingClientRect().right;
          return {
            overflow: table.scrollWidth - table.clientWidth, right,
            rows: [...table.querySelectorAll('.tc-mx-head,.tc-mx-row')].map(row => ({ right: row.getBoundingClientRect().right, cells: row.children.length, last: row.lastElementChild.getBoundingClientRect().right, grid: getComputedStyle(row).gridTemplateColumns })),
            overflowing: [...table.querySelectorAll('*')].filter(element => element.getBoundingClientRect().right > right + 1).slice(0, 10).map(element => ({ class: element.getAttribute('class'), right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width })),
          };
        });
        // New DOM columns can land a frame before container-query sizing.
        // Wait for actual containment, as in the Skills audit; a persistent
        // overflow still fails with measurements and a screenshot.
        await target.waitForFunction(() => {
          const table = document.querySelector('.tc-mcp-table .tc-mx');
          return table.scrollWidth <= table.clientWidth + 1;
        }, null, { timeout: 5000 }).catch(async error => {
          await screenshot('all-agent-columns-containment-failure');
          console.error(`${variant} ${theme}: expanded column layout: ${JSON.stringify(await measureColumns())}`);
          throw error;
        });
        const containment = await measureColumns();
        if (containment.overflow > 1) await screenshot('all-agent-columns-containment-failure');
        assert.ok(containment.overflow <= 1, `${variant} ${theme}: expanded columns fit their table background: ${JSON.stringify(containment)}`);
        assert.ok(containment.rows.every(row => row.cells === 8 && Math.abs(row.right - containment.right) < 1 && Math.abs(row.right - row.last - 8) < 1), `${variant} ${theme}: every header and row uses eight columns with the same end inset: ${JSON.stringify(containment)}`);
        const sticky = await target.locator('.tc-mcp-table .tc-mx-scroll').evaluate(scroll => {
          scroll.scrollLeft = scroll.scrollWidth - scroll.clientWidth;
          const left = scroll.getBoundingClientRect().left, header = scroll.querySelector('.tc-mx-head'), label = scroll.querySelector('.tc-mx-head-label'), group = scroll.querySelector('.tc-mx-group').getBoundingClientRect();
          return { first: scroll.querySelector('.tc-mx-skill').getBoundingClientRect().left - left, button: scroll.querySelector('[data-cmd="mcp.columns"]').getBoundingClientRect().left - left, width: scroll.clientWidth, headerCover: header.getBoundingClientRect().height - label.getBoundingClientRect().height, groupLeft: group.left - left, groupWidth: group.width };
        });
        assert.ok(Math.abs(sticky.first) < 1 && sticky.button >= 0 && sticky.button < sticky.width, 'Names and column selector stay visible at the far scroll edge');
        assert.ok(sticky.headerCover <= 1 && Math.abs(sticky.groupLeft) < 1 && Math.abs(sticky.groupWidth - sticky.width) < 1, 'Pinned headings cover scrolling text and keep group context in view');
        await screenshot('all-agent-columns');
        const firstPolicy = target.locator('.tc-mcp-table .tc-mx-row .tc-cellwrap button').first();
        await firstPolicy.focus();
        assert.ok(await firstPolicy.evaluate(button => button.getBoundingClientRect().left >= button.closest('.tc-mx-row').querySelector('.tc-mx-skill').getBoundingClientRect().right - 1), 'Focused controls scroll clear of the pinned server column');
        await columnButton.click();
        assert.equal(await target.getByRole('menuitemradio', { name: /^All agents/ }).getAttribute('aria-checked'), 'true');
        await screenshot('agent-columns-menu');
        assert.match(await target.getByRole('menu').innerText(), /Muse Code/);
        await target.getByRole('menuitemradio', { name: /^Installed agents/ }).click();
        await target.waitForFunction(() => document.querySelectorAll('.tc-mcp-table [role="columnheader"]').length === 6);
        assert.equal(await target.locator('.tc-mcp-table .tc-mx-scroll').evaluate(scroll => scroll.scrollLeft), 0);
        assert.equal(await columnButton.evaluate(element => element === document.activeElement), true, 'Visibility choice restores focus');
        assert.equal(calls.length, 0, 'Column visibility never writes settings');
        // The selected menu survives an unrelated /status refresh.
        await target.getByRole('button', { name: 'docs in Codex: on', exact: true }).click();
        await target.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        assert.equal(await target.getByRole('menu').isVisible(), true);
        await screenshot('cell-menu');
        linkGate = deferred();
        await target.getByRole('menuitemradio', { name: /^Off/ }).click();
        await target.locator('.tc-mcp-table [role="status"]').waitFor();
        assert.equal(await target.getByRole('button', { name: 'Share filesystem with Codex', exact: true }).isEnabled(), false);
        assert.equal(await target.getByRole('button', { name: 'docs in OpenCode: on', exact: true }).isEnabled(), true);
        linkGate.resolve(); linkGate = null;
        await target.getByRole('button', { name: 'docs in Codex: off', exact: true }).waitFor();
      }
      await openServer('docs');
      assert.equal(await target.locator('.tc-mcp-inspector').getByText('Bearer synthetic-shared-token', { exact: true }).count(), 0, 'No secret DOM before reveal');
      if (phone) await target.getByRole('button', { name: 'Review', exact: true }).click();
      await target.locator('.tc-diff-vals').waitFor();
      assert.equal(await target.locator('.tc-diff').innerText().then(text => /synthetic-.*token/.test(text)), false);
      await target.getByRole('button', { name: 'Reveal Authorization', exact: true }).click();
      assert.equal(await target.locator('.tc-mcp-secret-value').innerText(), 'Bearer synthetic-shared-token');
      await target.getByRole('button', { name: 'Hide Authorization', exact: true }).click();
      await screenshot('inspector');
      if (phone) {
        await target.locator('[data-mcp-policy="codex"]').selectOption('off');
        await target.locator('[data-mcp-policy="codex"]').waitFor();
        assert.equal(await target.locator('[data-mcp-policy="codex"]').inputValue(), 'off');
      }
      conflictLink = true;
      await target.locator('[data-mcp-policy="codex"]').selectOption('on');
      await target.locator('.tc-mcp-inspector').getByText('Settings changed elsewhere. Showing the current state.', { exact: true }).waitFor();
      assert.equal(await target.locator('[data-mcp-policy="codex"]').inputValue(), 'off');
      await target.getByRole('button', { name: 'Edit server…', exact: true }).click();
      await target.locator('#mcp-url').waitFor();
      await target.locator('#mcp-url').fill('https://docs.example.test/v2/mcp');
      await target.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      assert.equal(await target.locator('#mcp-url').inputValue(), 'https://docs.example.test/v2/mcp');
      await screenshot('edit');
      if (variant === 'desktop') {
        await page.setViewportSize({ width: 390, height: 844 });
        await target.locator('.tc-wizard-rail-toggle').waitFor();
        await page.setViewportSize(viewport);
        await target.locator('.tc-mcp-editor .tc-agentpick').waitFor();
        assert.equal(await target.locator('#mcp-url').inputValue(), 'https://docs.example.test/v2/mcp');
      }
      await page.keyboard.press('Escape');
      await target.getByRole('button', { name: 'Cancel', exact: true }).last().click(); // keep draft
      assert.equal(await target.locator('#mcp-url').inputValue(), 'https://docs.example.test/v2/mcp');
      conflictSave = true;
      await target.getByRole('button', { name: 'Save and update 2 agents', exact: true }).click();
      await target.getByRole('button', { name: 'Reload current settings', exact: true }).waitFor();
      assert.equal(await target.locator('#mcp-url').inputValue(), 'https://docs.example.test/v2/mcp');
      assert.equal(await target.getByRole('button', { name: 'Save and update 2 agents', exact: true }).isEnabled(), false);
      await target.getByRole('button', { name: 'Reload current settings', exact: true }).click();
      await target.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await target.waitForFunction(() => document.querySelector('#mcp-url')?.value === 'https://docs.example.test/mcp');
      await target.locator('#mcp-url').fill('https://docs.example.test/v2/mcp');
      await target.getByRole('button', { name: 'Save and update 2 agents', exact: true }).click();
      await target.locator('.tc-mcp-editor').waitFor({ state: 'detached' });
      assert.equal(mcp.status().providers.find(p => p.provider === 'codex').disabled.includes('docs'), true, 'Editing preserves Off');
      assert.equal(mcp.status().providers.find(p => p.provider === 'claude').diverged.includes('docs'), true, 'Differing copies untouched by default');

      await target.locator(phone ? '.tc-sk-phone-actions [data-cmd="mcp.add"]' : '.tc-sk-desktop-actions [data-cmd="mcp.add"]').click();
      parseGate = deferred();
      await target.locator('#mcp-snippet').fill('{"mcpServers":{"issues":{"command":"npx","args":["-y","@acme/issues-mcp",""],"env":{"ISSUES_TOKEN":"<your token>"}}}}');
      await target.locator('#mcp-name').waitFor();
      await target.locator('.tc-paste-meta').filter({ hasText: 'Reading snippet…' }).waitFor();
      await target.locator('#mcp-name').fill('manual-draft');
      parseGate.resolve(); parseGate = null;
      await target.getByRole('button', { name: 'Use snippet', exact: true }).waitFor();
      assert.equal(await target.locator('#mcp-name').inputValue(), 'manual-draft', 'Late parse must not overwrite manual edits');
      await target.getByRole('button', { name: 'Use snippet', exact: true }).click();
      await target.waitForFunction(() => document.querySelector('#mcp-name')?.value === 'issues');
      assert.equal(await target.locator('#mcp-arg-3').inputValue(), '', 'Empty argument stays lossless');
      assert.equal(await target.getByText(/still holds the snippet’s placeholder/).isVisible(), true);
      await target.locator('[data-mcp-editor="type"][data-type="remote"]').click();
      await target.locator('#mcp-url').fill('https://transport-draft.test/mcp');
      await target.locator('[data-mcp-editor="type"][data-type="local"]').click();
      assert.equal(await target.locator('#mcp-arg-3').inputValue(), '');
      assert.equal(await target.locator('[data-mcp-field="pair-value"]').inputValue(), '<your token>');
      await target.locator('[data-mcp-editor="type"][data-type="remote"]').click();
      assert.equal(await target.locator('#mcp-url').inputValue(), 'https://transport-draft.test/mcp');
      await target.locator('[data-mcp-editor="type"][data-type="local"]').click();
      await screenshot('add-snippet');
      const beforeCreates = calls.filter(c => c.route === 'create').length;
      createGate = deferred();
      await target.getByRole('button', { name: 'Add to 4 agents', exact: true }).click();
      await target.getByRole('button', { name: 'Adding', exact: true }).waitFor();
      assert.equal(await target.getByRole('button', { name: 'Cancel', exact: true }).isEnabled(), false);
      await page.keyboard.press('Control+Enter'); await page.keyboard.press('Control+Enter');
      createGate.resolve(); createGate = null;
      await target.locator('.tc-mcp-editor').waitFor({ state: 'detached' });
      assert.equal(calls.filter(c => c.route === 'create').length, beforeCreates + 1);
      assert.deepEqual(calls.filter(c => c.route === 'link' && c.name === 'issues').map(c => c.provider).sort(), ['claude', 'codex', 'cursor', 'opencode']);

      await target.locator(phone ? '.tc-sk-phone-list [data-cmd="mcp.share"][data-id="github"]' : '.tc-mx [data-cmd="mcp.share"][data-id="github"]').first().click();
      await target.locator('[data-mcp-consent="opencode"]').waitFor();
      assert.equal(await target.getByRole('button', { name: 'Share and use in 4 agents', exact: true }).isEnabled(), false);
      await target.locator('[data-mcp-consent="opencode"]').check();
      await screenshot('share-consent');
      await target.getByRole('button', { name: 'Share and use in 4 agents', exact: true }).click();
      await target.locator('.tc-mcp-editor').waitFor({ state: 'detached' });
      assert.equal(mcp.status().ownGroups.some(g => g.name === 'github'), false);
      assert.equal(mcp.status().shared.servers.some(s => s.name === 'github'), true);

      // One source needs a summary card, not a vacant radio track.
      await target.locator(phone ? '.tc-sk-phone-list [data-cmd="mcp.share"][data-id="filesystem"]' : '.tc-mx [data-cmd="mcp.share"][data-id="filesystem"]').first().click();
      await target.locator('.tc-choice--summary').waitFor();
      assert.ok((await target.locator('.tc-choice-head').boundingBox()).width > 100);
      await target.getByRole('button', { name: 'Cancel', exact: true }).click();

      await openServer('docs');
      if (phone) { await target.getByRole('button', { name: 'Server actions', exact: true }).click(); await target.getByRole('menuitem', { name: 'Remove…', exact: true }).click(); }
      else await target.getByRole('button', { name: 'Remove…', exact: true }).click();
      failRemoval = true;
      await target.locator('[data-mcp-remove="confirm"]').click();
      await target.locator('.tc-mcp-remove [role="alert"]').waitFor();
      assert.equal(mcp.status().shared.servers.some(s => s.name === 'docs'), true, 'Partial remove retains shared definition');
      await screenshot('remove-partial');
      failRemoval = false;
      await target.locator('[data-mcp-remove="confirm"]').click();
      await target.locator('.tc-mcp-remove').waitFor({ state: 'detached' });
      assert.equal(mcp.status().shared.servers.some(s => s.name === 'docs'), false);

      await openServer('database');
      await target.locator('[data-mcp-policy="codex"]').selectOption('remove');
      await target.waitForFunction(() => getComputedStyle(document.getElementById('toaster')).visibility === 'hidden');
      await target.locator('.tc-mcp-inspector [data-mcp-inspect="undo"]').click();
      await target.waitForFunction(() => document.querySelector('[data-mcp-policy="codex"]')?.value === 'off');
      assert.equal(mcp.status().providers.find(p => p.provider === 'codex').disabled.includes('database'), true, 'Undo preserves Off');
      await closeInspector();

      failRead = true; await target.locator(phone ? '.tc-sk-phone-list [data-cmd="mcp.view"][data-id="issues"]' : '.tc-mx [data-cmd="mcp.view"][data-id="issues"]').click();
      await target.locator('.tc-mcp-inspector [role="alert"]').waitFor();
      failRead = false; await target.getByRole('button', { name: 'Try again', exact: true }).click();
      await target.locator('.tc-mcp-inspector .tc-mcp-connection').waitFor(); await closeInspector();
      readGate = deferred();
      await target.locator(phone ? '.tc-sk-phone-list [data-cmd="mcp.view"][data-id="issues"]' : '.tc-mx [data-cmd="mcp.view"][data-id="issues"]').click();
      await closeInspector(); readGate.resolve(); readGate = null;
      await target.locator('.tc-mcp-inspector').waitFor({ state: 'detached' });
      unreadableStore = true;
      await target.getByRole('button', { name: 'Rescan', exact: true }).click();
      await target.getByText('Shared servers unavailable', { exact: true }).waitFor();
      assert.equal(await target.locator(phone ? '.tc-sk-phone-list [data-id="filesystem"]' : '.tc-mx [data-id="filesystem"]').first().isVisible(), true, 'Readable native entries survive an unreadable shared store');
      assert.equal(await target.locator(phone ? '.tc-sk-phone-actions [data-cmd="mcp.add"]' : '.tc-sk-desktop-actions [data-cmd="mcp.add"]').isEnabled(), false);
      await screenshot('unreadable-store');
      if (embedded && phone) {
        await page.evaluate(() => { window.mcpMessages = []; window.addEventListener('message', event => window.mcpMessages.push(event.data)); });
        await (TAB?target.locator('.tc-pagebar [data-cmd="embed.close"]'):target.getByRole('button', { name: 'Close setup', exact: true })).click();
        await page.waitForFunction(() => window.mcpMessages.some(message => message?.source === 't3-setup' && message.type === 'close'));
      }
      if (variant === 'desktop' && theme === 'light') {
        unreadableStore = false;
        const reload = async ids => {
          installedOverride = ids;
          await target.evaluate(() => location.reload());
          await target.locator('.tc-mcp-table .tc-mx-row').first().waitFor();
          await target.waitForFunction(count => document.querySelectorAll('.tc-mcp-table .tc-mx-agent').length === count, ids.length);
        };
        await reload(['claude', 'codex', 'opencode', 'grok']);
        await target.locator('[data-cmd="mcp.columns"]').click();
        await target.getByRole('menuitemradio', { name: /^All agents/ }).click();
        const cursor = target.locator('[data-key="mcp-shared:issues-cursor"]');
        assert.equal(await cursor.locator('button').count(), 0, 'An uninstalled managed agent has no mutation control');
        assert.equal(await cursor.innerText(), 'On', 'Its saved state stays visible');
        await reload([]);
        await target.locator('[data-cmd="mcp.columns"]').click();
        await target.getByRole('menuitemradio', { name: /^All agents/ }).click();
        assert.equal(await target.locator('.tc-mcp-table .tc-cellwrap button').count(), 0, 'Zero installed agents cannot mutate native settings');
        await reload(['claude', 'codex', 'opencode', 'cursor', 'grok', 'muse', 'antigravity']);
        assert.equal(await target.locator('[data-cmd="mcp.columns"]').count(), 0, 'No redundant choice when all agents are installed');
        assert.equal(await target.locator('[data-key="mcp-shared:issues-muse"] button').count(), 0, 'Installing an unsupported agent does not enable management');
      }
      await noOverflow(); assert.deepEqual(errors, [], 'No browser exceptions');
      console.log(`${variant} ${theme}: matrix, secrets, per-agent off, draft/poll guards, snippet, consent, partial removal, failed/late reads passed`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
