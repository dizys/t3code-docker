#!/usr/bin/env node
const { run, visible, deferred, fits, assert } = require('./lib/skill-audit.cjs');
run('hooks', async ({ page, target, api, requests, control, width, shot }) => {
  let getGate, getBegan, saveGate, saveBegan, conflict = false, failRead = false, empty = false;
  control.before = async ({ route, url }) => {
    if (url.pathname.endsWith('/skills/hooks')) {
      if (getGate) { const gate = getGate; getGate = null; getBegan.resolve(); await gate.promise; }
      if (failRead) { await route.fulfill({ status: 403, json: { ok: false, error: 'This Codex version could not read plugin hooks.' } }); return true; }
      if (empty) { await route.fulfill({ json: { ok: true, hooks: [], warnings: [] } }); return true; }
    }
    if (url.pathname.endsWith('/hooks/state')) {
      if (saveGate) { const gate = saveGate; saveGate = null; saveBegan.resolve(); await gate.promise; }
      if (conflict) {
        conflict = false; api.hooks[0].command += ' --changed'; api.hooks[0].revision += '-external'; api.hooks[0].trustStatus = 'modified';
        await route.fulfill({ status: 409, json: { ok: false, error: 'The hook changed outside the console.' } }); return true;
      }
    }
  };
  const sheet = target.locator('.tc-sheet--hooks'), first = () => sheet.locator('[data-hook=' + JSON.stringify(api.hooks[0].id) + ']');
  const writes = () => requests.filter(row => row.path.endsWith('/hooks/state'));
  const reads = () => requests.filter(row => row.path.endsWith('/skills/hooks'));
  const open = () => visible(target, '[data-cmd="skills.hooks"]').first().click();
  const refresh = () => sheet.locator('.tc-hk-foot [data-hooks-refresh]').click();
  const done = async () => { await sheet.getByRole('button', { name: 'Done', exact: true }).click(); await sheet.waitFor({ state: 'hidden' }); };
  await target.waitForFunction(() => document.querySelector('.tc-sk-phone-summary')?.textContent.includes('plugin hook'));
  assert.equal(reads().length, 1, 'one hook read after the first library render');
  await target.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await target.locator('#skill-search').fill('front'); await target.locator('#skill-search').fill('');
  assert.equal(reads().length, 1, 'status polls and filtering never invoke native discovery');
  await open(); await first().waitFor();
  assert.equal(reads().length, 1, 'opening shares the library inventory');
  assert.equal(await sheet.locator('[data-hook]').count(), 4);
  assert.equal(await sheet.locator('.tc-hk-plugin').count(), 2);
  assert(await sheet.getByRole('button', { name: 'Close plugin hooks', exact: true }).evaluate(node => node === document.activeElement), 'trust is never the default focus');
  assert(await fits(sheet), 'hooks fit the viewport');
  if (width === 1440) {
    const geometry = await sheet.locator('.tc-hk-footnote').evaluate(note => ({ note: note.getBoundingClientRect().bottom, footer: note.closest('.tc-sheet--hooks').querySelector('.tc-hk-foot').getBoundingClientRect().top }));
    assert(geometry.note <= geometry.footer, 'the four-hook reference layout keeps its footnote above the footer: ' + JSON.stringify(geometry));
  }
  assert.match(await sheet.innerText(), /Changed since you trusted it/);
  assert.match(await sheet.innerText(), /No skills · 2 hooks/);
  const managed = sheet.locator('[data-hook]').filter({ hasText: 'Managed' });
  assert(await managed.getByRole('switch').isDisabled()); assert.equal(await managed.getByRole('switch').getAttribute('aria-checked'), 'true');
  await shot('hooks');
  // The command is already on screen. Trust has no second confirmation layer.
  const saving = deferred(); saveGate = saving; saveBegan = deferred();
  await first().getByRole('button', { name: 'Trust command', exact: true }).click(); await saveBegan.promise;
  assert.equal(await target.getByRole('alertdialog').count(), 0);
  assert.match(await first().innerText(), /Trusting…/);
  assert(await sheet.getByRole('button', { name: 'Done', exact: true }).isDisabled());
  await page.keyboard.press('Escape'); assert(await sheet.isVisible());
  assert(await target.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); dispatchEvent(event); return event.defaultPrevented; }));
  saving.resolve(); await first().getByText('Runs', { exact: true }).waitFor();
  const toggle = first().getByRole('switch');
  assert(await toggle.evaluate(node => node === document.activeElement), 'trust success returns focus to its switch');
  assert.equal(api.hooks[2].enabled, true); assert.equal(writes().length, 1);
  const revisionAfterTrust = api.hooks[0].revision;
  await toggle.click(); await first().getByText('Off', { exact: true }).waitFor();
  assert.equal(writes().at(-1).input.revision, revisionAfterTrust, 'every next action uses the fresh inventory revision');
  await toggle.click(); await first().getByText('Runs', { exact: true }).waitFor();
  conflict = true; await toggle.click();
  await first().getByText('This hook changed. Review the new command.', { exact: true }).waitFor();
  await first().getByLabel('Command for When a session starts').filter({ hasText: '--changed' }).waitFor();
  assert(await first().getByRole('button', { name: 'Trust new command', exact: true }).isEnabled());
  await shot('changed-command');
  await first().getByRole('button', { name: 'Trust new command', exact: true }).click();
  await first().getByText('Runs', { exact: true }).waitFor();
  assert.equal(writes().at(-1).input.revision.endsWith('-external'), true);
  const second = sheet.locator('[data-hook=' + JSON.stringify(api.hooks[1].id) + ']');
  await second.getByRole('button', { name: 'Turn off', exact: true }).click();
  await second.getByText('Off · not trusted', { exact: true }).waitFor();
  assert(await second.getByRole('switch').isDisabled());
  await second.getByRole('button', { name: 'When you send a prompt', exact: true }).click();
  await second.getByRole('button', { name: 'Trust command', exact: true }).click();
  await second.getByText('Off', { exact: true }).waitFor(); assert.equal(await second.getByRole('switch').getAttribute('aria-checked'), 'false');
  await second.getByRole('switch').click(); await second.getByText('Runs', { exact: true }).waitFor();
  api.hooks[0].command = '<script>window.hookInjected=true</script>' + ' long-argument'.repeat(80);
  await refresh(); await first().getByRole('button', { name: 'When a session starts', exact: true }).click();
  await first().getByLabel('Command for When a session starts').filter({ hasText: '<script>' }).waitFor();
  assert.equal(await target.evaluate(() => window.hookInjected), undefined);
  assert(await first().evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'long commands wrap in the card');
  await shot('long-command');
  api.hooks.push({ ...api.hooks[3], id: 'unsupported-hook', handlerType: 'prompt', command: null, eventName: 'stop', readOnlyReason: 'Review this hook type in Codex; its full definition is not available here.' });
  await refresh();
  const unsupported = sheet.locator('[data-hook=unsupported-hook]');
  await unsupported.getByText('Review in Codex', { exact: true }).waitFor();
  assert(await unsupported.getByRole('switch').isDisabled());
  assert.equal(await unsupported.locator('[data-hook-action]').count(), 0);
  api.hooks.pop();
  failRead = true; await refresh(); await sheet.getByRole('alert').filter({ hasText: 'Couldn’t read plugin hooks' }).waitFor();
  assert.equal(await sheet.locator('[data-hook-switch]:not([disabled])').count(), 0);
  failRead = false; empty = true; await refresh();
  await sheet.getByText('No installed Codex plugins have hooks.', { exact: true }).waitFor(); await shot('empty');
  empty = false; await refresh(); await first().waitFor();
  await done();
  // A plugin with skills can open a filtered sheet; plugins without skills remain
  // reachable through the permanent footer entry.
  await target.locator('#skill-search').fill('code-review');
  await visible(target, '.tc-sk-matrix .tc-skill-name, .tc-sk-phone-row').click();
  await target.getByRole('button', { name: 'Review hooks…', exact: true }).click();
  await first().waitFor(); assert.equal(await sheet.locator('[data-hook]').count(), 2);
  await sheet.getByRole('button', { name: 'All plugins', exact: true }).click(); assert.equal(await sheet.locator('[data-hook]').count(), 4);
  await done(); await target.getByRole('button', { name: 'Close skill inspector', exact: true }).click();
  await target.locator('#skill-search').fill('');
  // Closing during a fresh read must never resurrect the sheet.
  await open(); await first().waitFor();
  const late = deferred(); getGate = late; getBegan = deferred(); await refresh(); await getBegan.promise;
  await done(); late.resolve();
  await target.waitForFunction(() => !document.querySelector('.tc-sheet--hooks'));
  assert.equal(await sheet.count(), 0);
}).catch(error => { console.error(error); process.exit(1); });
