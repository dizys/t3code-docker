import assert from 'node:assert/strict';
import test from 'node:test';
import { isBlockedIp, isLoopback, isMetadata, isPrivate, isSingleLabel, needsPrivateConfirm, parseAddress, suggestName, withHost } from '../docker/setup/gateways/address.mjs';

test('an address is reduced to the base every agent can build on', () => {
  for (const [input, url] of [
    ['http://gateway:8317', 'http://gateway:8317'],
    ['http://gateway:8317/', 'http://gateway:8317'],
    ['http://gateway:8317/v1', 'http://gateway:8317'],
    ['http://gateway:8317/v1/', 'http://gateway:8317'],
    ['http://gateway:8317/v1/models', 'http://gateway:8317'],
    ['http://gateway:8317/v1/messages', 'http://gateway:8317'],
    ['http://gateway:8317/v1/responses', 'http://gateway:8317'],
    ['http://gateway:8317/v1/chat/completions', 'http://gateway:8317'],
    ['https://openrouter.ai/api', 'https://openrouter.ai/api'],
    ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api'],
    ['https://example.com/proxy/anthropic/', 'https://example.com/proxy/anthropic'],
  ]) assert.equal(parseAddress(input, { allowPrivateHost: true }).url, url, input);
});

test('a removed path is explained, and an address with nothing to remove has no note', () => {
  assert.deepEqual(parseAddress('http://gateway:8317', { allowPrivateHost: true }).notes, []);
  assert.match(parseAddress('http://gateway:8317/v1/', { allowPrivateHost: true }).notes[0], /Removed \/v1\./);
});

test('a missing scheme is http where that is ordinary and https elsewhere', () => {
  assert.equal(parseAddress('localhost:8317', { allowPrivateHost: true }).url, 'http://localhost:8317');
  assert.equal(parseAddress('cliproxy:8317', { allowPrivateHost: true }).url, 'http://cliproxy:8317');
  assert.equal(parseAddress('192.168.1.20:4000').url, 'http://192.168.1.20:4000');
  assert.equal(parseAddress('openrouter.ai/api').url, 'https://openrouter.ai/api');
});

test('a bad address gets a sentence that says what to change', () => {
  assert.match(parseAddress('').error, /Enter your gateway/);
  assert.match(parseAddress('two words').error, /single address/);
  assert.match(parseAddress('ftp://gateway').error, /http/);
  assert.match(parseAddress('http://user:secret@gateway').error, /API key field/);
  assert.match(parseAddress('http://gateway?key=secret').error, /API key field/);
  assert.equal(parseAddress('x'.repeat(3000)).ok, false);
});

test('plain http is flagged only when it leaves a private network', () => {
  assert.equal(parseAddress('http://api.example.com').insecure, true);
  for (const address of ['https://api.example.com', 'http://localhost:1', 'http://10.0.0.2', 'http://172.20.0.2', 'http://192.168.0.2', 'http://100.100.1.1', 'http://cliproxy:8317', 'http://box.tail1234.ts.net', 'http://host.docker.internal:8317'])
    assert.equal(parseAddress(address, { allowPrivateHost: true }).insecure, false, address);
});

test('loopback means this container, which is what the connection hint turns on', () => {
  for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '0.0.0.0']) assert.equal(isLoopback(host), true, host);
  for (const host of ['host.docker.internal', '10.0.0.1', 'gateway']) assert.equal(isLoopback(host), false, host);
  assert.equal(isPrivate('8.8.8.8'), false);
  assert.equal(isPrivate('172.32.0.1'), false);
});

test('only real IPv6 private addresses count as private, not names that look like them', () => {
  assert.equal(isPrivate('fd00:1234::1'), true);
  assert.equal(isPrivate('[fc00::1]'), true);
  assert.equal(isPrivate('fd-proxy.example.com'), false);
  assert.equal(parseAddress('fd-proxy.example.com').url, 'https://fd-proxy.example.com');
  assert.equal(parseAddress('http://fd-proxy.example.com').insecure, true);
});

test('an apostrophe can’t break out of Codex’s quoted launch arguments', () => {
  assert.equal(parseAddress("http://gw:1/o'brien", { allowPrivateHost: true }).url, 'http://gw:1/o%27brien');
});

test('another host keeps the scheme, port and path', () => {
  assert.equal(withHost('http://127.0.0.1:8317/proxy', 'host.docker.internal'), 'http://host.docker.internal:8317/proxy');
});

test('a gateway nobody named gets a readable name', () => {
  assert.equal(suggestName('http://localhost:8317', 'LiteLLM'), 'LiteLLM');
  assert.equal(suggestName('http://localhost:8317'), 'Local gateway');
  assert.equal(suggestName('http://host.docker.internal:8317'), 'Local gateway');
  assert.equal(suggestName('https://ai.example.com/v1'), 'Example');
  assert.equal(suggestName('http://cliproxy:8317'), 'Cliproxy');
});

test('a pasted admin address loses its admin path, so a test can’t count as a failed sign-in', () => {
  for (const [input, url] of [['https://gw.example.com/v0/management', 'https://gw.example.com'], ['https://gw.example.com/v0/management/config', 'https://gw.example.com'], ['https://gw.example.com/v8/management/usage', 'https://gw.example.com'], ['https://gw.example.com/management.html', 'https://gw.example.com']]) {
    const parsed = parseAddress(input);
    assert.equal(parsed.url, url, input); assert.match(parsed.notes[0], /^Removed /);
  }
});

test('loopback and single-label names need a private-host confirm, metadata stays refused', () => {
  for (const input of ['http://localhost:8317', 'http://127.0.0.1:8317', 'http://127.1.2.3:8317', 'http://0.0.0.0:8317', 'http://[::1]:8317', 'http://gateway:8317', 'cliproxy:8317', 'localhost:8317']) {
    const rejected = parseAddress(input);
    assert.equal(rejected.ok, false, input);
    assert.equal(rejected.code, 'private-host', input);
    assert.match(rejected.error, /Confirm that you trust/, input);
    const allowed = parseAddress(input, { allowPrivateHost: true });
    assert.equal(allowed.ok, true, input);
  }
  for (const input of ['http://169.254.169.254', 'http://169.254.10.20:80']) {
    assert.equal(parseAddress(input).code, 'metadata-host', input);
    const refused = parseAddress(input, { allowPrivateHost: true });
    assert.equal(refused.ok, false, input);
    assert.equal(refused.code, 'metadata-host', input);
  }
  assert.equal(parseAddress('https://openrouter.ai/api').ok, true);
  assert.equal(parseAddress('http://192.168.1.20:4000').ok, true);
  assert.equal(parseAddress('http://10.0.0.2:4000').ok, true);
  for (const host of ['169.254.169.254', '169.254.0.1']) assert.equal(isMetadata(host), true, host);
  assert.equal(isMetadata('169.253.169.254'), false);
  for (const host of ['gateway', 'cliproxy', 'localhost']) assert.equal(isSingleLabel(host), true, host);
  assert.equal(isSingleLabel('gateway.example.com'), false);
  assert.equal(needsPrivateConfirm('gateway'), true);
  assert.equal(needsPrivateConfirm('openrouter.ai'), false);
  assert.equal(isBlockedIp('127.0.0.1'), true);
  assert.equal(isBlockedIp('0.0.0.0'), true);
  assert.equal(isBlockedIp('::1'), true);
  assert.equal(isBlockedIp('169.254.169.254'), true);
  assert.equal(isBlockedIp('8.8.8.8'), false);
});
