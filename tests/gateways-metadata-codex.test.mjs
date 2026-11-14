import assert from 'node:assert/strict';
import test from 'node:test';
import { isMetadataIp, parseAddress } from '../docker/setup/gateways/address.mjs';
import { probeGateway } from '../docker/setup/gateways/probe.mjs';
import { probeHub } from '../docker/setup/gateways/hub.mjs';
import { desiredInstance } from '../docker/setup/gateways/adapters.mjs';
import { agentOf } from '../docker/setup/gateways/catalog.mjs';

const codex = agentOf('codex');

test('metadata stays refused even with private-host consent', () => {
  for (const url of ['http://169.254.169.254/', 'http://169.254.10.20:80', 'http://[fd00:ec2::254]/']) {
    const parsed = parseAddress(url, { allowPrivateHost: true });
    assert.equal(parsed.ok, false, url);
    assert.equal(parsed.code, 'metadata-host', url);
  }
  assert.equal(isMetadataIp('169.254.169.254'), true);
  assert.equal(isMetadataIp('169.254.0.1'), true);
  assert.equal(isMetadataIp('fd00:ec2::254'), true);
  assert.equal(isMetadataIp('127.0.0.1'), false);
  assert.equal(isMetadataIp('192.168.1.1'), false);
  assert.equal(isMetadataIp('8.8.8.8'), false);
  // Consent still opens loopback, RFC1918 and Compose names.
  assert.equal(parseAddress('http://127.0.0.1:8317', { allowPrivateHost: true }).ok, true);
  assert.equal(parseAddress('http://192.168.1.20:4000').ok, true);
  assert.equal(parseAddress('http://gateway:8317', { allowPrivateHost: true }).ok, true);
});

test('a metadata probe sends no key, even with consent', async () => {
  let called = 0;
  const fetchImpl = async () => { called++; return new Response('{}', { status: 200 }); };
  const direct = await probeGateway({ url: 'http://169.254.169.254/', key: 'sk-test', allowPrivateHost: true, fetchImpl });
  assert.equal(direct.code, 'metadata-host');
  assert.equal(called, 0);
  const viaDns = await probeGateway({ url: 'https://gateway.example.com', key: 'sk-test', allowPrivateHost: true, fetchImpl, lookup: async () => '169.254.169.254' });
  assert.equal(viaDns.code, 'metadata-host');
  assert.equal(called, 0);
  const hub = await probeHub({ url: 'http://169.254.169.254/', key: 'mgmt-test', allowPrivateHost: true, fetchImpl });
  assert.equal(hub.code, 'metadata-host');
  assert.equal(called, 0);
});

test('quote, backslash and backtick never become an address', () => {
  for (const url of ['http://127.0.0.1:8317/a"b', 'http://127.0.0.1:8317/a\\b', 'http://127.0.0.1:8317/a`b']) {
    const parsed = parseAddress(url, { allowPrivateHost: true });
    assert.equal(parsed.ok, false, url);
  }
});

test('Codex launch arguments escape quotes and backslashes for TOML', () => {
  const gateway = { id: 'my-proxy', name: 'My Proxy', url: 'http://127.0.0.1:8317/a"b\\c', accent: '#6366f1', models: { ids: [], manual: [] }, agents: { codex: { on: true } } };
  const { config } = desiredInstance(codex, gateway, { dir: '/d' });
  assert.match(config.launchArgs, /a\\"b\\\\c\/v1/);
});
