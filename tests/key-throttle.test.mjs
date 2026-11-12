import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyThrottle } from '../docker/setup/key-throttle.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('admission happens before every comparison, including a correct guess at capacity', async () => {
  const gate = deferred(), compared = [], waits = [];
  const throttle = createKeyThrottle({ matches: key => { compared.push(key); return key === 'good'; }, wait: async ms => { waits.push(ms); await gate.promise; } });
  const guesses = Array.from({ length: 4 }, (_, index) => throttle.check('one', `bad-${index}`));
  await assert.rejects(throttle.check('one', 'good'), { code: 'login-limit' });
  await assert.rejects(throttle.check('one', 'fifth'), { code: 'login-limit' });
  assert.deepEqual(compared, ['bad-0', 'bad-1', 'bad-2', 'bad-3']);
  assert.equal(await throttle.check('two', 'good'), true, 'other addresses are independent');
  gate.resolve(); assert.deepEqual(await Promise.all(guesses), [false, false, false, false]);
  assert.deepEqual(waits, [250, 500, 750, 1000]);
  assert.equal(await throttle.check('one', 'good'), true);
  assert.equal(await throttle.check('one', 'bad-again'), false);
  assert.equal(waits.at(-1), 250, 'a successful key clears the failure history');
});

test('rotating addresses cannot grow the pending queues or failure history without bound', async () => {
  const gate = deferred(); let comparisons = 0;
  const throttle = createKeyThrottle({ matches: () => { comparisons++; return false; }, wait: () => gate.promise, pendingLimit: 2 });
  const first = throttle.check('a', 'bad'), second = throttle.check('b', 'bad');
  await assert.rejects(throttle.check('c', 'bad'), { code: 'login-limit' });
  assert.equal(comparisons, 2); gate.resolve(); await Promise.all([first, second]);
  assert.equal(await throttle.check('c', 'bad'), false, 'drained slots are reusable');
  const delays = [];
  const bounded = createKeyThrottle({ matches: () => false, wait: async ms => { delays.push(ms); }, failureLimit: 2 });
  for (const ip of ['a', 'b', 'c', 'a']) await bounded.check(ip, 'bad');
  assert.deepEqual(delays, [250, 250, 250, 250], 'the oldest failure record is evicted');
});

test('failed delay implementations release slots and do not poison a queue', async () => {
  let broken = true;
  const throttle = createKeyThrottle({ matches: key => key === 'good', perAddress: 1, wait: async () => { if (broken) throw new Error('fixture'); } });
  await assert.rejects(throttle.check('one', 'bad'), /fixture/);
  broken = false;
  assert.equal(await throttle.check('one', 'bad'), false);
  assert.equal(await throttle.check('one', 'good'), true);
});
