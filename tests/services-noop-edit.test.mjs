import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServicesFixtures } from '../scripts/lib/services-fixtures.mjs';

async function fixture(t, domain) {
  const services = await createServicesFixtures();
  t.after(() => services.close());
  const request = async (route, input = {}) => {
    const result = await services.respond('POST', new URL('/__setup/services' + route, 'http://fixture.invalid'), input);
    assert.equal(result.status, undefined, result.body.error);
    return result.body;
  };
  const id = domain === 'system' ? 'tailscale' : 'noop-preview';
  const row = async () => (await request('')).services.find(item => item.domain === domain && item.id === id);
  const apply = async (action, configuration) => {
    const plan = await request('/plan', { domain, id, action, expectedRevision: (await row())?.revision ?? 0, ...(configuration ? { configuration } : {}) });
    const receipt = await request('/apply', { domain, planId: plan.id, expectedRevision: plan.expectedRevision, idempotencyKey: randomUUID(), acknowledgeAccessImpact: true });
    for (let i = 0; i < 200; i++) {
      const operation = await request('/operation', { domain, id: receipt.id });
      if (['succeeded', 'failed', 'rolled-back', 'cancelled'].includes(operation.state)) return operation;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Disposable service operation did not finish');
  };
  const configuration = domain === 'system' ? { hostname: 'noop-fixture', enabled: true }
    : { name: 'Preview', mode: 'executable', executable: '/usr/bin/node', argv: ['--help'], cwd: '/tmp', enabled: true };
  assert.equal((await apply(domain === 'system' ? 'install' : 'add', configuration)).state, 'succeeded');
  return { row, apply, configuration };
}

for (const domain of ['user', 'system']) {
  test(`${domain} service accepts repeated unchanged edits without restarting its process`, async t => {
    const f = await fixture(t, domain);
    const original = await f.row();
    assert.equal(Object.hasOwn(original, domain === 'user' ? 'artifact' : 'receipt'), false);
    assert.ok(original.observation.run.runId);
    for (let i = 1; i <= 2; i++) {
      const operation = await f.apply('edit', f.configuration);
      assert.equal(operation.state, 'succeeded', operation.error);
      const current = await f.row();
      assert.equal(current.revision, original.revision + i);
      assert.equal(current.lastOperationId, operation.id);
      assert.deepEqual(current.config, original.config);
      assert.deepEqual(current.receipt, original.receipt);
      assert.deepEqual(current.artifact, original.artifact);
      assert.equal(current.observation.run.runId, original.observation.run.runId);
      assert.equal(current.observation.run.startedAt, original.observation.run.startedAt);
    }
  });
}

test('an execution change still restarts the custom service', async t => {
  const f = await fixture(t, 'user');
  const original = await f.row();
  const configuration = { ...original.config, argv: ['--version'] };
  assert.equal((await f.apply('edit', configuration)).state, 'succeeded');
  const current = await f.row();
  assert.deepEqual(current.config.argv, ['--version']);
  assert.notEqual(current.observation.run.runId, original.observation.run.runId);
});
