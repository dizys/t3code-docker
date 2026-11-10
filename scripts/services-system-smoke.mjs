// Runs only inside scripts/test-services-e2e.sh's disposable image/volumes.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { serviceRequest } from '/opt/t3-services/client.mjs';
const exec = promisify(execFile), phase = process.argv[2] || 'prepare';
const root = '/var/lib/t3code/services/smoke-fixture';
const call = (domain, action, input = {}) => serviceRequest(domain, action, input);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ready = async domain => { for (let i = 0; i < 120; i++) { try { const value = await call(domain, 'snapshot'); if (!value.error) return value; } catch {} await pause(100); } throw new Error(domain + ' controller did not become available'); };
const apply = async (domain, request, expectedState = 'succeeded') => {
  const plan = await call(domain, 'plan', request), args = { planId: plan.id, expectedRevision: plan.expectedRevision, idempotencyKey: randomUUID(), acknowledgeAccessImpact: true };
  let operation = await call(domain, 'apply', args);
  assert.equal((await call(domain, 'apply', args)).id, operation.id);
  const deadline = Date.now() + 300000;
  while (!['succeeded', 'failed', 'rolled-back'].includes(operation.state) && Date.now() < deadline) { await pause(100); operation = await call(domain, 'operation', { id: operation.id }); }
  assert.equal(operation.state, expectedState, JSON.stringify({ state: operation.state, error: operation.error, code: operation.code }));
  return { plan, operation };
};
const saved = async (domain, id) => (await call(domain, 'snapshot')).services.find(row => row.id === id);
const edit = async (domain, id, action, configuration, expectedState) => { const value = await saved(domain, id); return apply(domain, { id, action, expectedRevision: value.revision, ...(configuration ? { configuration } : {}) }, expectedState); };
const custom = async () => {
  await ready('user');
  const code = `const fs=require('fs');console.log(JSON.stringify({uid:process.getuid(),groups:process.getgroups(),names:Object.keys(process.env),status:fs.readFileSync('/proc/self/status','utf8').split('\\n').filter(line=>/^(CapEff|CapPrm|CapAmb|NoNewPrivs):/.test(line))}));setInterval(()=>{},1000);`;
  const { plan } = await apply('user', { action: 'add', expectedRevision: 0, configuration: { name: 'Image smoke process', mode: 'executable', executable: '/usr/local/bin/node', argv: ['-e', code], cwd: '/tmp', enabled: true } });
  const logs = await call('user', 'logs', { id: plan.target }), facts = JSON.parse(logs.entries.find(item => item.text.startsWith('{"uid"')).text);
  assert.ok(facts.uid > 0); assert.ok(!facts.names.some(name => /^T3_(?:SETUP|SERVICES)/.test(name)));
  assert.ok(facts.status.some(line => /^NoNewPrivs:\s+1$/.test(line)));
  for (const name of ['CapEff', 'CapPrm', 'CapAmb']) assert.ok(facts.status.some(line => new RegExp('^' + name + ':\\s+0+$').test(line)));
  assert.ok(!facts.groups.includes(0));
  return plan.target;
};
if (phase === 'rootless') {
  const id = await custom();
  await assert.rejects(call('system', 'snapshot'));
  await edit('user', id, 'remove');
  console.log(JSON.stringify({ ok: true, arch: process.arch, checks: ['rootless custom process', 'no capabilities', 'no privilege escalation', 'system services unavailable'] }));
  process.exit(0);
}
await ready('system'); await ready('user');
if (phase === 'prepare') {
  await assert.rejects(fs.access('/usr/sbin/sshd'));
  await fs.mkdir(root, { mode: 0o700 });
  await exec('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', root + '/client']);
  const key = (await fs.readFile(root + '/client.pub', 'utf8')).trim();
  await assert.rejects(call('system', 'plan', { action: 'install', id: 'openssh', expectedRevision: 0, configuration: { keys: ['-----BEGIN PRIVATE KEY----- test-only'], enabled: true } }), error => !error.message.includes('test-only'));
  await apply('system', { action: 'install', id: 'openssh', expectedRevision: 0, configuration: { port: 22222, listen: '127.0.0.1', keys: [key], enabled: true } });
  const ssh = await saved('system', 'openssh');
  assert.equal(ssh.observation.state, 'ready');
  assert.equal(ssh.artifact.arch, process.arch === 'x64' ? 'amd64' : process.arch);
  const { stdout: known } = await exec('/usr/bin/ssh-keyscan', ['-p', '22222', '127.0.0.1'], { timeout: 10000 });
  await fs.writeFile(root + '/known_hosts', known, { mode: 0o600 });
  const { stdout: fingerprint } = await exec('/usr/bin/ssh-keygen', ['-lf', root + '/known_hosts']);
  assert.ok(fingerprint.includes(ssh.details.hostFingerprint));
  const args = ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + root + '/known_hosts', '-i', root + '/client', '-p', '22222'];
  const { stdout: uid } = await exec('/usr/bin/ssh', [...args, 't3@127.0.0.1', 'id', '-u'], { timeout: 10000 });
  assert.ok(Number(uid.trim()) > 0);
  await assert.rejects(exec('/usr/bin/ssh', [...args, 'root@127.0.0.1', 'true'], { timeout: 10000 }));
  await assert.rejects(exec('/usr/bin/ssh', [...args, '-o', 'PreferredAuthentications=password', 't3@127.0.0.1', 'true'], { timeout: 10000 }));
  const identity = '/var/lib/t3code/services/instances/openssh/identity/ed25519', publicIdentity = await fs.readFile(identity + '.pub', 'utf8');
  const privateDigest = () => fs.readFile(identity).then(bytes => createHash('sha256').update(bytes).digest('hex'));
  const originalIdentity = await privateDigest();
  await fs.writeFile(identity + '.pub', publicIdentity.trim().split(/\s+/).slice(0, 2).join(' ') + ' distinct public sidecar comment\n');
  await edit('system', 'openssh', 'restart');
  assert.equal((await saved('system', 'openssh')).details.hostFingerprint, ssh.details.hostFingerprint);
  await fs.rm(identity + '.pub'); await edit('system', 'openssh', 'restart');
  assert.equal((await saved('system', 'openssh')).details.hostFingerprint, ssh.details.hostFingerprint);
  assert.equal((await fs.readFile(identity + '.pub', 'utf8')).trim().split(/\s+/).length, 2);
  await fs.writeFile(identity + '.pub', key + '\n');
  await edit('system', 'openssh', 'restart', undefined, 'failed');
  assert.equal((await saved('system', 'openssh')).details.hostFingerprint, ssh.details.hostFingerprint);
  assert.equal(await fs.readFile(identity + '.pub', 'utf8'), key + '\n');
  assert.equal(await privateDigest(), originalIdentity);
  await fs.writeFile(identity + '.pub', publicIdentity); await edit('system', 'openssh', 'enable');
  // Exercise pinned connector extraction and real CLI compatibility without
  // authorizing an account or sending a token to a provider.
  const catalogue = JSON.parse(await fs.readFile('/opt/t3-services/catalogue.json', 'utf8'));
  await assert.rejects(fs.access('/home/t3/.t3/tools/cloudflared'));
  const shim = await exec('/usr/local/bin/cloudflared', ['--version']);
  assert.ok(shim.stdout.includes(catalogue.services.cloudflared.version));
  await assert.rejects(fs.access('/home/t3/.t3/tools/cloudflared'));
  await apply('system', { action: 'install', id: 'tailscale', expectedRevision: 0, configuration: { hostname: 'smoke-fixture', enabled: false } });
  const tail = await saved('system', 'tailscale');
  const { stdout: tailCli } = await exec(process.execPath, [fileURLToPath(new URL('./services-tailscale-cli-smoke.mjs', import.meta.url)), tail.artifact.path + '/tailscale'], { timeout: 30000 });
  process.stdout.write(tailCli);
  await edit('system', 'tailscale', 'uninstall');
  const token = 'services-test-canary-'.replaceAll('-', '_').repeat(6);
  await apply('system', { action: 'install', id: 'cloudflared', expectedRevision: 0, configuration: { token, enabled: false } });
  const cloud = await saved('system', 'cloudflared');
  assert.ok(!JSON.stringify(await call('system', 'snapshot')).includes(token));
  assert.ok((await exec(cloud.artifact.path + '/cloudflared', ['--version'])).stdout.includes(catalogue.services.cloudflared.version));
  await edit('system', 'cloudflared', 'uninstall');
  const id = await custom(); await edit('user', id, 'stop');
  const receipt = { id, fingerprint: ssh.details.hostFingerprint, artifact: ssh.artifact.digest, architecture: ssh.artifact.arch, sshRevision: ssh.revision };
  await fs.writeFile(root + '/receipt.json', JSON.stringify(receipt), { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, arch: process.arch, checks: ['no bundled SSH server', 'verified on-demand packages', 'dependency closure', 'key-only login', 'root denied', 'password denied', 'host fingerprint', 'public sidecar recovery', 'mismatched identity preserved and blocked', 'pinned connector extraction and CLI', 'read-only native adapter does not download', 'connector token privacy', 'actual unprivileged worker', 'temporary stop recorded'] }));
} else {
  const receipt = JSON.parse(await fs.readFile(root + '/receipt.json', 'utf8'));
  let ssh, user;
  for (let i = 0; i < 120; i++) { ssh = await saved('system', 'openssh'); user = await saved('user', receipt.id); if (ssh?.observation.state === 'ready' && user?.observation.state === 'running') break; await pause(100); }
  assert.equal(ssh.observation.state, 'ready'); assert.equal(user.observation.state, 'running');
  assert.equal(ssh.details.hostFingerprint, receipt.fingerprint); assert.equal(ssh.artifact.digest, receipt.artifact); assert.equal(ssh.artifact.arch, receipt.architecture);
  const { stdout: account } = await exec('/usr/bin/ssh', ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + root + '/known_hosts', '-i', root + '/client', '-p', '22222', 't3@127.0.0.1', 'id', '-u'], { timeout: 10000 });
  assert.equal(Number(account.trim()), Number(process.env.PUID || 1000));
  if (phase === 'recreate') {
    await edit('system', 'openssh', 'uninstall');
    const config = (await saved('system', 'openssh')).config;
    const executable = ssh.artifact.path + '/usr/sbin/sshd', original = await fs.readFile(executable);
    await fs.appendFile(executable, 'test-only-cache-tamper');
    await edit('system', 'openssh', 'edit', { port: config.port, listen: config.listen, keys: config.keys, enabled: true }, 'failed');
    assert.equal((await saved('system', 'openssh')).uninstalled, true);
    await fs.writeFile(executable, original);
    await edit('system', 'openssh', 'edit', { port: config.port, listen: config.listen, keys: config.keys, enabled: true });
    assert.equal((await saved('system', 'openssh')).details.hostFingerprint, receipt.fingerprint);
    await edit('user', receipt.id, 'remove'); await edit('system', 'openssh', 'uninstall');
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ok: true, phase, arch: process.arch, checks: ['same protected host identity', 'same artifact digest', 'boot reconciliation', 'stop-for-now resumes', ...(phase === 'recreate' ? ['changed PUID/PGID login', 'tampered cache rejected', 'offline cached reinstall', 'temporary test access removed'] : [])] }));
}
