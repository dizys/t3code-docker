import assert from 'node:assert/strict';
import test from 'node:test';
import { isLoopback, isPrivate, parseAddress, suggestName, withHost } from '../docker/setup/gateways/address.mjs';

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
  ]) assert.equal(parseAddress(input).url, url, input);
});

test('a removed path is explained, and an address with nothing to remove has no note', () => {
  assert.deepEqual(parseAddress('http://gateway:8317').notes, []);
  assert.match(parseAddress('http://gateway:8317/v1/').notes[0], /Removed \/v1\./);
});

test('a missing scheme is http where that is ordinary and https elsewhere', () => {
  assert.equal(parseAddress('localhost:8317').url, 'http://localhost:8317');
  assert.equal(parseAddress('cliproxy:8317').url, 'http://cliproxy:8317');
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
    assert.equal(parseAddress(address).insecure, false, address);
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
  assert.equal(parseAddress("http://gw:1/o'brien").url, 'http://gw:1/o%27brien');
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
