import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 't3-opencode-auth-cli-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const executable = path.join(home, 'opencode'), resolver = path.join(home, 'provider.mjs');
  const modeFile = path.join(home, 'mode.json'), calls = path.join(home, 'calls.jsonl');
  await fs.writeFile(executable, `#!${process.execPath}
import * as fs from 'node:fs/promises';
const mode=JSON.parse(await fs.readFile(${JSON.stringify(modeFile)},'utf8'));
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log(mode.version);process.exit(0)}
await fs.appendFile(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(mode.fail){console.error('private-cli-sentinel');process.exit(1)}
if(args[1]==='list')console.log(JSON.stringify(mode.list||[]));
`, { mode: 0o700 });
  await fs.writeFile(resolver, `console.log(${JSON.stringify(executable)});`);
  const env = { ...process.env, HOME: home, T3_INFRA_NODE: process.execPath, T3_PROVIDER_CLI: resolver,
    T3_HARNESS_MODULE: path.join(root, 'docker/harness/index.mjs'),
    T3_STEP_DOWN_LIB: path.join(root, 'docker/lib'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache') };
  for (const key of Object.keys(env)) if (/TOKEN|API_KEY|^OPENCODE/.test(key)) delete env[key];
  return { home, env, calls, mode: (value) => fs.writeFile(modeFile, JSON.stringify(value)) };
}

test('t3-login forwards V2 targets with a TTY, uses the V1 picker and rejects unknown syntax', async (t) => {
  const f = await fixture(t);
  const command = ['bash', path.join(root, 'docker/bin/t3-login'), 'opencode', 'anthropic', '--method', 'key'].map(quote).join(' ');
  const login = () => exec('script', ['-q', '-e', '-c', command, '/dev/null'], { env: f.env, timeout: 10000 });
  await f.mode({ version: 'opencode v2.0.18' }); await login();
  await f.mode({ version: '1.19.3' }); assert.match((await login()).stdout, /interactive picker/);
  assert.deepEqual((await fs.readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse), [
    ['auth', 'login', 'anthropic', '--method', 'key'], ['auth', 'login'],
  ]);
  await f.mode({ version: 'unknown' });
  await assert.rejects(login(), (error) => /could not check OpenCode/.test(error.stdout));
  assert.equal((await fs.readFile(f.calls, 'utf8')).trim().split('\n').length, 2);
});

test('doctor reports the native store and distinguishes unreadable state from signed out', async (t) => {
  const f = await fixture(t), source = await fs.readFile(path.join(root, 'docker/bin/t3-doctor'), 'utf8');
  const extract = (name) => source.slice(source.indexOf(name + '() {'), source.indexOf('\n}', source.indexOf(name + '() {')) + 2);
  const command = "ok() { printf '%s\\n' \"$2\"; }; warn() { printf '%s\\n' \"$2\"; };\n" +
    extract('managed_bin') + '\n' + extract('cred_opencode') + '\nopencode_version=$TEST_VERSION\ncred_opencode';
  const doctor = (version) => exec('bash', ['-c', command], { env: { ...f.env, TEST_VERSION: version }, timeout: 10000 }).then((result) => result.stdout.trim());
  await fs.mkdir(path.join(f.env.XDG_DATA_HOME, 'opencode'), { recursive: true });
  await fs.writeFile(path.join(f.env.XDG_DATA_HOME, 'opencode/auth.json'), '{"deepseek":{"type":"api","key":"legacy-fixture"}}');
  await f.mode({ list: [{ id: 'anthropic', connections: [{ type: 'credential', id: 'cred_work' }] }] });
  assert.equal(await doctor('1.19.3'), 'signed in (1 provider: deepseek)');
  assert.equal(await doctor('2.0.18'), 'signed in (1 provider: anthropic)');
  await f.mode({ list: [{ id: 'anthropic', connections: [{ type: 'env', name: 'ANTHROPIC_API_KEY' }] }] });
  assert.equal(await doctor('2.0.18'), 'not signed in');
  await f.mode({ fail: true });
  assert.equal(await doctor('2.0.18'), 'sign-in state not readable');
  assert.equal(await doctor('unknown'), 'sign-in state not readable');
  const calls = (await fs.readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.every((args) => args.join(' ') === 'auth list --format json --standalone'));
});
