#!/usr/bin/env node
const { run, visible, deferred, fits, assert } = require('./lib/skill-audit.cjs');
run('updates', async ({ page, target, api, requests, control, width, shot }) => {
  let gate, began, checkGate, checkBegan, saveGate, saveBegan, previewError = false, conflict = false, lost = false, expiry = false, omitted = false, noLocal = false, huge = false, manyFiles = false, long = false;
  control.before = async ({ route, url }) => {
    if (url.pathname.endsWith('/check-update') && checkGate) { const hold = checkGate; checkGate = null; checkBegan.resolve(); await hold.promise; }
    if (url.pathname.endsWith('/update/preview')) {
      if (gate) { const hold = gate; gate = null; began.resolve(); await hold.promise; }
      if (previewError) { await route.fulfill({ status: 503, json: { ok: false, code: 'unavailable', error: 'The repository is temporarily unavailable.' } }); return true; }
    }
    if (url.pathname.endsWith('/skills/update')) {
      if (saveGate) { const hold = saveGate; saveGate = null; saveBegan.resolve(); await hold.promise; }
      if (conflict) { await route.fulfill({ status: 409, json: { ok: false, error: 'The installed files changed. Review them again.' } }); return true; }
    }
  };
  control.after = async ({ route, url, response }) => {
    if (response && url.pathname.endsWith('/update/preview')) {
      if (expiry) response.body.expiresAt = Date.now() + 100;
      if (noLocal) response.body.localChanges = false;
      if (long) { response.body.target.directory += '/a-very-long-folder'.repeat(40); response.body.changes[0].name = 'references/' + 'a-long-directory/'.repeat(6) + 'notes.md'; }
      if (manyFiles) {
        for (let index = 0; index < 6; index++) response.body.changes.push({ name: 'references/guide-' + index + '.md', status: 'unchanged', before: { bytes: 2000 }, after: { bytes: 2000 }, text: null, textOmitted: 'unchanged' });
        response.body.summary.unchanged += 6;
      }
      if (omitted) { response.body.changes[0].text = null; response.body.changes[0].textOmitted = 'binary'; }
      if (huge) response.body.changes[0].text = { before: 'old\n'.repeat(5001), after: 'new\n'.repeat(5001) };
    }
    if (response && url.pathname.endsWith('/skills/update') && lost) { lost = false; await route.abort('connectionreset'); return true; }
  };
  const dialog = target.locator('.tc-ur');
  const close = async () => { await dialog.locator('[data-update-close], [data-update-show]').first().click(); await dialog.waitFor({ state: 'hidden' }); };
  const updates = () => visible(target, '[data-cmd="skills.show"][data-id=updates]').click();
  const open = async () => {
    await visible(target, '[data-cmd="skills.show"][data-id=all]').click();
    await target.locator('#skill-search').fill('frontend-design');
    await visible(target, '.tc-sk-matrix .tc-skill-name, .tc-sk-phone-row').click();
    await target.locator('[data-inspect-review-source]').first().click();
  };
  const ready = () => dialog.locator('[data-update-save]').waitFor();
  const reset = () => { for (const inventory of Object.values(api.inventories)) for (const row of inventory.skills) if (row.name === 'frontend-design') row.update = { status: 'available', checkedAt: Date.now() }; };
  // First check lives in the Updates view. Nothing has been fetched upstream.
  assert.equal(requests.filter(row => row.path.endsWith('/check-update')).length, 0);
  await updates(); await target.getByText('Check 4 skills for updates', { exact: true }).waitFor(); await shot('first-check');
  await target.locator('.tc-ut-empty [data-cmd="skills.check-updates"]').click();
  await target.locator('.tc-ut-row').first().waitFor();
  await target.waitForFunction(() => !document.querySelector('.tc-lh-status')?.textContent.includes('Checking'));
  assert.equal(requests.filter(row => row.path.endsWith('/check-update')).length, 4);
  const names = await target.locator('.tc-ut-skill .tc-skill-name').allTextContents();
  assert.deepEqual(names, ['deep-research', 'frontend-design', 'google-workspace', 'docx']);
  assert.equal(await target.locator('.tc-ut-err').count(), 1); await shot('updates');
  await target.locator('[data-cmd="skills.review-updates"]').click(); await ready();
  await dialog.getByRole('heading', { name: 'Update deep-research', exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Skip to frontend-design', exact: true }).click(); await ready();
  assert.match(await dialog.innerText(), /2 of 2 updates/); await close();
  // A source check belongs to its one installation and stays visibly pending.
  await visible(target, '.tc-lh-filters [data-cmd="skills.show"][data-id=all], .tc-sk-agent-chips [data-cmd="skills.show"][data-id=all]').click();
  await target.locator('#skill-search').fill('frontend-design');
  await visible(target, '.tc-sk-matrix .tc-skill-name, .tc-sk-phone-row').click();
  const checking = deferred(); checkGate = checking; checkBegan = deferred();
  const checkButton = target.locator('[data-inspect-check-source]');
  await checkButton.click(); await checkBegan.promise;
  assert(await checkButton.isDisabled()); assert.match(await checkButton.innerText(), /Checking/);
  const reads = requests.filter(row => row.method === 'GET').length;
  await target.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(await target.locator('#skill-search').inputValue(), 'frontend-design');
  assert.equal(requests.filter(row => row.method === 'GET').length, reads);
  checking.resolve();  await target.waitForFunction(() => document.querySelector('[data-inspect-check-source]')?.textContent.trim() === 'Check again');
  assert.equal(requests.filter(row => row.path.endsWith('/check-update')).at(-1).input.skills.length, 1);
  await target.getByRole('button', { name: 'Close skill inspector', exact: true }).click();
  // Closing a slow preview discards its eventual snapshot, without reopening it.
  const slow = deferred(); gate = slow; began = deferred(); await open(); await began.promise;
  await dialog.getByText('Comparing its files with this installation…').waitFor();
  await close(); slow.resolve();
  await page.waitForResponse(response => response.url().endsWith('/skills/discard'));
  assert.equal(await dialog.count(), 0);
  await open(); await ready();
  assert(await dialog.locator('[data-update-save]').isDisabled());
  assert(await fits(dialog), 'review fits the viewport');
  assert(await fits(dialog.locator('[data-update-save]')), 'update stays in a pinned, visible footer');
  assert(await fits(dialog.locator('[data-update-consent]')), 'local-edit consent remains visible');
  assert.equal(await target.locator('.tc-layer [role=dialog]').count(), 1, 'one review layer replaces the inspector');
  assert.match(await dialog.innerText(), /1\s+changed/); assert.match(await dialog.innerText(), /Save current SKILL.md/);
  assert.match(await dialog.innerText(), /\+6/); assert.match(await dialog.innerText(), /−3/);
  assert.equal(await target.evaluate(() => window.skillInjected), undefined);
  await shot('review');
  if (width < 640) {
    assert((await dialog.locator('h2').boundingBox()).y < 100, 'the title shares the first grid row with Close');
    assert(await fits(dialog.locator('.tc-pur-fact').first()), 'the Changes fact is visible when review opens');
    await dialog.locator('[data-update-consent]').check(); await shot('review-consented'); await dialog.locator('[data-update-consent]').uncheck();
  }
  if (width >= 640) {
    const files = dialog.getByRole('listbox');
    await files.getByRole('option').first().focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await files.getByRole('option').nth(1).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Home');
    assert.equal(await files.getByRole('option').first().getAttribute('aria-selected'), 'true');
    await dialog.locator('[data-update-fold]').first().click();
    assert.equal(await dialog.locator('[data-update-fold]').first().getAttribute('aria-expanded'), 'true');
  } else {
    if (width === 390) assert(await dialog.locator('[data-update-file]').last().evaluate(button => button.getBoundingClientRect().bottom <= button.closest('.tc-ur').querySelector('.tc-pur-foot').getBoundingClientRect().top), 'all file headers fit above the pinned footer at 390 × 844');
    const pane = dialog.locator('.tc-pur-diff:visible');
    await pane.focus(); await page.keyboard.press('ArrowDown');
    await target.waitForFunction(() => [...document.querySelectorAll('.tc-pur-diff')].some(node => !node.hidden && node.scrollTop > 0));
    assert.equal(await dialog.locator('[data-update-file][aria-expanded=true]').count(), 1);
    await dialog.locator('[data-update-file]').nth(1).click();
    assert.equal(await dialog.locator('[data-update-file][aria-expanded=true]').count(), 1);
    await dialog.locator('[data-update-file]').first().click();
    assert((await dialog.locator('[data-update-save]').boundingBox()).height >= 44);
  }
  const versions = dialog.getByRole('button', { name: 'Incoming file', exact: true });
  await versions.click(); await dialog.getByRole('button', { name: 'Installed file', exact: true }).click();
  await dialog.getByRole('button', { name: 'Changes', exact: true }).click();
  await shot('file-versions');
  const download = page.waitForEvent('download'); await dialog.locator('[data-update-download]').click();
  assert.equal((await download).suggestedFilename(), 'SKILL.md');
  assert.match(await dialog.locator('[data-update-download]').innerText(), /Saved/);
  await dialog.locator('[data-update-consent]').check();
  assert(await dialog.locator('[data-update-save]').isEnabled());
  const writing = deferred(); saveGate = writing; saveBegan = deferred();
  await dialog.locator('[data-update-save]').click(); await saveBegan.promise;
  await dialog.getByRole('heading', { name: 'Updating frontend-design…', exact: true }).waitFor();
  await page.keyboard.press('Escape'); assert(await dialog.isVisible());
  assert.equal(await dialog.locator('button:not([disabled])').count(), 0);
  assert(await target.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); dispatchEvent(event); return event.defaultPrevented; }));
  await shot('saving'); writing.resolve();
  await dialog.getByRole('heading', { name: 'frontend-design is updated', exact: true }).waitFor(); await shot('success');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await open(); await dialog.getByRole('heading', { name: 'frontend-design is up to date', exact: true }).waitFor();
  assert.equal(await dialog.locator('[data-update-save]').count(), 0); await shot('current'); await close();
  reset(); previewError = true; await open();
  await dialog.getByRole('heading', { name: 'Couldn’t download vercel-labs/skills', exact: true }).waitFor(); await shot('prepare-error');
  previewError = false; await dialog.getByRole('button', { name: 'Try again', exact: true }).click(); await ready(); await close();
  expiry = true; await open(); await dialog.getByRole('heading', { name: 'This review is out of date', exact: true }).waitFor();
  assert.equal(await dialog.locator('[data-update-save]').count(), 0); await shot('expired');
  expiry = false; await dialog.getByRole('button', { name: 'Review again', exact: true }).click(); await ready();
  assert.equal(await dialog.locator('[data-update-consent]').isChecked(), false);
  conflict = true; await dialog.locator('[data-update-consent]').check(); await dialog.locator('[data-update-save]').click();
  await dialog.getByRole('heading', { name: 'This review is out of date', exact: true }).waitFor(); conflict = false; await close();
  // A dropped reply must reuse both immutable IDs, without fetching a new preview.
  reset(); await open(); await ready(); lost = true;
  await dialog.locator('[data-update-consent]').check();
  const previews = requests.filter(row => row.path.endsWith('/update/preview')).length;
  await dialog.locator('[data-update-save]').click();
  await dialog.getByRole('heading', { name: 'We couldn’t confirm the update', exact: true }).waitFor(); await shot('uncertain');
  await dialog.getByRole('button', { name: 'Check result', exact: true }).click();
  await dialog.getByRole('heading', { name: 'frontend-design is updated', exact: true }).waitFor();
  const attempts = requests.filter(row => row.path.endsWith('/skills/update')).slice(-2);
  assert.deepEqual(attempts[0].input, attempts[1].input);
  assert.equal(requests.filter(row => row.path.endsWith('/update/preview')).length, previews);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  reset(); await open(); await ready(); lost = true;
  await dialog.locator('[data-update-consent]').check(); await dialog.locator('[data-update-save]').click();
  await dialog.getByRole('button', { name: 'Check result', exact: true }).waitFor();
  conflict = true; await dialog.getByRole('button', { name: 'Check result', exact: true }).click();
  await dialog.getByRole('heading', { name: 'The update result is no longer available', exact: true }).waitFor();
  assert.doesNotMatch(await dialog.innerText(), /Nothing was replaced/);
  conflict = false; await close();
  reset(); noLocal = true; await open(); await ready();
  assert.equal(await dialog.locator('[data-update-consent]').count(), 0);
  assert(await dialog.locator('[data-update-save]').isEnabled()); await shot('no-local-edits'); await close(); noLocal = false;
  omitted = true; await open(); await ready(); await dialog.getByText('No preview for binary files.', { exact: true }).waitFor(); await close(); omitted = false;
  if (width >= 640) {
    manyFiles = true; await open(); await ready();
    await dialog.locator('[data-update-more]').click();
    assert.equal(await dialog.locator('.tc-ur-file[data-dim]').count(), 7); await close(); manyFiles = false;
  }
  huge = true; await open(); await ready();
  await dialog.getByText('Too long to compare line by line.', { exact: true }).waitFor();
  assert(await dialog.getByRole('button', { name: 'Changes', exact: true }).isDisabled());
  await dialog.getByRole('button', { name: 'Installed file', exact: true }).click();
  assert.match(await dialog.getByLabel('Selected file contents').innerText(), /old/); await close(); huge = false;
  reset(); long = noLocal = true; await open(); await ready();
  assert(await fits(dialog), 'long filenames and folders stay within review');
  const longSave = deferred(); saveGate = longSave; saveBegan = deferred();
  await dialog.locator('[data-update-save]').click(); await saveBegan.promise;
  assert(await fits(dialog), 'long folders wrap in the compact saving state');
  await shot('long-path-saving'); longSave.resolve();
  await dialog.getByRole('heading', { name: 'frontend-design is updated', exact: true }).waitFor();
  assert(await fits(dialog), 'long changed filenames wrap in the result');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click(); long = noLocal = false;
  // A completed queue item advances in the same layer and refreshes the row.
  reset(); await target.locator('#skill-search').fill(''); await target.locator('[data-cmd="skills.refresh"]').click();
  await target.waitForFunction(() => !document.querySelector('.tc-sk-scan-time')?.textContent.includes('Scanning'));
  await visible(target, '.tc-lh-filters [data-cmd="skills.show"][data-id=updates], .tc-sk-agent-chips [data-cmd="skills.show"][data-id=updates]').click();
  await target.locator('[data-cmd="skills.review-updates"]').click(); await ready();
  await dialog.getByRole('heading', { name: 'Update deep-research', exact: true }).waitFor();
  await dialog.locator('[data-update-save]').click();
  await dialog.getByRole('button', { name: 'Review frontend-design', exact: true }).click(); await ready();
  assert.match(await dialog.innerText(), /2 of 2 updates/); await close();
}).catch(error => { console.error(error); process.exit(1); });
