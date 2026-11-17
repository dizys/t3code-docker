import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarnessCache } from '../docker/setup/cache.mjs';

const localFacts = { harnesses: [{ id: 'codex', installed: true }], degraded: [] };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a cold refresh failure appears once when local inventory finishes later', async () => {
  let releaseLocal;
  const local = new Promise(resolve => { releaseLocal = resolve; });
  const cache = createHarnessCache({
    full: async () => { throw new Error('authentication unavailable'); },
    cheap: async () => { await local; return localFacts; },
  });
  const pending = cache.snapshot();
  await tick();
  releaseLocal();
  const result = await pending;
  assert.equal(result.source, 'cheap');
  assert.deepEqual(result.harnesses, localFacts.harnesses);
  assert.deepEqual(result.degraded, [{ what: 'harness refresh', error: 'authentication unavailable' }]);
});

test('a cold refresh failure remains visible when local inventory finishes first', async () => {
  let releaseAuth;
  const authentication = new Promise(resolve => { releaseAuth = resolve; });
  const cache = createHarnessCache({
    full: async () => { await authentication; throw new Error('authentication unavailable'); },
    cheap: async () => localFacts,
  });
  const pending = cache.snapshot();
  await tick();
  releaseAuth();
  const result = await pending;
  assert.equal(result.source, 'cheap');
  assert.deepEqual(result.harnesses, localFacts.harnesses);
  assert.deepEqual(result.degraded, [{ what: 'harness refresh', error: 'authentication unavailable' }]);
});
