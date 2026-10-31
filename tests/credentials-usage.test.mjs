import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { credentialMentions, createCredentialUsage } from '../docker/setup/credentials/usage.mjs';

test('mentions honor quoted and unquoted names with exact command and name boundaries', () => {
  assert.deepEqual([...credentialMentions(`t3-ssh build-server -- uptime\nt3-api 'project-api' GET me\n	t3-api "another-key" GET me\n`) ], ['build-server', 'project-api', 'another-key']);
  assert.deepEqual([...credentialMentions('not3-api nope\nx-t3-api nope\nt3-api Bad\nt3-api "quoted-mismatch\nt3-api missing-\nt3-api missing_\nt3-api foo-bar-baz2')], ['foo-bar-baz2']);
});

test('seven-provider scans deduplicate shared real files, include instructions and cache with invalidation', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'credential-usage-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const real = path.join(home, 'shared', 'deploy', 'SKILL.md'); await fs.mkdir(path.dirname(real), { recursive: true });
  await fs.writeFile(real, '---\nname: deploy\ndescription: Deploy from a shared skill.\n---\nt3-ssh build-server -- uptime');
  let scans = 0, reads = 0, at = 1000;
  const usage = createCredentialUsage({ home, clock: () => at, installed: async () => ['claude', 'codex'],
    scan: async provider => { scans++; return { skills: [{ path: real, resolvedPath: real }], warnings: provider === 'muse' ? ['limited'] : [] }; },
    readFile: async (file, limit, io) => { reads++; assert.equal(limit, 65536); return { content: await io.readFile(file, 'utf8'), bytes: 100 }; },
    instructions: async () => ({ content: 't3-api project-api GET me' }),
  });
  const one = await usage.annotate([{ id: 'build-server' }, { id: 'project-api' }]);
  assert.deepEqual(one.credentials[0].usedIn, [{ kind: 'skill', name: 'deploy', where: 'All agents' }]);
  assert.deepEqual(one.credentials[1].usedIn, [{ kind: 'instructions', name: 'Global instructions' }]);
  assert.equal(scans, 7); assert.equal(reads, 1); assert.equal(one.usageWarnings.length, 1);
  await usage.annotate([]); assert.equal(scans, 7);
  at += 16000; await usage.annotate([]); assert.equal(scans, 14);
  usage.invalidate(); await usage.annotate([]); assert.equal(scans, 21);
});

test('failed and incomplete scans are visible instead of claiming a credential is unused', async () => {
  const usage = createCredentialUsage({ scan: async provider => { if (provider === 'claude') throw new Error('unreadable'); return { skills: [{ path: '/unreadable', error: 'denied' }], warnings: [] }; }, instructions: async () => ({ error: 'denied' }) });
  const result = await usage.annotate([{ id: 'build-server' }]); assert.deepEqual(result.credentials[0].usedIn, []); assert.ok(result.usageWarnings.length >= 2);
});
