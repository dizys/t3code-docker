import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkScope, documentationOnly } from '../scripts/lib/ci-scope.mjs';

async function repository(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 't3-ci-scope-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  const put = async (file, content = 'Fixture\n') => { await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true }); await fs.writeFile(path.join(cwd, file), content); };
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'Fixture'); return git('rev-parse', 'HEAD'); };
  await put('README.md'); await put('Dockerfile'); await put('docs/start.md');
  const base = commit();
  return { cwd, git, put, commit, base };
}
const push = (before, after) => ({ ref: 'refs/heads/main', before, after });
const pr = (base, head) => ({ pull_request: { base: { sha: base }, head: { sha: head } } });

test('only known documentation paths can avoid the image matrix', () => {
  assert.equal(documentationOnly(['README.md', 'docs/media/setup-dark.png', 'CONTRIBUTING.md', 'LICENSE', 'scripts/readme-media.js']), true);
  for (const file of ['Dockerfile', '.dockerignore', 'compose.yaml', 'docker/setup/page.mjs', 'docker/setup/credentials/SKILL.md', '.github/workflows/build.yml', 'tests/ci-scope.test.mjs', 'scripts/build-t3-runtime.mjs', 'new-file', 'docs/../Dockerfile']) {
    assert.equal(documentationOnly(['README.md', file]), false, file);
  }
  assert.equal(documentationOnly([]), false);
  assert.equal(documentationOnly([...Array.from({ length: 1000 }, (_, i) => `docs/${i}.md`), 'Dockerfile']), false);
});

test('a docs push skips image checks, but any code commit in the push keeps them', async t => {
  const r = await repository(t);
  await r.put('README.md', 'New guide\n');
  const docs = r.commit();
  assert.equal(checkScope('push', push(r.base, docs), { cwd: r.cwd }).full, false);
  await r.put('Dockerfile', 'New image\n'); r.commit();
  await r.put('docs/start.md', 'More docs\n');
  const last = r.commit();
  assert.equal(checkScope('push', push(docs, last), { cwd: r.cwd }).full, true);
});

test('PR changes use the merge base when main has advanced', async t => {
  const r = await repository(t);
  r.git('checkout', '-qb', 'docs');
  await r.put('docs/start.md', 'New guide\n');
  const head = r.commit();
  r.git('checkout', '--detach', r.base);
  await r.put('Dockerfile', 'New main\n');
  const main = r.commit();
  assert.equal(checkScope('pull_request', pr(main, head), { cwd: r.cwd }).full, false);
});

test('renames out of docs cannot masquerade as a docs-only change', async t => {
  const r = await repository(t);
  r.git('mv', 'docs/start.md', 'entrypoint.sh');
  const head = r.commit();
  assert.equal(checkScope('pull_request', pr(r.base, head), { cwd: r.cwd }).full, true);
});

test('null-delimited git output handles unusual guide filenames without hiding code', async t => {
  const r = await repository(t);
  await r.put('docs/a\nb.md');
  const docs = r.commit();
  assert.equal(checkScope('push', push(r.base, docs), { cwd: r.cwd }).full, false);
  await r.put('runtime\nfile.mjs');
  const code = r.commit();
  assert.equal(checkScope('push', push(r.base, code), { cwd: r.cwd }).full, true);
});

test('releases, schedules, manual runs and unknown events always run everything', () => {
  const event = push('a'.repeat(40), 'b'.repeat(40));
  const git = () => { throw new Error('These events must not inspect paths'); };
  for (const name of ['schedule', 'workflow_dispatch', 'unknown']) assert.equal(checkScope(name, event, { git }).full, true);
  assert.equal(checkScope('push', { ...event, ref: 'refs/tags/v1.0.0' }, { git }).full, true);
});

test('missing history, new branches, invalid events and empty diffs fail toward full checks', async t => {
  const r = await repository(t);
  for (const event of [push(r.base, r.base), push('0'.repeat(40), r.base), push('f'.repeat(40), r.base), push('bad ref', r.base), {}]) {
    assert.equal(checkScope('push', event, { cwd: r.cwd }).full, true);
  }
  assert.equal(checkScope('pull_request', {}, { cwd: r.cwd }).full, true);
  assert.equal(checkScope('push', push(r.base, r.base), { git: () => { throw new Error('diff too large'); } }).full, true);
});

test('the CLI defaults to full verification when its event cannot be read', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 't3-ci-output-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const output = path.join(cwd, 'output');
  execFileSync(process.execPath, [new URL('../scripts/ci-scope.mjs', import.meta.url).pathname], { env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: path.join(cwd, 'missing'), GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '' } });
  assert.equal(await fs.readFile(output, 'utf8'), 'full=true\n');
});
