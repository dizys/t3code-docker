#!/usr/bin/env node
// The real console with in-memory data and no production API. Useful for native
// browser review without installing seven agents or authorizing any writes.
// node scripts/console-preview.mjs [--port 23785]
import http from 'node:http';
import { createRequire } from 'node:module';
import { loadAssets, renderConsole, contentSecurityPolicy } from '../docker/setup/page.mjs';
const require = createRequire(import.meta.url);
const { statusFor, portsFor, fixture } = require('./lib/console-fixtures.cjs');
const { createSkillsFixtures } = require('./lib/skills-fixtures.cjs');
const { createStorageFixtures } = require('./lib/storage-fixtures.cjs');
const { createMcpFixtures } = require('./lib/mcp-fixtures.cjs');
const { createFilesFixtures } = require('./lib/files-fixtures.cjs');
const { createCredentialsFixtures } = require('./lib/credentials-fixtures.cjs');
const credentials = createCredentialsFixtures();
const files = createFilesFixtures();
const mcp = createMcpFixtures();
const api = createSkillsFixtures();
const storage = createStorageFixtures();
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 23785;
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/.well-known/t3/environment') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ environmentId: 'fixture-preview', serverVersion: 'fixture', label: 'Fixture preview' })); return; }
  if (url.pathname === '/__setup/' || url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'content-security-policy': contentSecurityPolicy('fixture') });
    // Match both real Setup entry points, including direct-port image smoke tests.
    res.end(renderConsole({ assets: loadAssets(), nonce: 'fixture', mount: url.pathname === '/' ? '' : '/__setup', embed: url.searchParams.get('embed') === 't3', host: url.searchParams.get('host'), layout: url.searchParams.get('layout') }));
    return;
  }
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { chunks.push(chunk); bytes += chunk.length; if (bytes > (url.pathname.endsWith('/files/upload/chunk')?8*1024*1024+65536:url.pathname.endsWith('/files/write')?5*1024*1024+65536:150000)) { res.writeHead(413); res.end(); return; } }
  let input;
  try { input = url.pathname.endsWith('/files/upload/chunk')?Buffer.concat(chunks):chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; }
  catch { res.writeHead(400); res.end(); return; }
  const result = await credentials.respond(req.method, url, input) || await files.respond(req.method, url, input) || await mcp.respond(req.method, url, input) || storage.respond(req.method, url, input) || api.respond(req.method, url, input) || (url.pathname.endsWith('/status') ? { body: { ...statusFor('skills'), credentials: credentials.status(), storage: storage.status(), context: { ...statusFor('skills').context, mcp: mcp.status() } } }
    : url.pathname.endsWith('/ports') ? { body: portsFor('ready') }
      : url.pathname.endsWith('/providers') ? { body: fixture(url.searchParams.get('agent') === 'pi' ? 'pi-providers.json' : 'providers.json') }
        : { status: 404, body: { ok: false, error: 'This is a read-only fixture preview. No live API is connected.' } });
  if (result.body?.etag && req.headers['if-none-match'] === result.body.etag) { res.writeHead(304, { ETag: result.body.etag }); res.end(); return; }
  res.writeHead(result.status || 200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...result.headers });
  res.end(result.raw || JSON.stringify(result.body));
}).listen(port, '127.0.0.1', () => console.log(`Fixture console: http://127.0.0.1:${port}/__setup/#instructions/skills (all writes stay in memory)`));
