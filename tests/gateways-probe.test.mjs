import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { probeGateway } from '../docker/setup/gateways/probe.mjs';

const serve = async handler => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { requests.push({ method: req.method, url: req.url, body, headers: req.headers }); handler(req, res); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
};
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const gateway = (routes = {}) => (req, res) => {
  const route = routes[req.url];
  if (route) return route(req, res);
  if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'model-b' }, { id: 'model-a' }] });
  return json(res, 400, { error: 'invalid request' });
};
const within = (t, server) => t.after(() => server.close());

test('a working gateway reports its models and every protocol it has', async t => {
  const server = await serve(gateway({ '/v1/responses': (req, res) => json(res, 404, {}) })); within(t, server);
  const result = await probeGateway({ url: server.url + '/v1', key: 'sk-test' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, { listed: true, ids: ['model-a', 'model-b'] });
  assert.deepEqual(result.protocols, { messages: 'available', responses: 'missing', chat: 'available' });
  assert.equal(result.url, server.url);
  assert.match(result.notes[0], /Removed \/v1/);
});

test('real names come first, from a gateway that answers by client', async t => {
  // CLIProxyAPI: the same models, with `claude-` names for anything Anthropic.
  const server = await serve(gateway({ '/v1/models': (req, res) => json(res, 200, { data: req.headers['anthropic-version']
    ? [{ id: 'claude-opus-5-5' }, { id: 'claude-fable-5-dd-los-6-tpg' }]
    : [{ id: 'claude-opus-5-5' }, { id: 'gpt-6-sol' }] }) })); within(t, server);
  const result = await probeGateway({ url: server.url, key: 'sk-test' });
  assert.deepEqual(result.models.ids, ['claude-opus-5-5', 'gpt-6-sol']);
  assert.equal(server.requests.filter(request => request.url === '/v1/models').length, 1);
});

test('Anthropic\'s own API lists models only when its header is there', async t => {
  const server = await serve(gateway({ '/v1/models': (req, res) => req.headers['anthropic-version']
    ? json(res, 200, { data: [{ id: 'claude-opus-5-5', type: 'model' }], has_more: false })
    : json(res, 400, { error: 'anthropic-version: header is required' }) })); within(t, server);
  const result = await probeGateway({ url: server.url, key: 'sk-test' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, { listed: true, ids: ['claude-opus-5-5'] });
});

test('a refused key is not asked about twice', async t => {
  const server = await serve(gateway({ '/v1/models': (req, res) => json(res, 401, {}) })); within(t, server);
  const result = await probeGateway({ url: server.url, key: 'sk-wrong' });
  assert.equal(result.code, 'unauthorized');
  assert.equal(server.requests.filter(request => request.url === '/v1/models').length, 1);
});

test('both auth headers go out, because gateways read one or the other', async t => {
  const server = await serve(gateway()); within(t, server);
  await probeGateway({ url: server.url, key: 'sk-test' });
  const [list] = server.requests;
  assert.equal(list.headers.authorization, 'Bearer sk-test');
  assert.equal(list.headers['x-api-key'], 'sk-test');
  assert.equal(list.headers['anthropic-version'], undefined);
  assert.equal(server.requests.find(request => request.url === '/v1/messages').headers['anthropic-version'], '2023-06-01');
});

test('protocol checks send an empty body, so a test can never spend tokens', async t => {
  const server = await serve(gateway()); within(t, server);
  await probeGateway({ url: server.url, key: 'sk-test' });
  const posts = server.requests.filter(request => request.method === 'POST');
  assert.deepEqual(posts.map(post => post.url).sort(), ['/v1/chat/completions', '/v1/messages', '/v1/responses']);
  for (const post of posts) assert.equal(post.body, '{}');
});

test('a rejected key says so, on the list or on a protocol route', async t => {
  const closed = await serve((req, res) => json(res, 401, { error: 'bad key sk-test' })); within(t, closed);
  const result = await probeGateway({ url: closed.url, key: 'sk-test' });
  assert.equal(result.code, 'unauthorized');
  assert.match(result.message, /turned this key down/);
  assert.doesNotMatch(JSON.stringify(result), /sk-test/, 'an upstream’s words can echo the key');

  // OpenRouter lists models for anyone, and only checks the key on a real request.
  const open = await serve(gateway({ '/v1/chat/completions': (req, res) => json(res, 401, {}) })); within(t, open);
  assert.equal((await probeGateway({ url: open.url, key: 'wrong' })).code, 'unauthorized');
});

test('a missing key asks for one', async t => {
  const server = await serve((req, res) => json(res, 401, {})); within(t, server);
  assert.match((await probeGateway({ url: server.url })).message, /needs a key/);
});

test('a gateway that doesn’t list models still counts when a protocol answers', async t => {
  const server = await serve(gateway({ '/v1/models': (req, res) => json(res, 404, {}) })); within(t, server);
  const result = await probeGateway({ url: server.url });
  assert.equal(result.ok, true);
  assert.equal(result.models.listed, false);
});

test('a server that isn’t a gateway is called out', async t => {
  const page = await serve((req, res) => { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>nope</h1>'); }); within(t, page);
  const missing = await probeGateway({ url: page.url });
  assert.equal(missing.code, 'not-gateway');
  assert.match(missing.hint, /path such as \/api/);
  const html = await serve((req, res) => { res.writeHead(req.method === 'GET' ? 200 : 404, { 'content-type': 'text/html' }); res.end('<h1>hello</h1>'); }); within(t, html);
  assert.match((await probeGateway({ url: html.url })).message, /not like an AI gateway/);
});

test('a redirect is reported with its target, and the key doesn’t follow it', async t => {
  const target = await serve(gateway()); within(t, target);
  const server = await serve((req, res) => { res.writeHead(301, { location: `${target.url}/v1/models` }); res.end(); }); within(t, server);
  const result = await probeGateway({ url: server.url, key: 'sk-test' });
  assert.equal(result.code, 'redirect');
  assert.equal(result.fix.url, target.url);
  assert.equal(target.requests.length, 0);
});

test('a refused connection on loopback suggests the Docker host', async () => {
  const closed = await serve(() => {}), port = new URL(closed.url).port;
  await closed.close();
  const result = await probeGateway({ url: closed.url });
  assert.equal(result.code, 'refused');
  assert.match(result.message, /inside this container/);
  assert.deepEqual(result.fix, { url: `http://host.docker.internal:${port}`, label: 'Use host.docker.internal' });
});

test('each way of failing to connect has its own sentence', async () => {
  const failing = cause => async () => { throw Object.assign(new TypeError('fetch failed'), { cause }); };
  const probe = (url, cause) => probeGateway({ url, fetchImpl: failing(cause) });
  const dockerHost = await probe('http://host.docker.internal:8317', { code: 'ENOTFOUND' });
  assert.equal(dockerHost.code, 'dns');
  assert.match(dockerHost.hint, /extra_hosts/);
  assert.match((await probe('http://gateway:8317', { code: 'ENOTFOUND' })).message, /can’t be found/);
  assert.match((await probe('http://host.docker.internal:8317', { code: 'ECONNREFUSED' })).hint, /0\.0\.0\.0/);
  assert.equal((await probe('https://gateway', { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).code, 'tls');
  assert.match((await probe('https://gateway', { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })).hint, /public authority/);
  assert.equal((await probe('https://gateway', { code: 'UND_ERR_CONNECT_TIMEOUT' })).code, 'timeout');
  assert.equal((await probe('https://gateway', { code: 'ECONNRESET' })).code, 'unreachable');
});

test('a slow gateway times out instead of holding the page', async t => {
  const server = await serve(() => {}); within(t, server);
  const result = await probeGateway({ url: server.url, timeoutMs: 80 });
  assert.equal(result.code, 'timeout');
});

test('a bad address fails before anything is sent', async () => {
  let called = false;
  const result = await probeGateway({ url: 'ftp://nope', fetchImpl: async () => { called = true; } });
  assert.equal(result.code, 'invalid');
  assert.equal(called, false);
});

test('an upstream error after the list is unknown, not missing', async t => {
  const server = await serve(gateway({ '/v1/messages': (req, res) => json(res, 502, {}) })); within(t, server);
  assert.equal((await probeGateway({ url: server.url })).protocols.messages, 'unknown');
});
