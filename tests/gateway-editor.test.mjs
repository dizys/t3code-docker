import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { AGENTS, PRESETS, PROTOCOLS } from '../docker/setup/gateways/catalog.mjs';

const model = await readFile(new URL('../docker/setup/client/gateway-model.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../docker/setup/client/gateway-editor.js', import.meta.url), 'utf8');
async function fixture() {
  const listeners = {}, calls = [];
  const panel = { querySelectorAll: () => [], querySelector: () => null, addEventListener: (name, callback) => { listeners[name] = callback; } };
  const context = vm.createContext({ URL, Set, Date, JSON,
    Kit: { html: () => '', raw: value => value, icon: () => '', isPhone: () => false, announce() {},
      open: () => ({ panel, render() {}, close() {} }) },
    window: { addEventListener() {}, removeEventListener() {} }, T3C: {},
  });
  vm.runInContext(model, context);
  vm.runInContext(`T3GatewayModel.setCatalog(${JSON.stringify({ agents: AGENTS, presets: PRESETS, protocols: PROTOCOLS })});`, context);
  const create = vm.runInContext(source + '\nT3GatewayEditor.create;', context);
  const editor = create({ revision: () => 1, installed: () => true, hubs: () => false, conflicts: () => [],
    api: async (route, input) => {
      calls.push({ route, body: JSON.parse(JSON.stringify(input.body)) });
      return route === '/gateways/test'
        ? { ok: true, data: { result: { ok: true, url: input.body.url.replace(/\/v1$/, ''), protocols: { messages: 'available', responses: 'available', chat: 'available' }, models: { listed: true, ids: ['model-one'] } } } }
        : { ok: false, error: 'Fixture stopped before saving' };
    },
  });
  await editor.open({ id: 'existing', name: 'Existing', preset: 'custom', url: 'http://original.invalid', key: { state: 'saved', credentialId: 'held' }, agents: [] });
  const input = (field, value) => listeners.input({ target: { dataset: { gwField: field }, value } });
  const consent = value => listeners.change({ target: { dataset: {}, checked: value, matches: selector => selector === '[data-gw-private]' } });
  const changeURL = value => { input('url', value); listeners.change({ target: { id: 'gw-url', dataset: {}, matches: () => false } }); };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { calls, input, consent, changeURL, settle, submit: () => listeners.submit({ preventDefault() {} }) };
}

test('a successful private-host test is reused on save after URL normalization', async () => {
  const f = await fixture();
  f.input('url', 'http://private.invalid/v1'); f.consent(true); await f.settle();
  assert.equal(f.calls.filter(call => call.route === '/gateways/test').length, 1);
  f.submit(); await f.settle();
  assert.equal(f.calls.filter(call => call.route === '/gateways/test').length, 1, 'a matching tested signature must not spend the key twice');
  const save = f.calls.find(call => call.route === '/gateways/save');
  assert.equal(save.body.gateway.url, 'http://private.invalid'); assert.equal(save.body.allowPrivateHost, true);
});

test('changing an address clears private-host consent before a new request', async () => {
  const f = await fixture();
  f.input('url', 'http://first-private.invalid'); f.consent(true); await f.settle();
  f.changeURL('http://different-private.invalid'); await f.settle();
  const tests = f.calls.filter(call => call.route === '/gateways/test');
  assert.equal(tests.length, 2); assert.equal(tests[0].body.allowPrivateHost, true);
  assert.equal(tests[1].body.allowPrivateHost, undefined);
});
