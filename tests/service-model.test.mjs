import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../docker/setup/client/service-model.js', import.meta.url), 'utf8');
const model = vm.runInNewContext(source + '\nT3ServiceModel;');
const tailscale = (connection, extra = {}) => ({ domain: 'system', id: 'tailscale', enabled: true, artifact: {}, observation: { state: 'running', connection }, ...extra });
const actions = (resource, operations) => Array.from(model.authenticationActions(resource, operations));

test('Tailscale offers only actions supported by its current sign-in state', () => {
  for (const [connection, expected] of [
    [{ state: 'NeedsLogin', signInPending: false }, ['sign-in']],
    [{ state: 'NeedsLogin', signInPending: true }, ['continue-sign-in']],
    [{ state: 'NeedsLogin' }, ['sign-in']],
    [{ state: 'Running' }, ['sign-out']],
    [{ state: 'Stopped' }, ['sign-out']],
    [{ state: 'NeedsMachineAuth' }, ['check-approval', 'sign-out']],
    [{ state: 'Starting' }, []],
    [{ state: 'Unavailable' }, []],
    [{ state: 'NoState' }, []],
    [undefined, []],
  ]) assert.deepEqual(actions(tailscale(connection)), expected, JSON.stringify(connection));
});

test('disabled, stopped, uninstalled, custom and stale services offer no authentication actions', () => {
  const connection = { state: 'NeedsLogin', signInPending: true };
  for (const extra of [
    { enabled: false }, { artifact: null }, { uninstalled: true }, { domain: 'user' }, { id: 'openssh' },
    { observation: { state: 'stopped', connection } },
    { observation: { state: 'unavailable', connection } },
    { observation: { state: 'running', lastKnown: true, connection } },
  ]) assert.deepEqual(actions(tailscale(connection, extra)), []);
});

test('an in-flight sign-in can be resumed while its authorization link is being generated', () => {
  const resource = tailscale({ state: 'NeedsLogin', signInPending: false });
  const operation = { domain: 'system', target: 'tailscale', action: 'sign-in', state: 'committed' };
  assert.deepEqual(actions(resource, [operation]), ['continue-sign-in']);
  for (const patch of [{ domain: 'user' }, { target: 'other' }, { action: 'restart' }, { state: 'succeeded' }, { state: 'failed' }]) {
    assert.deepEqual(actions(resource, [{ ...operation, ...patch }]), ['sign-in']);
  }
});
