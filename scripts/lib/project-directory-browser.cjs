// Optional browser companion to t3-projects-smoke.mjs. The caller owns a
// disposable server and home; no production endpoint or credential is accepted.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }

exports.auditNativeProjectDirectory = async ({ binary, base, env, workspace, version, execute, output }) => {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 }, colorScheme: theme, reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        const issued = await execute(binary, ['auth', 'pairing', 'create', '--base-url', base, '--label', 'Project UI audit', '--ttl', '5m', '--json'], { env, timeout: 60_000 });
        const pairing = JSON.parse(issued.stdout.slice(issued.stdout.indexOf('{')));
        await page.goto(base + '/pair#token=' + encodeURIComponent(pairing.credential));
        await page.waitForURL(url => !url.pathname.startsWith('/pair'), { timeout: 30_000 });
        await page.waitForFunction(() => document.querySelector('[data-draft-project-trigger], [data-sidebar="sidebar"]'));
        await page.keyboard.press('Control+k');
        const palette = page.locator('[data-command-palette="true"]');
        const search = palette.locator('input[role="combobox"]');
        await search.fill('New project');
        await palette.getByRole('option').filter({ hasText: 'New project' }).first().click();
        const name = page.getByPlaceholder('Project name', { exact: true });
        await name.waitFor();
        await page.getByText('Goes in ' + workspace, { exact: true }).waitFor();
        await page.screenshot({ path: path.join(output, `${version}-${width}-${theme}-new-project.png`) });
        await palette.screenshot({ path: path.join(output, `${version}-${width}-${theme}-project-palette.png`) });
        const project = `Browser ${width} ${theme}`, folder = `browser-${width}-${theme}`;
        await name.fill(project);
        await page.getByText('Creates ' + path.join(workspace, folder), { exact: true }).waitFor();
        await palette.getByRole('button', { name: /^Create\b/ }).click();
        await name.waitFor({ state: 'hidden' });
        assert.equal((await fs.stat(path.join(workspace, folder, '.git'))).isDirectory(), true);
        assert.match(await fs.readFile(path.join(workspace, folder, 'README.md'), 'utf8'), new RegExp(project));
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify({ nativeBrowser: version, newProjectsInWorkspace: 4, themes: ['light', 'dark'], widths: [1280, 390] }));
};
