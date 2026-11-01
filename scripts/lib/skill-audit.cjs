// Shared fixture boundary for the update/hook browser audits. Every request is
// served from memory; a failed assertion cannot mutate an installed agent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { statusFor, framed } = require('./console-fixtures.cjs');
const { createSkillsFixtures } = require('./skills-fixtures.cjs');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const visible = (target, selector) => target.locator(selector).filter({ visible: true });
const run = async (name, work) => {
  let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
  const base = process.argv[2] || 'http://127.0.0.1:23785/__setup/', key = process.argv[3] || 'dev';
  const prefix = name === 'updates' ? 'T3_SKILL_UPDATE_UI' : 'T3_HOOKS_UI';
  const output = process.env[prefix + '_OUTPUT'] || '/tmp/t3-skills-' + name + '-ui'; fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const theme of ['light', 'dark']) for (const [width, height, embedded] of [[1440, 900], [1024, 900], [390, 844], [360, 640], [1198, 878, true]]) {
      if (process.env[prefix + '_THEMES'] && !process.env[prefix + '_THEMES'].split(',').includes(theme)) continue;
      if (process.env[prefix + '_WIDTHS'] && !process.env[prefix + '_WIDTHS'].split(',').includes(String(width))) continue;
      console.log('Starting', name, theme, width, embedded ? 'embedded' : 'standalone');
      const page = await browser.newPage({ viewport: { width, height: name === 'hooks' && width === 1440 ? 1100 : height }, colorScheme: theme, reducedMotion: 'reduce', deviceScaleFactor: 2 });
      page.setDefaultTimeout(8000);
      await page.addInitScript(mode => { localStorage.setItem('t3-console-theme', mode); }, theme);
      const api = createSkillsFixtures(), errors = [], requests = [], control = {};
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method(), input = method === 'POST' ? request.postDataJSON() : {};
        if (url.pathname.includes('/context/skills')) requests.push({ path: url.pathname, method, input });
        if (await control.before?.({ route, url, method, input })) return;
        const response = api.respond(method, url, input) || (url.pathname.endsWith('/status') ? { body: statusFor('skills') } : null);
        if (await control.after?.({ route, url, method, input, response })) return;
        if (response) return route.fulfill({ status: response.status || 200, json: response.body });
        return route.continue();
      });
      const target = embedded ? await framed(page, base + '?embed=t3&theme=' + theme) : page;
      if (!embedded) await page.goto(base);
      if (await target.locator('input[type=password]').count()) { await target.locator('input[type=password]').fill(key); await target.locator('button[type=submit]').click(); }
      await target.waitForSelector('#app');
      await target.evaluate(() => document.fonts.ready);
      const shot = async state => { await page.screenshot({ path: path.join(output, `${theme}-${width}${embedded ? '-embedded' : ''}-${state}.png`) }); };
      await target.evaluate(() => { location.hash = 'instructions/skills'; });
      // Cards are the default view; accept whichever rendering the combo uses.
      await target.waitForFunction(() => document.querySelectorAll('.tc-mx-row, .tc-skill-card').length >= 20);
      await work({ page, target, api, errors, requests, control, theme, width, height, embedded, shot });
      assert.deepEqual(errors, []);
      assert(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'the page does not overflow horizontally');
      console.log('Passed', name, theme, width, embedded ? 'embedded' : 'standalone');
      await page.close();
    }
  } finally { await browser.close(); }
};
const fits = async locator => locator.evaluate(element => { const box = element.getBoundingClientRect(); return box.top >= -1 && box.bottom <= innerHeight + 1 && box.left >= -1 && box.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1; });
module.exports = { run, visible, deferred, fits, assert };
