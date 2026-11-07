import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const { runCases } = createRequire(import.meta.url)('../scripts/lib/browser-audit-cases.cjs');
const quiet = { log: () => {} };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('two workers execute every selected scenario exactly once without exceeding the bound', async () => {
  const firstPair = deferred(), cases = Array.from({ length: 23 }, (_, i) => i), seen = [];
  let active = 0, maximum = 0;
  const results = await runCases(cases, async value => {
    active++; maximum = Math.max(maximum, active); seen.push(value);
    if (seen.length === 2) firstPair.resolve();
    if (value < 2) await firstPair.promise;
    await Promise.resolve(); active--;
  }, { ...quiet, workers: 2 });
  assert.equal(maximum, 2);
  assert.deepEqual(seen.sort((a, b) => a - b), cases);
  assert.equal(results.length, cases.length);
  assert.ok(results.every(result => result.ok));
});

test('one worker preserves scenario order', async () => {
  const seen = [];
  await runCases(['light', 'dark', 'embedded'], async value => { seen.push(value); }, { ...quiet, workers: 1 });
  assert.deepEqual(seen, ['light', 'dark', 'embedded']);
});

test('a failed assertion drains the queue, closes owned contexts and reports the failing scenario', async () => {
  const visited = [], closed = [], browser = { newContext: async options => ({ pages: () => [], close: async () => { closed.push(options.id); } }) };
  await assert.rejects(runCases([0, 1, 2, 3, 4], async (value, scope) => {
    await scope.context(browser, { id: value });
    visited.push(value);
    if (value === 1 || value === 3) throw new Error('Synthetic assertion ' + value);
  }, { ...quiet, workers: 2 }), error => {
    assert.equal(error.errors.length, 2);
    assert.match(error.message, /2\/5 scenarios failed; all scenarios finished/);
    return true;
  });
  assert.deepEqual(visited.sort(), [0, 1, 2, 3, 4]);
  assert.deepEqual(closed.sort(), [0, 1, 2, 3, 4]);
});

test('contexts and fixture servers close in reverse order before the worker takes another case', async () => {
  const events = [], browser = { newContext: async () => ({ newPage: async () => ({}), close: async () => events.push('context closed') }) };
  await runCases([1, 2], async (value, scope) => {
    events.push('start ' + value);
    scope.cleanup(async () => events.push('fixture closed'));
    await scope.page(browser, {});
  }, { ...quiet, workers: 1 });
  assert.deepEqual(events, ['start 1', 'context closed', 'fixture closed', 'start 2', 'context closed', 'fixture closed']);
});

test('cleanup errors fail the audit but do not strand other cleanup or later scenarios', async () => {
  const seen = [];
  await assert.rejects(runCases([1, 2], async (value, scope) => {
    scope.cleanup(() => { seen.push(value); });
    scope.cleanup(() => { throw new Error('Synthetic close error'); });
  }, { ...quiet, workers: 1 }), /2\/2 scenarios failed/);
  assert.deepEqual(seen, [1, 2]);
});

test('empty selections and invalid worker limits cannot produce a green audit', async () => {
  for (const workers of [0, 3, -1, 1.5, '', 'two', '2junk']) {
    await assert.rejects(runCases([1], async () => {}, { ...quiet, workers }), /must be 1 or 2/);
  }
  await assert.rejects(runCases([], async () => {}, { ...quiet, workers: 2 }), /no scenarios selected/);
});

test('unwritable diagnostics cannot strand cleanup or the remaining cases', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 't3-audit-diagnostics-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'file');
  await fs.writeFile(output, 'This is not a directory.');
  const visited = [], closed = [];
  const browser = { newContext: async options => ({ pages: () => [], close: async () => closed.push(options.id) }) };
  await assert.rejects(runCases([1, 2], async (value, scope) => {
    await scope.context(browser, { id: value });
    visited.push(value);
    throw new Error('Original assertion');
  }, { ...quiet, workers: 2, output }), /2\/2 scenarios failed/);
  assert.deepEqual(visited.sort(), [1, 2]);
  assert.deepEqual(closed.sort(), [1, 2]);
});
