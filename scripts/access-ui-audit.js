#!/usr/bin/env node
// Slow/failed Access mutations against the real console with fixture-only
// APIs. No request can rename/revoke a real device or create a real pairing.
// node scripts/access-ui-audit.js http://127.0.0.1:23780/__setup/ dev
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { statusFor, portsFor, fixture } = require('./lib/console-fixtures.cjs');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const base = process.argv[2] || 'http://127.0.0.1:23780/__setup/';
const key = process.argv[3] || 'dev';
const output = process.env.T3_ACCESS_UI_OUTPUT || '/tmp/t3-access-ui-audit';
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

const geometry = () => {
  const issues = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('horizontal page overflow');
  for (const el of document.querySelectorAll('#page-access .tc-row, #page-access .tc-pair-form, .tc-layer [role=dialog], .tc-layer [role=alertdialog]')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.left < -1 || r.right > innerWidth + 1) issues.push('card/dialog outside viewport');
    if (el.closest('.tc-layer') && (r.top < -1 || r.bottom > innerHeight + 1)) issues.push('dialog outside viewport');
  }
  return issues;
};

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const [width, height, embedded] of [[360,800,false],[390,844,false],[820,1000,false],[1280,900,false],[1198,878,true]]) for (const theme of ['light','dark']) {
      if (process.env.T3_ACCESS_UI_WIDTHS && !process.env.T3_ACCESS_UI_WIDTHS.split(',').includes(String(width))) continue;
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = [], requests = [];
      page.setDefaultTimeout(8000);
      await page.clock.install();
      await page.addInitScript(mode => localStorage.setItem('t3-console-theme', mode), theme);
      page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:',error.message); });
      const status = statusFor('ready');
      status.connect = { state: 'on', linked: true, relayHost: 'relay.t3.codes', preferences: { linked: true, managedTunnelActive: true, publishAgentActivity: false, holdWebhooksWhileOffline: false } };
      status.sessions = [{ sessionId: 'phone', setupLabel: 'Work phone', client: { platform: 'ios', label: 'Original phone' }, createdAt: new Date().toISOString() },
        { sessionId: 'other', setupLabel: 'Other device', client: { platform: 'macos' }, createdAt: new Date().toISOString() }];
      status.pairings = [{ id: 'spare', label: 'Spare link', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString() }];
      status.authLists = { session: { available: true, stale: false, refreshing: false }, pairing: { available: true, stale: false, refreshing: false } };
      let heldStatus = null, renameGate = null, revokeGate = null, pairGate = null;
      let renameFail = false, revokeFail = false, pairFail = false, unavailable = false;
      let preferenceGate = null, preferenceFail = false;
      let connectAuthorized = false, connectMode = 'managed';
      await page.route('**/*', async route => {
        const url = new URL(route.request().url()), method = route.request().method();
        const at = suffix => url.pathname.endsWith(suffix);
        if (at('/access-audit-host')) return route.fulfill({ contentType: 'text/html', body: `<iframe title="Setup" src="${base}?embed=t3&theme=${theme}#access" style="border:0;width:100%;height:100%"></iframe><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style>` });
        if (at('/status')) {
          const snapshot = structuredClone(status), held = heldStatus; heldStatus = null;
          if (unavailable) { snapshot.sessions = []; snapshot.authLists.session = { available:false,stale:true,refreshing:true }; }
          if (held) { held.started.resolve(); await held.release.promise; }
          return route.fulfill({ json: snapshot });
        }
        if (at('/ports')) return route.fulfill({ json: portsFor('ready') });
        if (at('/providers')) return route.fulfill({ json: fixture('providers.json') });
        if (at('/.well-known/t3/environment')) return route.fulfill({ json: {} });
        if (at('/auth/signin')) {
          const input = route.request().postDataJSON();
          assert.equal(input.agent, 'connect'); connectMode = input.mode;
          requests.push({ action: 'connect-signin', mode: input.mode });
          return route.fulfill({ json: { id: 'connect-fixture', state: 'awaiting-browser', url: 'https://fixture.invalid/device', code: 'TEST-CODE' } });
        }
        if (at('/auth/session')) return route.fulfill({ json: { id: 'connect-fixture', state: connectAuthorized ? 'done' : 'awaiting-browser', url: 'https://fixture.invalid/device', code: 'TEST-CODE' } });
        if (at('/auth/cancel')) return route.fulfill({ json: { ok: true } });
        if (at('/t3/restart')) {
          status.t3.pid += 1;
          status.connect = { state: 'on', linked: true, linkMode: connectMode, relayHost: 'relay.t3.codes', preferences: { linked: true, managedTunnelActive: connectMode === 'managed', publishAgentActivity: connectMode === 'publish_only', holdWebhooksWhileOffline: false } };
          return route.fulfill({ status: 202, json: { ok: true } });
        }
        if (at('/connect/preferences')) {
          const input = route.request().postDataJSON(); requests.push({ action: 'preference', ...input });
          await preferenceGate?.promise;
          if (preferenceFail) return route.fulfill({ status: 502, json: { ok: false, error: 'Could not save connection settings. Try again.' } });
          Object.assign(status.connect.preferences, input);
          return route.fulfill({ json: { ok: true, preferences: status.connect.preferences } });
        }
        if (at('/devices/rename')) {
          const input = route.request().postDataJSON(); requests.push({ action:'rename', ...input }); await renameGate?.promise;
          if (renameFail) return route.fulfill({ status:503, json:{ ok:false,error:'Device names are temporarily unavailable. Try again.' } });
          const session = status.sessions.find(row => row.sessionId === input.id);
          if (input.label) session.setupLabel = input.label; else delete session.setupLabel;
          return route.fulfill({ json:{ ok:true,label:input.label || null,session } });
        }
        if (at('/revoke')) {
          const input = route.request().postDataJSON(); requests.push({ action:'revoke', ...input }); await revokeGate?.promise;
          if (revokeFail) return route.fulfill({ status:503, json:{ ok:false,error:'Access could not be revoked. Try again.' } });
          const field=input.kind==='session'?'sessions':'pairings', id=input.kind==='session'?'sessionId':'id';
          status[field]=status[field].filter(row=>row[id]!==input.id);
          return route.fulfill({ json:{ok:true} });
        }
        if (at('/pair')) {
          const input=route.request().postDataJSON(); requests.push({ action:'pair', ...input }); await pairGate?.promise;
          if (pairFail) return route.fulfill({ status:503, json:{ok:false,error:'Pairing is temporarily unavailable. Try again.'} });
          const link={id:'minted',label:input.label,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()};
          status.pairings.push(link);
          return route.fulfill({json:{...link,pairUrl:'https://fixture.invalid/pair#token=fixture',credential:'fixture-only',qr:null}});
        }
        // Only authentication goes to the disposable console. Every other
        // mutation is refused here, even if a future UI adds a new action.
        if (method==='POST' && !at('/login')) return route.fulfill({status:400,json:{ok:false,error:'Unexpected fixture mutation'}});
        return route.continue();
      });
      await page.goto(base);
      if (await page.getByLabel('Setup key',{exact:true}).isVisible()) {
        await page.getByLabel('Setup key',{exact:true}).fill(key);
        await page.getByRole('button',{name:'Unlock',exact:true}).click();
        await page.locator('#app').waitFor();
      }
      if (embedded) await page.goto(new URL('/access-audit-host',base).href);
      else await page.goto(base+'#access');
      const t = embedded ? page.frames().find(frame=>frame.url().includes('embed=t3')) : page;
      assert(t,'embedded console frame is present');
      const tag=`${width}-${theme}${embedded?'-embedded':''}`;
      const device=t.locator('[data-key="dev-phone"]'), other=t.locator('[data-key="dev-other"]');
      await device.waitFor().catch(async error => { console.error(await t.locator('body').innerText()); throw error; });
      const check=async state=>assert.deepEqual(await t.evaluate(geometry),[],`${tag}: ${state}`);
      const screenshot = async name => {
        if (['connection-saving', 'connection-saving-webhooks', 'connection-failed', 'connection-enabled', 'connection-unavailable'].includes(name)) {
          await t.locator('[data-key="connect"]').evaluate(row => {
            row.closest('.tc-group').scrollIntoView({ block: 'end', behavior: 'instant' });
            window.scrollBy({ top: (document.querySelector('.tc-tabbar')?.getBoundingClientRect().height || 0) + 16, behavior: 'instant' });
          });
          assert.equal(await t.locator('[data-key="connect-holdWebhooksWhileOffline"]').evaluate(row => {
            const bar = document.querySelector('.tc-tabbar')?.getBoundingClientRect();
            return row.getBoundingClientRect().bottom <= (bar?.height ? bar.top : innerHeight) - 4;
          }), true, `${tag}: the connection setting and its error stay above navigation`);
        }
        await check(name);
        await page.screenshot({ path: path.join(output, `${tag}-${name}.png`) });
      };
      const rename=async()=>{await t.locator('[data-cmd="device.menu"][data-id="phone"]').click();await t.getByRole('menuitem',{name:'Rename…',exact:true}).click();await t.locator('#device-label').waitFor();};
      const revoke=async(kind,id)=>{await t.locator(`[data-cmd="${kind==='session'?'device':'link'}.menu"][data-id="${id}"]`).click();await t.getByRole('menuitem',{name:kind==='session'?'Revoke…':'Revoke link…',exact:true}).click();await t.getByRole('alertdialog').getByRole('button',{name:kind==='session'?'Revoke':'Revoke link',exact:true}).click();};

      const publish = t.getByRole('switch', { name: 'Publish agent activity', exact: true });
      const hold = t.getByRole('switch', { name: 'Hold webhooks while offline', exact: true });
      const publishRow = t.locator('[data-key="connect-publishAgentActivity"]');
      const holdRow = t.locator('[data-key="connect-holdWebhooksWhileOffline"]');
      preferenceGate = gate();
      await publish.click();
      assert.equal(await publish.isDisabled(), true);
      assert.equal(await hold.isDisabled(), true);
      assert.equal(await publishRow.getAttribute('aria-busy'), 'true');
      await publishRow.getByRole('status').filter({ hasText: 'Saving…' }).waitFor();
      assert.equal(await holdRow.getByRole('status').count(), 0, 'only the changed setting shows progress');
      await publish.evaluate(button => button.click());
      assert.equal(requests.filter(row => row.action === 'preference').length, 1);
      await screenshot('connection-saving');
      preferenceGate.resolve(); preferenceGate = null;
      await t.locator('#connect-toggle-publishAgentActivity[aria-checked=true]:enabled').waitFor();
      assert.equal(await hold.getAttribute('aria-checked'), 'false');
      preferenceFail = true; preferenceGate = gate(); await hold.click();
      await holdRow.getByRole('status').filter({ hasText: 'Saving…' }).waitFor();
      assert.equal(await publishRow.getByRole('status').count(), 0);
      await screenshot('connection-saving-webhooks');
      preferenceGate.resolve(); preferenceGate = null;
      await holdRow.getByRole('alert').filter({ hasText: 'Could not save connection settings. Try again.' }).waitFor();
      assert.equal(await publishRow.getByRole('alert').count(), 0, 'save errors stay beside the setting that failed');
      assert.equal(await hold.evaluate(button => button === document.activeElement), true, 'focus returns to the failed setting');
      assert.equal(await hold.getAttribute('aria-checked'), 'false');
      await screenshot('connection-failed');
      preferenceFail = false; await hold.click();
      await t.locator('#connect-toggle-holdWebhooksWhileOffline[aria-checked=true]:enabled').waitFor();
      assert.equal(await holdRow.getByRole('alert').count(), 0, 'a successful retry clears the error');
      assert.equal(await publish.getAttribute('aria-checked'), 'true');
      await screenshot('connection-enabled');
      status.connect.preferences.managedTunnelActive = false;
      await page.clock.fastForward(16000);
      await t.locator('#connect-toggle-holdWebhooksWhileOffline:disabled').waitFor();
      assert.equal(await publish.isDisabled(), false);
      status.connect.preferences = null;
      await page.clock.fastForward(16000);
      await t.locator('#connect-toggle-publishAgentActivity:disabled').waitFor();
      await screenshot('connection-unavailable');

      for (const mode of ['publish_only', 'managed']) {
        connectAuthorized = false;
        const removed = mode === 'managed';
        status.connect = { state: removed ? 'signin' : 'off', linked: false, revoked: removed, linkMode: 'managed', preferences: null };
        await page.clock.fastForward(16000);
        const connect = t.locator('[data-key="connect"]');
        await connect.getByRole('button', { name: removed ? 'Set up again' : 'Set up', exact: true }).waitFor();
        assert.equal(await publish.isDisabled(), true);
        if (removed) await connect.getByText(/removed from your T3 account/).waitFor();
        await connect.getByRole('button', { name: removed ? 'Set up again' : 'Set up', exact: true }).click();
        const dialog = t.getByRole('dialog', { name: 'T3 Connect', exact: true });
        assert.equal(await dialog.getByRole('radio', { name: /^T3 Connect tunnel/ }).isChecked(), true);
        const selectedMode = dialog.getByRole('radio', { name: mode === 'publish_only' ? /^Notifications only/ : /^T3 Connect tunnel/ });
        await selectedMode.check();
        await page.clock.runFor(250);
        assert.equal(await selectedMode.isChecked(), true);
        await screenshot('connection-choice-' + mode);
        await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
        await dialog.getByText('TEST-CODE', { exact: true }).waitFor();
        assert.equal(requests.filter(row => row.action === 'connect-signin').at(-1).mode, mode);
        connectAuthorized = true;
        await page.clock.fastForward(1600);
        await dialog.getByRole('button', { name: 'Restart T3 Code', exact: true }).click();
        await page.clock.fastForward(1600);
        await dialog.getByRole('button', { name: 'Done', exact: true }).waitFor();
        await dialog.getByText(mode === 'publish_only' ? /through your own address/ : /through relay\.t3\.codes/).waitFor();
        await screenshot('connection-ready-' + mode);
        await dialog.getByRole('button', { name: 'Done', exact: true }).click();
        assert.equal(await publish.getAttribute('aria-checked'), String(mode === 'publish_only'));
        assert.equal(await hold.isDisabled(), mode === 'publish_only');
      }

      await rename(); await t.locator('#device-label').fill('Travel phone <safe> & "work"');
      // Capture a poll before saving, then deliver it after the write.
      const old={started:gate(),release:gate()}; heldStatus=old;
      await page.clock.fastForward(16000);
      await Promise.race([old.started.promise, new Promise((_,reject)=>setTimeout(()=>reject(new Error('Status poll did not start')),8000))]);
      renameGate=gate();
      await t.locator('[data-key=device-save]').click();
      await device.locator('.tc-access-pending').waitFor();
      assert.equal(await device.getAttribute('aria-busy'),'true');
      assert.equal(await device.getByRole('button').isDisabled(),true);
      assert.equal(await t.locator('#device-label').isDisabled(),true);
      await t.locator('.tc-device-rename').evaluate(form=>form.requestSubmit());
      assert.equal(requests.filter(row=>row.action==='rename').length,1,'duplicate submit is blocked');
      await page.keyboard.press('Escape'); assert.equal(await t.locator('.tc-device-rename').count(),1,'pending save cannot be dismissed');
      await screenshot('saving-name');
      renameGate.resolve(); renameGate=null;
      await t.locator('.tc-device-rename').waitFor({state:'hidden'});
      await device.getByText('Travel phone <safe> & "work"',{exact:true}).waitFor();
      old.release.resolve(); await page.waitForTimeout(80);
      assert.equal(await device.locator('.tc-row-name').textContent(),'Travel phone <safe> & "work"','late poll cannot undo rename');
      assert.equal(await device.getByRole('button').isDisabled(),false);
      await page.clock.fastForward(4000);

      await rename(); renameFail=true; await t.locator('#device-label').fill('W'.repeat(64)); await t.locator('[data-key=device-save]').click();
      await t.getByText('Device names are temporarily unavailable. Try again.',{exact:true}).first().waitFor();
      assert.equal(await t.locator('#device-label').inputValue(),'W'.repeat(64));
      assert.equal(await t.locator('#device-label').isDisabled(),false);
      await screenshot('rename-failed');
      renameFail=false; await t.locator('#device-label').fill(''); await t.locator('[data-key=device-save]').click();
      await t.locator('.tc-device-rename').waitFor({state:'hidden'});
      await device.getByText('Original phone',{exact:true}).waitFor();

      revokeGate=gate(); revokeFail=true;
      await revoke('session','phone'); await device.locator('.tc-access-pending').waitFor();
      assert.equal(await device.getByRole('button').isDisabled(),true);
      assert.equal(await other.getByRole('button').isDisabled(),false,'other items stay usable');
      await screenshot('revoking-device');
      revokeGate.resolve(); revokeGate=null;
      await device.getByRole('alert').waitFor();
      assert.equal(await device.getByRole('button').isDisabled(),false);
      await screenshot('revoke-failed');
      revokeFail=false; unavailable=true;
      await revoke('session','phone'); await device.waitFor({state:'detached'});
      await page.clock.fastForward(4000); await other.waitFor();
      assert.equal(await t.locator('[data-key="dev-phone"]').count(),0,'unavailable cache cannot resurrect a revoked device');
      unavailable=false; await page.clock.fastForward(4000);

      revokeGate=gate(); await revoke('pairing','spare');
      const link=t.locator('[data-key="link-spare"]'); await link.locator('.tc-access-pending').waitFor();
      assert.equal(await link.getByRole('button').isDisabled(),true);
      await screenshot('revoking-link'); revokeGate.resolve(); revokeGate=null; await link.waitFor({state:'detached'});

      pairGate=gate(); pairFail=true;
      await t.locator('#pair-label').fill('Tablet'); await t.locator('[data-key=pair-create]').click();
      await t.getByRole('button',{name:'Creating link…',exact:true}).waitFor();
      assert.equal(await t.locator('#pair-label').isDisabled(),true);
      for(const button of await t.locator('[data-cmd="pair.ttl"]').all()) assert.equal(await button.isDisabled(),true);
      await t.locator('[data-key=pair-create]').evaluate(button=>button.click());
      assert.equal(requests.filter(row=>row.action==='pair').length,1);
      await screenshot('creating-link');
      pairGate.resolve(); pairGate=null;
      await t.getByText('Pairing is temporarily unavailable. Try again.',{exact:true}).waitFor();
      assert.equal(await t.locator('#pair-label').inputValue(),'Tablet');
      assert.equal(await t.locator('#pair-label').isDisabled(),false);
      pairFail=false; await t.locator('[data-key=pair-create]').click();
      await t.getByRole('button',{name:'Revoke link',exact:true}).waitFor();
      await t.getByRole('button',{name:'Revoke link',exact:true}).click();
      await t.getByRole('alertdialog').getByRole('button',{name:'Revoke link',exact:true}).click();
      await t.getByText(/This link was revoked before a device used it/).waitFor();
      await screenshot('link-revoked');
      assert.deepEqual(errors,[]);
      await context.close(); console.log(`PASS ${tag}: connection modes, relinking, preferences, pending states, failures/retry, stale polls and pairing`);
    }
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
