// The templates the page and the CLI both draw from, and the old command names.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPES, TYPE_IDS, publicTypes, isType, applies, withDefaults, envNames, primarySecret } from '../docker/setup/credentials/types.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL('../scripts/fixtures/console/credentials.json', import.meta.url), 'utf8'));

test('the console fixture carries the same types the server sends', () => {
  assert.deepEqual(fixture.types, JSON.parse(JSON.stringify(publicTypes())));
});

test('the types survive JSON unchanged, so the page sees what the server does', () => {
  const direct = publicTypes(), sent = JSON.parse(JSON.stringify(direct));
  assert.deepEqual(sent, direct);
  assert.deepEqual(direct.map(type => type.order), [...direct.map(type => type.order)].sort((a, b) => a - b));
  assert.deepEqual(direct.map(type => type.id), TYPE_IDS);
});

test('the console fixture has only public rows', () => {
  assert.ok(fixture.credentials.length > 0);
  for (const row of fixture.credentials) {
    assert.ok(isType(row.type), row.id);
    assert.equal(Object.hasOwn(row, 'secrets'), false, row.id);
    assert.ok(Array.isArray(row.secretNames), row.id); assert.ok(Array.isArray(row.delivers), row.id);
  }
});

test('every type is complete enough to draw a form and a flag from', () => {
  for (const [id, type] of Object.entries(TYPES)) {
    for (const key of ['label', 'badge', 'icon']) assert.ok(typeof type[key] === 'string' && type[key], id + ' ' + key);
    if (type.dynamic) { assert.deepEqual([type.fields, type.secrets], [[], []], id); continue; }
    assert.ok(type.secrets.some(entry => entry.primary), id + ' has a main secret');
    const keys = [...type.fields, ...type.secrets].map(entry => entry.key);
    assert.equal(new Set(keys).size, keys.length, id + ' repeats a key');
    for (const entry of [...type.fields, ...type.secrets]) {
      assert.ok(entry.key && entry.label, id + ' ' + entry.key);
      if (entry.kind === 'select') assert.ok(entry.options.length > 1, id + ' ' + entry.key);
      if (entry.kind === 'number') assert.ok(entry.min !== undefined && entry.max !== undefined, id + ' ' + entry.key);
      if (entry.env) assert.match(entry.env, /^(?:\{NAME\}_)?[A-Z_]+$/, id + ' ' + entry.key);
      if (entry.pattern) new RegExp(entry.pattern);
    }
    // Every combination of a select's values has at most one main secret.
    const select = type.fields.find(entry => entry.kind === 'select' && type.secrets.some(secret => secret.when?.[entry.key]));
    for (const [value] of select?.options ?? [[]]) {
      const fields = withDefaults(id, select ? { [select.key]: value } : {});
      assert.equal(type.secrets.filter(entry => entry.primary && applies(entry, fields)).length, 1, id + ' ' + value);
    }
  }
});

test('types know what applies, what is defaulted and what a credential is called', () => {
  assert.equal(isType('toString'), false, 'a name on the prototype isn\'t a type'); assert.equal(isType(undefined), false); assert.equal(isType('ssh'), true);
  assert.deepEqual(withDefaults('ssh'), { port: 22, auth: 'key' });
  assert.deepEqual(withDefaults('ssh', { auth: 'password', port: 2222 }), { port: 2222, auth: 'password' });
  assert.equal(primarySecret('ssh', { auth: 'key' }).key, 'privateKey'); assert.equal(primarySecret('custom'), null);
  assert.equal(applies({ needs: 'baseUrl' }, {}), false); assert.equal(applies({ needs: 'baseUrl' }, { baseUrl: 'x' }), true);
  assert.equal(applies({ when: { auth: ['key'] } }, { auth: 'password' }), false); assert.equal(applies({}, {}), true);
  assert.deepEqual(envNames({ id: 'cloudflare-token', type: 'token' }), { token: 'CLOUDFLARE_TOKEN' });
  assert.deepEqual(envNames({ id: 'cloudflare-token', type: 'token', env: { token: 'CF_API_TOKEN' } }), { token: 'CF_API_TOKEN' });
  assert.deepEqual(envNames({ id: 'box', type: 'ssh' }), {});
});

async function* textFiles(folder) {
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') yield* textFiles(file); continue; }
    if (!entry.isFile()) continue;
    const bytes = await fs.readFile(file);
    if (!bytes.includes(0)) yield { file, text: bytes.toString('utf8') };
  }
}

test('nothing under docker/ or examples/ still mentions t3-ssh or the t3-api command', async () => {
  // docker/setup/t3-api.mjs is an unrelated module that talks to T3's own API, so
  // its file name is allowed wherever it's written with its extension.
  const stale = /(?<![\w-])t3-ssh(?![\w])|(?<![\w-])t3-api(?![\w]|\.mjs)/g, found = [];
  let read = 0;
  for (const root of ['docker', 'examples']) {
    for await (const { file, text } of textFiles(path.join(repo, root))) {
      read++;
      for (const [index, line] of text.split('\n').entries()) if (stale.test(line)) found.push(`${path.relative(repo, file)}:${index + 1}: ${line.trim().slice(0, 120)}`);
      stale.lastIndex = 0;
    }
  }
  assert.ok(read > 100, 'the walk really did read the tree');
  assert.deepEqual(found, []);
});

test('the check above would notice either old command', () => {
  const stale = /(?<![\w-])t3-ssh(?![\w])|(?<![\w-])t3-api(?![\w]|\.mjs)/;
  for (const line of ['t3-ssh build-server -- uptime', 't3-api project-api GET me', '`t3-api`', 'exec /opt/t3-setup/t3-ssh', 't3-ssh-test-']) assert.equal(stale.test(line), true, line);
  for (const line of ['import { createT3Api } from "./t3-api.mjs";', 'through T3\'s API (t3-api.mjs)', 'not-t3-ssh', 'my-t3-api']) assert.equal(stale.test(line), false, line);
});
