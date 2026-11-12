// Exercise the real wizard against the plugin service's bounded reviews,
// revision checks and idempotent jobs. All sources and writes are fixtures.
const assert = require('node:assert/strict');
const path = require('node:path');
const {statusFor} = require('./console-fixtures.cjs');
const {createSkillsFixtures} = require('./skills-fixtures.cjs');

function fixture() {
  const source = 'https://github.com/example/reviewed-plugins';
  const packages = ['alpha', 'beta'].map((name, i) => ({
    prefix: name + '/', name: 'fixture-' + name, description: 'A complete, independently reviewed package.',
    digest: String(i + 1).repeat(64), version: '1.0.0',
    components: [{type: 'hooks', name: 'SessionStart'}],
    hooks: [{event: 'SessionStart', command: '<script>window.pluginInjected=true</script>'}],
    files: [{name: 'README.md', bytes: 20, text: 'Follow this package’s own instructions.'}],
    providers: ['codex', 'claude', 'pi', 'opencode'].map(id => ({id, compatible: true, detected: true, reason: 'Fixture native integration'})),
  }));
  const reviews = new Map(), jobs = new Map(), mutations = new Map(), posts = [], jobReads = [], rows = [];
  let serial = 0, revision = 0, sourceOpen = false, maxReviews = 0;
  const state = {packages, posts, jobs, mutations, jobReads, rows, hold: false, loseApply: null, loseJob: null, change: null, fail: null, expired: false, rejectApply: null};
  const failure = (error, status = 409) => ({status, body: {ok: false, error}});
  state.respond = (method, url, input = {}) => {
    const suffix = url.pathname.replace(/^.*\/context\/plugins/, '');
    if (method === 'POST') posts.push({suffix, input});
    if (!suffix) return {body: {ok: true, plugins: rows, providers: [], warnings: []}};
    if (suffix === '/source') {sourceOpen = true; return {body: {ok: true, previewId: 'source', source, packages}};}
    if (suffix === '/discard') {
      if (input.planId === 'source') sourceOpen = false;
      else if (!reviews.get(input.planId)?.jobId) reviews.delete(input.planId);
      return {body: {ok: true}};
    }
    if (suffix === '/plan') {
      if (!sourceOpen || state.expired) return failure('The source preview expired. Read it again.');
      const live = [...reviews.values()].filter(p => !p.jobId || jobs.get(p.jobId)?.state === 'running').length + 1;
      if (live >= 6) return failure('Close another review before opening more.');
      const pkg = packages.find(p => p.prefix === input.prefix);
      if (!pkg) return failure('Choose a plugin from this source.');
      const key = pkg.prefix + input.provider;
      const plan = {ok: true, planId: 'plan-' + ++serial, expiresAt: Date.now() + 600000, operation: 'install',
        source, provider: input.provider, name: pkg.name, description: pkg.description, version: pkg.version, digest: pkg.digest,
        components: pkg.components, hooks: state.change === key ? [{event: 'SessionStart', command: 'changed without changing the digest'}] : pkg.hooks,
        files: pkg.files, effects: ['Register ' + pkg.name + ' for ' + input.provider], blocked: [], canApply: true, activation: input.provider === 'opencode' ? 'provider-reload' : 'new-session'};
      reviews.set(plan.planId, {...plan, key, revision}); maxReviews = Math.max(maxReviews, live + 1);
      return {body: plan};
    }
    if (suffix === '/apply') {
      const plan = reviews.get(input.planId);
      if (!plan) return failure('This review expired. Review the operation again.');
      if (plan.jobId) return {body: {ok: true, jobId: plan.jobId}};
      if (state.rejectApply === plan.key) {reviews.delete(input.planId); return failure('This review expired. Review the operation again.');}
      const failed = state.fail === plan.key || plan.revision !== revision;
      const jobId = 'job-' + ++serial;
      plan.jobId = jobId;
      mutations.set(plan.key, (mutations.get(plan.key) || 0) + 1);
      const result = {ok: true, state: failed ? 'failed' : 'succeeded', error: failed ? 'Native installation needs reconciliation.' : undefined, partial: failed, message: 'Saved.'};
      jobs.set(jobId, {...result, key: plan.key}); revision++;
      if (!failed) rows.push({id: String(serial).padStart(32, '0'), provider: plan.provider, name: plan.name, nativeId: plan.name + '@fixture', owned: true,
        digest: plan.digest, source: plan.source, status: 'installed', enabled: true, components: plan.components});
      if (state.loseApply === plan.key) {state.loseApply = null; return {abort: true};}
      return {body: {ok: true, jobId}};
    }
    if (suffix === '/job') {
      const jobId = url.searchParams.get('id'), job = jobs.get(jobId); jobReads.push(jobId);
      if (!job) return failure('This job is not available after a restart.', 404);
      if (state.loseJob === job.key) {state.loseJob = null; return {abort: true};}
      return {body: state.hold ? {ok: true, state: 'running'} : job};
    }
    return failure('Unexpected fixture request.', 404);
  };
  state.maxReviews = () => maxReviews;
  return state;
}

module.exports = async function auditPluginBatches({browser, base, output}) {
  async function open({theme = 'light', width = 1440, embedded = false} = {}) {
    const page = await browser.newPage({viewport: {width: embedded ? 1120 : width, height: 900}, colorScheme: theme, reducedMotion: 'reduce'});
    const state = fixture(), skills = createSkillsFixtures(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(t => {try {localStorage.setItem('t3-console-theme', t);} catch {}}, theme);
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()), input = req.method() === 'POST' ? req.postDataJSON() : {};
      if (url.pathname.endsWith('/status')) return route.fulfill({json: statusFor('skills')});
      const result = url.pathname.includes('/context/plugins') ? state.respond(req.method(), url, input) : skills.respond(req.method(), url, input);
      if (!result) return route.continue();
      if (result.abort) return route.abort('failed');
      return route.fulfill({status: result.status || 200, json: result.body});
    });
    let root = page;
    const url = base + (embedded ? '?embed=t3&layout=settings' : '') + '#instructions/skills';
    if (embedded) {
      await page.route('**/pr126-batch-parent', route => route.fulfill({contentType: 'text/html', body: '<iframe title="Setup fixture" style="width:704px;height:800px;border:0"></iframe>'}));
      await page.goto(new URL('/pr126-batch-parent', base).href);
      const element = await page.locator('iframe').elementHandle(); root = await element.contentFrame(); await root.goto(url);
    } else await page.goto(url);
    if (await root.locator('input[type=password]').count()) {await root.locator('input[type=password]').fill('dev'); await root.locator('button[type=submit]').click();}
    await root.getByRole('tab', {name: 'Plugins', exact: true}).click();
    await root.locator('#plugin-library .tc-empty').waitFor();
    async function start(agents, count = 1) {
      await root.locator('#plugin-library').getByRole('button', {name: 'Install from source', exact: true}).filter({visible: true}).first().click();
      const dialog = root.getByRole('dialog');
      await dialog.getByLabel('Repository or container folder').fill('https://github.com/example/reviewed-plugins');
      await dialog.getByRole('button', {name: 'Read', exact: true}).click();
      for (const pkg of state.packages.slice(0, count)) await dialog.getByLabel(pkg.name, {exact: true}).check();
      await dialog.getByRole('button', {name: 'Choose agents', exact: true}).click();
      for (const agent of ['codex', 'claude', 'pi', 'opencode']) await dialog.locator('[data-plugin-agent="' + agent + '"]').setChecked(agents.includes(agent));
      await dialog.getByRole('button', {name: /^Review \d+ installation/}).click();
      await dialog.locator('[data-plugin-replan]:enabled').waitFor();
      return dialog;
    }
    async function approve(dialog) {await dialog.locator('[data-plugin-consent]').check(); await dialog.getByRole('button', {name: /^Install \d+ plugin/}).click();}
    async function close() {assert.deepEqual(errors, []); await page.close();}
    return {page, root, state, start, approve, close};
  }

  for (const scenario of [
    {theme: 'light', width: 1440}, {theme: 'dark', width: 1440},
    {theme: 'light', width: 390}, {theme: 'dark', width: 390}, {theme: 'dark', width: 704, embedded: true},
  ]) {
    const test = await open(scenario), {page, state, start, approve, close} = test;
    const dialog = await start(['codex', 'claude', 'pi', 'opencode'], 2);
    assert.equal(await dialog.locator('.tc-insp-section').count(), 8, 'one review includes all eight destinations');
    assert(state.maxReviews() <= 2, 'large batches retain only the source and one live server plan');
    state.rows.push({id: 'unrelated', provider: 'codex', name: 'fixture-alpha', digest: '1'.repeat(64), source: 'https://github.com/example/unrelated', nativeId: 'unrelated@personal', owned: true});
    assert(await dialog.getByRole('button', {name: 'Install 8 plugins', exact: true}).isDisabled());
    const label = scenario.theme + '-' + scenario.width + (scenario.embedded ? '-embedded' : '');
    await page.screenshot({path: path.join(output, label + '-batch-review.png')});
    state.hold = true;
    const firstJob = page.waitForRequest(req => req.url().includes('/context/plugins/job?'));
    await approve(dialog);
    await firstJob;
    await dialog.getByText('Applying the reviewed operations…', {exact: true}).waitFor();
    assert(await dialog.getByRole('button', {name: 'Close plugin installation', exact: true}).isDisabled());
    assert(await dialog.getByRole('button', {name: 'Back', exact: true}).isDisabled());
    assert.equal(state.mutations.size, 1, 'the next destination waits for the current job');
    await dialog.press('Escape');
    assert.equal(await dialog.count(), 1, 'Escape cannot abandon a running batch');
    state.hold = false;
    await dialog.getByRole('heading', {name: 'Installed for Codex, Claude Code, Pi, OpenCode', exact: true}).waitFor();
    await dialog.locator('.tc-wizard-main[aria-busy="false"]').waitFor();
    assert.equal(await dialog.locator('.tc-wizard-main').evaluate(el => el.scrollTop), 0, 'the result opens at its heading');
    assert.equal(state.mutations.size, 8);
    assert([...state.mutations.values()].every(count => count === 1));
    assert.equal(await dialog.locator('[data-plugin-trust-hooks]').count(), 2);
    assert.equal(await dialog.locator('[data-plugin-trust-hooks="fixture-alpha@fixture"]').count(), 1, 'hook review resolves this source, never an unrelated installation with the same digest');
    assert.equal(await dialog.getByText(/tokeneconomizer|\/te status/).count(), 0, 'arbitrary packages receive their own README guidance');
    assert.equal(await test.root.evaluate(() => window.pluginInjected), undefined);
    assert(await dialog.evaluate(el => {const box = el.getBoundingClientRect(); return box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1;}));
    await page.screenshot({path: path.join(output, label + '-batch-result.png')});
    await close(); console.log('Passed plugin batch', label);
  }

  for (const loss of ['loseApply', 'loseJob']) {
    const {page, state, start, approve, close} = await open({width: 390, theme: 'dark'});
    const dialog = await start(['codex', 'pi']); state[loss] = 'alpha/pi';
    await approve(dialog);
    const recover = dialog.getByRole('button', {name: 'Recover installation', exact: true});
    await recover.waitFor(); await dialog.locator('[role=alert]').waitFor();
    assert.equal(state.mutations.size, 2);
    const plansBefore = state.posts.filter(p => p.suffix === '/plan').length;
    await recover.click();
    await dialog.getByRole('heading', {name: 'Installed for Codex, Pi', exact: true}).waitFor();
    assert.equal(state.posts.filter(p => p.suffix === '/plan').length, plansBefore, 'recovery never prepares a replacement operation');
    assert.deepEqual([...state.mutations.values()], [1, 1], 'neither confirmed nor unconfirmed destinations execute twice');
    const applies = state.posts.filter(p => p.suffix === '/apply').map(p => p.input.planId);
    assert.equal(applies.length, loss === 'loseApply' ? 3 : 2);
    if (loss === 'loseApply') assert.equal(applies[1], applies[2], 'lost apply responses reuse the exact plan ID');
    await page.screenshot({path: path.join(output, loss + '-recovered.png')});
    await close(); console.log('Passed plugin batch recovery', loss);
  }

  for (const fault of ['change', 'fail', 'rejectApply']) {
    const {state, start, approve, close} = await open();
    const dialog = await start(['codex', 'pi']); state[fault] = 'alpha/codex';
    await approve(dialog);
    await dialog.getByRole('heading', {name: 'Installation needs attention', exact: true}).waitFor();
    assert.equal(state.mutations.get('alpha/codex') || 0, fault === 'fail' ? 1 : 0, 'changed or expired reviews cannot mutate a destination');
    assert.equal(state.mutations.get('alpha/pi'), 1, 'other reviewed destinations finish after a known failure');
    assert.equal(await dialog.locator('.tc-plan-list li').count(), 2, 'results retain successes and failures');
    assert.equal(await dialog.locator('[data-plugin-trust-hooks]').count(), 0, 'failed Codex installs cannot offer hook trust');
    await close(); console.log('Passed plugin batch failure', fault);
  }

  {
    const {state, start, close} = await open(); state.expired = true;
    const dialog = await start(['codex', 'pi']);
    assert(await dialog.locator('[data-plugin-consent]').isDisabled());
    state.expired = false;
    await dialog.getByRole('button', {name: 'Review installations again', exact: true}).click();
    await dialog.locator('[data-plugin-consent]:enabled').waitFor();
    assert.equal(await dialog.locator('[data-plugin-consent]').isChecked(), false);
    assert.equal(state.mutations.size, 0, 'replanning never applies or retains consent');
    await close(); console.log('Passed plugin batch failed-plan recovery');
  }
};
