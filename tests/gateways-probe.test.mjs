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
  assert.deepEqual(result.models, { listed: true, ids: ['model-a', 'model-b'], capabilities: {} });
  assert.deepEqual(result.protocols, { messages: 'available', responses: 'missing', chat: 'available' });
  assert.equal(result.url, server.url);
  assert.match(result.notes[0], /Removed \/v1/);
});

test('a gateway that says what it is is recognized, with no key sent to ask', async t => {
  const server = await serve(gateway({ '/': (req, res) => json(res, 200, { message: 'CLI Proxy API Server', endpoints: [] }) })); within(t, server);
  const result = await probeGateway({ url: server.url, key: 'sk-test' });
  assert.equal(result.product, 'cliproxyapi');
  const root = server.requests.find(request => request.url === '/');
  assert.equal(root.headers.authorization, undefined); assert.equal(root.headers['x-api-key'], undefined);
  assert.ok(!server.requests.some(request => request.url.startsWith('/v0/')), 'Management routes count a keyless request as a failed sign-in');
});

test('a gateway that says nothing stays unknown', async t => {
  const server = await serve(gateway()); within(t, server);
  assert.equal((await probeGateway({ url: server.url, key: 'sk-test' })).product, null);
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
  assert.deepEqual(result.models, { listed: true, ids: ['claude-opus-5-5'], capabilities: {} });
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

test('reasoning facts listed beside a model ride along with the list', async t => {
  const server = await serve(gateway({ '/v1/models': (req, res) => json(res, 200, { data: [
    { id: 'model-b', reasoning: { supported_efforts: ['high', 'low'] } },
    { id: 'model-a' },
  ] }) })); within(t, server);
  const result = await probeGateway({ url: server.url, key: 'sk-test' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, { listed: true, ids: ['model-a', 'model-b'], capabilities: { 'model-b': { supported: true, effort: ['low', 'high'] } } });
});

test('CLIProxyAPI catalog enriches shared models without adding template-only ids', async t => {
  const server = await serve(gateway({
    '/': (req, res) => json(res, 200, { message: 'CLIProxyAPI' }),
    '/v1/models?client_version=0.144.0': (req, res) => json(res, 200, { models: [
      { slug: 'model-a', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }, { effort: '{file:secret}' }] },
      { slug: 'model-b', supported_reasoning_levels: [] },
      { slug: 'template-only', supported_reasoning_levels: [{ effort: 'high' }] },
    ] }),
  })); within(t, server);
  const result = await probeGateway({ url: server.url, key: 'sk-catalog' });
  assert.deepEqual(result.models, { listed: true, ids: ['model-a', 'model-b'], capabilities: { 'model-a': { supported: true, effort: ['low', 'ultra'] } } });
  const catalog = server.requests.find(row => row.url.includes('client_version'));
  assert.equal(catalog.method, 'GET');
  assert.equal(catalog.headers.authorization, 'Bearer sk-catalog');
  assert.equal(catalog.headers['anthropic-version'], undefined);
});

test('optional CLIProxyAPI catalog failures leave ordinary discovery working', async t => {
  for (const [status, body] of [[404, {}], [401, {}], [200, { models: 'invalid' }], [302, {}]]) {
    const server = await serve(gateway({ '/': (req, res) => json(res, 200, { message: 'CLIProxyAPI' }),
      '/v1/models?client_version=0.144.0': (req, res) => json(res, status, body) })); within(t, server);
    const result = await probeGateway({ url: server.url });
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, { listed: true, ids: ['model-a', 'model-b'], capabilities: {} });
  }
});

test('catalog can supply discovery on CLIProxyAPI when its ordinary list is unavailable', async t => {
  const server = await serve(gateway({ '/': (req, res) => json(res, 200, { message: 'CLIProxyAPI' }),
    '/v1/models': (req, res) => json(res, 404, {}),
    '/v1/models?client_version=0.144.0': (req, res) => json(res, 200, { models: [{ slug: 'claude-model', supported_reasoning_levels: [{ effort: 'max' }] }] }) })); within(t, server);
  const result = await probeGateway({ url: server.url });
  assert.deepEqual(result.models, { listed: true, ids: ['claude-model'], capabilities: { 'claude-model': { supported: true, effort: ['max'] } } });
});

test('ordinary explicit reasoning facts win over CLIProxyAPI catalog templates', async t => {
  const server = await serve(gateway({ '/': (req, res) => json(res, 200, { message: 'CLIProxyAPI' }),
    '/v1/models': (req, res) => json(res, 200, { data: [{ id: 'model-a', reasoning: false }] }),
    '/v1/models?client_version=0.144.0': (req, res) => json(res, 200, { models: [{ slug: 'model-a', supported_reasoning_levels: [{ effort: 'high' }] }] }) })); within(t, server);
  assert.deepEqual((await probeGateway({ url: server.url })).models.capabilities, { 'model-a': { supported: false } });
});

test('ordinary reasoning and token limits are enriched independently from the optional catalog', async t => {
  const server = await serve(gateway({
    '/': (req, res) => json(res, 200, { message: 'CLIProxyAPI' }),
    '/v1/models': (req, res) => json(res, 200, { data: [
      { id: 'model-a', reasoning: false },
      { id: 'model-b', context_length: 128000 },
    ] }),
    '/v1/models?client_version=0.144.0': (req, res) => json(res, 200, { models: [
      { slug: 'model-a', context_window: 1048576, max_tokens: 1048576, supported_reasoning_levels: [{ effort: 'high' }] },
      { slug: 'model-b', context_window: 1000000, max_tokens: 8192 },
      { slug: 'phantom', context_window: 1000000 },
    ] }),
  })); within(t, server);
  const { models } = await probeGateway({ url: server.url });
  assert.deepEqual(models.capabilities, {
    'model-a': { supported: false, limits: { context: 1048576 } },
    'model-b': { limits: { context: 128000, output: 8192 } },
  });
  assert.deepEqual(models.ids, ['model-a', 'model-b']);
});

test('other gateways and rejected keys never request the CLIProxyAPI catalog', async t => {
  for (const identified of [false, true]) {
    const server = await serve(gateway({ '/': (req, res) => json(res, 200, identified ? { message: 'CLIProxyAPI' } : {}),
      ...(identified ? { '/v1/models': (req, res) => json(res, 401, {}) } : {}) })); within(t, server);
    await probeGateway({ url: server.url });
    assert.ok(!server.requests.some(row => row.url.includes('client_version')));
  }
});
