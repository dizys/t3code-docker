#!/usr/bin/env node
// Pi's credential file, written by Setup and read by the real Pi. Uses a
// disposable home and fake keys: no login, no network, no model request.
//
//   node scripts/pi-auth-smoke.mjs /absolute/path/to/pi
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
const { createPiAuth, parsePiModelList, piAuthFile } = await import(process.env.T3_HARNESS_MODULE || new URL('../docker/harness/index.mjs', import.meta.url));
const [executable] = process.argv.slice(2);
if (!path.isAbsolute(executable || '')) throw new Error('Pass an absolute Pi executable path.');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 't3-pi-auth-native-'));
const env = { ...process.env, HOME: home, PI_OFFLINE: '1' };
for (const key of Object.keys(env)) if (/TOKEN|API_KEY|^PI_CODING_AGENT_DIR$/.test(key)) delete env[key];
// Pi exits non-zero from `auth check` when a provider is not ready; keep its output either way.
const run = (args) => new Promise((resolve) => execFile(executable, args, { env, cwd: home, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
  (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));
const models = async () => { const result = await run(['--list-models']); return parsePiModelList(result.stdout + '\n' + result.stderr); };
const compare = (a, b) => a.split('.').map(Number).reduce((order, part, i) => order || part - Number(b.split('.')[i] || 0), 0);
try {
  const version = /(\d+\.\d+\.\d+)/.exec((await run(['--version'])).stdout)?.[1];
  assert.ok(version, 'Pi reports its version');
  const auth = createPiAuth({ home, env });
  assert.equal((await models()).available, false, 'a fresh home has no sign-in');

  // A subscription made with /login elsewhere must survive a saved key.
  const file = piAuthFile(home, env);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ anthropic: { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600_000 } }));
  await auth.saveKey('openrouter', 'sk-or-fixture-key');
  await auth.saveKey('groq', 'gsk-fixture-key');
  const signedIn = await models();
  assert.equal(signedIn.available, true);
  for (const provider of ['anthropic', 'openrouter', 'groq']) assert.ok(signedIn.providers.includes(provider), `Pi lists ${provider} models`);
  if (compare(version, '0.84.1') >= 0) {
    const check = JSON.parse((await run(['auth', 'check', '--provider', 'openrouter', '--json', '--no-refresh'])).stdout);
    assert.deepEqual([check.status, check.authType], ['ready', 'api_key'], 'Pi reads the saved key as an API key');
    assert.equal(JSON.parse((await run(['auth', 'check', '--provider', 'anthropic', '--json', '--no-refresh'])).stdout).authType, 'oauth');
  }
  assert.equal((await auth.removeProvider('openrouter')).removed, true);
  assert.equal((await auth.removeProvider('groq')).removed, true);
  assert.deepEqual((await models()).providers, ['anthropic'], 'removal leaves the subscription');
  await auth.removeProvider('anthropic');
  assert.equal((await models()).available, false);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  console.log(`Pi ${version}: saved keys beside a subscription, Pi's model list and removal passed.`);
} finally { await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
