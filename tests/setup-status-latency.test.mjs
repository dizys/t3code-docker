import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { withTimeout } from '../docker/setup/cache.mjs';

const source = readFileSync(new URL('../docker/setup/server.mjs', import.meta.url), 'utf8');
const statusSource = source.slice(source.indexOf('const status = async () => {'), source.indexOf('/** `t3 auth` prefixes'));

test('status starts independent summaries before slow agent probes finish', async () => {
  let release;
  const probes = new Promise(resolve => { release = resolve; });
  const started = new Set();
  const read = name => async () => { started.add(name); return {}; };
  const finishedReads = new Error('status reads finished');
  const context = vm.createContext({
    publicUrl: () => ({}), operations: new Map(), withTimeout,
    runtimeManager: { status: async () => null },
    antigravity: { status: async () => null },
    loadHarness: async () => ({ toolchains: { status: async () => ({}) }, paths: {} }),
    HARNESS_BUDGET_MS: 4000,
    authLists: { pairing: { snapshot: () => ({ value: [] }) }, session: { snapshot: () => ({ value: [] }) } },
    health: async () => ({}),
    harnessLifecycleStatus: () => probes,
    harnessModule: { readPreinstall: async () => null },
    sourceControlCache: { snapshot: async () => ({}) },
    loadStorage: async () => ({ status: read('storage') }),
    connectFacts: read('connect'),
    credentials: { summary: read('credentials') },
    gateways: { summary: read('gateways') },
    deviceLabels: { apply: async rows => rows },
    noticeSetupProgress: () => {}, noticeSessions: () => {},
    withRegistry: () => { throw finishedReads; },
  });
  vm.runInContext(statusSource + '\nglobalThis.readStatus = status;', context);
  const pending = context.readStatus();
  const done = assert.rejects(pending, error => error === finishedReads);
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.deepEqual([...started].sort(), ['connect', 'credentials', 'gateways', 'storage']);
  } finally {
    release({ harnesses: [], degraded: [] });
    await done;
  }
});


test('pending agent probes keep the console on its fast polling interval', () => {
  const app = readFileSync(new URL('../docker/setup/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('const busyNow =');
  const end = app.indexOf(';', start) + 1;
  const context = vm.createContext({
    storageUI: { isBusy: () => false }, M: { runtimeView: () => null },
    ui: {}, pendingOps: new Set(),
  });
  vm.runInContext(app.slice(start, end) + '\nglobalThis.busy = busyNow;', context);
  assert.equal(context.busy({ harnessCache: { refreshing: true } }), true);
  assert.equal(context.busy({ harnessCache: { refreshing: false } }), false);
});
