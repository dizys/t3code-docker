import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { credentialMentions, sshMentions, createCredentialUsage } from '../docker/setup/credentials/usage.mjs';

test('mentions honor quoted and unquoted names with exact command and name boundaries', () => {
  assert.deepEqual([...credentialMentions(`t3-vault ssh build-server -- uptime\nt3-vault http 'project-api' GET me\n	t3-vault http "another-key" GET me\n`) ], ['build-server', 'project-api', 'another-key']);
  assert.deepEqual([...credentialMentions('not3-vault ssh nope\nx-t3-vault http nope\nt3-vault http Bad\nt3-vault http "quoted-mismatch\nt3-vault http missing-\nt3-vault http missing_\nt3-vault http foo-bar-baz2')], ['foo-bar-baz2']);
});

test('every command that names a credential counts, and the ones that don\'t do not', () => {
  for (const command of ['ssh', 'http', 'show', 'test', 'replace', 'trust', 'use-key']) assert.deepEqual([...credentialMentions(`t3-vault ${command} one-name`)], ['one-name'], command);
  for (const line of ['t3-vault list', 't3-vault types', 't3-vault --help', 't3-vault add new-name --secret-file x', 't3-vault rm old-name --yes', 'vault ssh nope']) assert.deepEqual([...credentialMentions(line)], [], line);
});

test('t3-vault run counts every name before the command, including renamed and quoted ones', () => {
  assert.deepEqual([...credentialMentions('t3-vault run cloudflare-token -- wrangler deploy')], ['cloudflare-token']);
  assert.deepEqual([...credentialMentions('t3-vault run one two=OTHER_NAME "three" \'four=VAR\' -- env')], ['one', 'two', 'three', 'four']);
  assert.deepEqual([...credentialMentions('t3-vault run one -- ssh not-a-mention\nt3-vault run two -- x')], ['one', 'two']);
  assert.deepEqual([...credentialMentions('t3-vault run one | sed x-y\nt3-vault run NAME -- x\nt3-vault run good Bad later -- x')], ['one', 'good'], 'the names stop at the first thing that isn\'t one');
});

test('plain ssh mentions find a bare host, and nothing that only looks like one', () => {
  assert.deepEqual([...sshMentions('ssh build-server uptime\n  ssh "quoted-box" true\nrun: ssh tail-box')], ['build-server', 'quoted-box', 'tail-box']);
  for (const line of ['ssh user@host', 'ssh host.example.com', 'ssh host:22', 'ssh -i key host', 'openssh server', 'x-ssh nope', 'ssh Bad', 'ssh-keygen -t ed25519']) assert.deepEqual([...sshMentions(line)], [], line);
});

test('seven-provider scans deduplicate shared real files, include instructions and cache with invalidation', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'credential-usage-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const real = path.join(home, 'shared', 'deploy', 'SKILL.md'); await fs.mkdir(path.dirname(real), { recursive: true });
  await fs.writeFile(real, '---\nname: deploy\ndescription: Deploy from a shared skill.\n---\nt3-vault ssh build-server -- uptime');
  let scans = 0, reads = 0, at = 1000;
  const usage = createCredentialUsage({ home, clock: () => at, installed: async () => ['claude', 'codex'],
    scan: async provider => { scans++; return { skills: [{ path: real, resolvedPath: real }], warnings: provider === 'muse' ? ['limited'] : [] }; },
    readFile: async (file, limit, io) => { reads++; assert.equal(limit, 65536); return { content: await io.readFile(file, 'utf8'), bytes: 100 }; },
    instructions: async () => ({ content: 't3-vault http project-api GET me' }),
  });
  const one = await usage.annotate([{ id: 'build-server' }, { id: 'project-api' }]);
  assert.deepEqual(one.credentials[0].usedIn, [{ kind: 'skill', name: 'deploy', where: 'All agents' }]);
  assert.deepEqual(one.credentials[1].usedIn, [{ kind: 'instructions', name: 'Global instructions' }]);
  assert.equal(scans, 7); assert.equal(reads, 1); assert.equal(one.usageWarnings.length, 1);
  await usage.annotate([]); assert.equal(scans, 7);
  at += 16000; await usage.annotate([]); assert.equal(scans, 14);
  usage.invalidate(); await usage.annotate([]); assert.equal(scans, 21);
});

test('a skill that says plain ssh NAME only counts for an SSH credential of that name', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'credential-usage-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const skill = path.join(home, 'ops', 'SKILL.md'); await fs.mkdir(path.dirname(skill), { recursive: true });
  await fs.writeFile(skill, '---\nname: ops\ndescription: Operations.\n---\nssh access is required. Then: ssh build-server uptime and t3-vault run cloudflare-token -- wrangler');
  const usage = createCredentialUsage({ home, installed: async () => [], scan: async () => ({ skills: [{ path: skill, resolvedPath: skill }], warnings: [] }),
    readFile: async (file, _limit, io) => ({ content: await io.readFile(file, 'utf8'), bytes: 100 }), instructions: async () => ({ content: 'ssh instruction-box true' }) });
  const { credentials } = await usage.annotate([{ id: 'build-server', type: 'ssh' }, { id: 'access', type: 'token' }, { id: 'cloudflare-token', type: 'token' }, { id: 'instruction-box', type: 'ssh' }]);
  const used = Object.fromEntries(credentials.map(row => [row.id, row.usedIn]));
  assert.deepEqual(used['build-server'].map(item => item.name), ['ops']);
  assert.deepEqual(used.access, [], 'the word "access" after ssh is not this token');
  assert.deepEqual(used['cloudflare-token'].map(item => item.name), ['ops']);
  assert.deepEqual(used['instruction-box'], [{ kind: 'instructions', name: 'Global instructions' }]);
  assert.equal(JSON.stringify(used).includes('sshOnly'), false, 'bookkeeping stays on the server');
});

test('failed and incomplete scans are visible instead of claiming a credential is unused', async () => {
  const usage = createCredentialUsage({ scan: async provider => { if (provider === 'claude') throw new Error('unreadable'); return { skills: [{ path: '/unreadable', error: 'denied' }], warnings: [] }; }, instructions: async () => ({ error: 'denied' }) });
  const result = await usage.annotate([{ id: 'build-server' }]); assert.deepEqual(result.credentials[0].usedIn, []); assert.ok(result.usageWarnings.length >= 2);
});
