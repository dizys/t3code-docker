import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../scripts/services-tailscale-smoke.mjs', import.meta.url), 'utf8');
const until = source.slice(source.indexOf('const until ='), source.indexOf('\nconst snapshot ='));
const exercise = source.slice(source.indexOf('const exercise ='), source.indexOf("\nif (phase === 'exercise')"));

const fixture = tcp => {
  let now = 0;
  const context = vm.createContext({
    assert, net, tcp,
    process: { getuid: () => 1000 },
    Date: { now: () => now }, pause: async ms => { now += ms; },
    fs: { readFile: async path => path.endsWith('.json')
      ? JSON.stringify({ dnsName: 'peer.fixture.test.', ips: ['100.64.0.2', 'fd7a::2'] }) : 'test certificate' },
    lookup: async () => ({ address: '100.64.0.2' }),
    udp: async () => 'udp-roundtrip',
    httpGet: async url => url.startsWith('https:') ? 'tailnet-https' : 'tailnet-http',
    ordinary: async () => {},
  });
  vm.runInContext(until + '\n' + exercise + '\nglobalThis.run = exercise;', context);
  return context.run;
};

test('tailnet acceptance waits for peer connectivity before checking protocols', async () => {
  const hosts = [];
  const run = fixture(async host => {
    hosts.push(host);
    if (hosts.length === 1) throw new Error('TCP deadline');
    return 'tcp-roundtrip';
  });
  await run();
  assert.deepEqual(hosts, ['peer.fixture.test', 'peer.fixture.test', '100.64.0.2', 'fd7a::2']);
});

test('an unreachable peer still fails within the readiness deadline', async () => {
  let attempts = 0;
  const run = fixture(async () => { attempts++; throw new Error('TCP deadline'); });
  await assert.rejects(run(), /Timed out: tailnet peer TCP connectivity/);
  assert.equal(attempts, 450);
});

test('peer readiness requires the correct echo and cannot hide later protocol failures', async () => {
  let attempts = 0;
  const run = fixture(async () => ++attempts === 1 ? 'tcp-roundtrip' : 'wrong response');
  await assert.rejects(run(), /wrong response/);
  assert.equal(attempts, 2);
});
