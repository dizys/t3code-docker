import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../docker/setup/client/services.js', import.meta.url), 'utf8');
const fixture = (hash = '#services/new', ready = true) => {
  let status = ready ? {} : null, opened = 0, reads = 0;
  const location = { origin: 'https://fixture.test', hash };
  const context = vm.createContext({
    Kit: {}, T3ServiceModel: {}, BASE: '/__setup', location,
    T3ServiceEditor: { create: () => ({ open: () => { opened++; } }) },
    document: { addEventListener() {} },
    sessionStorage: { getItem: () => null },
    setTimeout: () => 1, clearTimeout() {},
  });
  const create = vm.runInContext(source + '\nT3ServicesUI.create;', context);
  const ui = create({
    api: async () => { reads++; return { ok: true, data: { services: [], domains: [], operations: [], connections: [], routes: [] } }; },
    render() {}, go() {}, getStatus: () => status,
  });
  return { ui, location, ready: () => { status = {}; }, opened: () => opened, reads: () => reads };
};

test('status refreshes do not reopen a deep-linked custom-service editor', () => {
  const f = fixture();
  f.ui.activate(true);
  assert.equal(f.opened(), 1);
  for (let i = 0; i < 3; i++) f.ui.activate();
  assert.equal(f.opened(), 1, 'polling must leave the current editor or review alone');
  f.ui.activate(true);
  assert.equal(f.opened(), 2, 'explicitly visiting the same entry can open it again');
});

test('the initial service editor waits for status and opens once when ready', () => {
  const f = fixture('#services/new', false);
  f.ui.activate(true);
  assert.equal(f.opened(), 0);
  assert.equal(f.reads(), 0, 'recording navigation does not request protected data before status is ready');
  f.ready(); f.ui.activate(); f.ui.activate();
  assert.equal(f.opened(), 1);
});

test('an unhandled or superseded route cannot open the custom-service editor', () => {
  const f = fixture('#services');
  f.ui.activate(true);
  f.location.hash = '#services/new';
  f.ui.activate();
  assert.equal(f.opened(), 0, 'a status response cannot accept a navigation before its guard');
  f.ui.activate(true);
  assert.equal(f.opened(), 1);

  const pending = fixture('#services/new', false);
  pending.ui.activate(true);
  pending.location.hash = '#services'; pending.ui.activate(true);
  pending.ready(); pending.ui.activate();
  assert.equal(pending.opened(), 0, 'leaving before status arrives cancels the pending editor entry');
});
