import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunner } from '../docker/harness/io.mjs';
import { use, latest, writeEnv } from '../docker/harness/mise.mjs';

test('npm lifecycle scripts can run Node with an unconfigured mise shim, without changing global policy', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-npm-node-env-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'custom-data'), shims = path.join(dataDir, 'shims');
  await fs.mkdir(shims, { recursive: true });
  await fs.writeFile(path.join(shims, 'node'), '#!/bin/sh\nprintf "No version is set for shim: node\\n" >&2\nexit 93\n', { mode: 0o700 });
  const env = { HOME: root, PATH: [shims + '/', '/usr/bin', shims].join(path.delimiter), MISE_NOT_FOUND_SYSTEM_FALLBACK: 'false' };
  const before = { ...env }, run = createRunner();
  const blocked = await run(['/usr/bin/env', 'node', '--version'], { env: writeEnv(env), cwd: root });
  assert.equal(blocked.code, 93, 'the inherited environment reproduces the unconfigured shim');
  assert.match(blocked.stderr, /No version is set for shim: node/);
  let lifecycle;
  const ctx = { env, home: root, dataDir, miseBin: 'mise', timeouts: { install: 5000 }, run: async (argv, options) => {
    assert.deepEqual(argv, ['mise', '-C', root, 'use', '-g', 'npm:@opencode/cli[allow_builds=@opencode/cli,allow_low_downloads=true]@2.2.7']);
    assert.equal(options.env.MISE_AUTO_INSTALL, 'false');
    assert.equal(options.env.MISE_NOT_FOUND_SYSTEM_FALLBACK, 'false');
    lifecycle = await run(['/usr/bin/env', 'node', '--version'], options);
    return lifecycle;
  } };
  await use(ctx, 'npm:@opencode/cli', '2.2.7', 'allow_builds=@opencode/cli,allow_low_downloads=true');
  assert.equal(lifecycle.code, 0);
  assert.match(lifecycle.stdout.trim(), /^v\d+\.\d+\.\d+$/);
  assert.deepEqual(env, before, 'the caller environment and its no-fallback policy remain unchanged');
});

test('non-npm installs and read-only queries keep the caller tool environment', async () => {
  const env = { PATH: '/custom/mise/shims:/custom/bin', MISE_AUTO_INSTALL: 'true', MISE_NOT_FOUND_SYSTEM_FALLBACK: 'true' };
  const calls = [];
  const ctx = { env, home: '/home/fixture', dataDir: '/custom/mise', miseBin: 'mise', timeouts: { install: 5000, mise: 5000 }, run: async (argv, options) => {
    calls.push({ argv, env: options.env });
    return { code: 0, stdout: '2.2.7\n', stderr: '' };
  } };
  await use(ctx, 'node', '26.13.0');
  await latest(ctx, 'npm:@opencode/cli');
  assert.equal(calls[0].env.PATH, env.PATH);
  assert.equal(calls[0].env.MISE_NOT_FOUND_SYSTEM_FALLBACK, 'true');
  assert.equal(calls[1].env.PATH, env.PATH);
  assert.equal(calls[1].env.MISE_NOT_FOUND_SYSTEM_FALLBACK, 'false');
  assert.equal(calls[0].env.MISE_AUTO_INSTALL, 'false');
  assert.equal(calls[1].env.MISE_AUTO_INSTALL, 'false');
});
