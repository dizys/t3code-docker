import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const helper = new URL('../scripts/lib/parallel-checks.sh', import.meta.url).pathname;
async function run(t, body) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 't3-parallel-test-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const result = spawnSync('bash', ['-c', `set -euo pipefail\nsource "$HELPER"\ntrap t3_parallel_cleanup EXIT\n${body}`], {
    cwd, env: { ...process.env, HELPER: helper, TMPDIR: cwd }, encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal((await fs.readdir(cwd)).some(file => file.startsWith('t3-audit-pair.')), false, 'temporary logs are cleaned');
  return { ...result, log: await fs.readFile(path.join(cwd, 'audit.log'), 'utf8').catch(() => '') };
}

test('both checks actually overlap, and their output is collected intact in order', async t => {
  const result = await run(t, `
mkfifo gate
first() { printf 'ready\\n' > gate; echo first-out; echo first-err >&2; }
second() { read -r message < gate; test "$message" = ready; echo second-out; }
t3_parallel_pair audit.log first second
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.log, 'first-out\nfirst-err\nsecond-out\n');
});

test('failure of either check fails the pair and still retains the other result', async t => {
  for (const fail of ['first', 'second']) {
    const result = await run(t, `
first() { echo first-ran; ${fail === 'first' ? 'return 1' : 'return 0'}; }
second() { echo second-ran; ${fail === 'second' ? 'return 1' : 'return 0'}; }
t3_parallel_pair audit.log first second
`);
    assert.notEqual(result.status, 0, fail);
    assert.equal(result.log, 'first-ran\nsecond-ran\n');
  }
});

test('a missing check cannot silently count as a passing audit', async t => {
  const result = await run(t, `
second() { echo second-ran; }
t3_parallel_pair audit.log command-that-does-not-exist second
`);
  assert.notEqual(result.status, 0);
  assert.match(result.log, /command-that-does-not-exist/);
  assert.match(result.log, /second-ran/);
});
