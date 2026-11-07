import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGatewayProcesses } from '../docker/setup/gateways/processes.mjs';

const MARK = 'T3_GATEWAY_INSTANCE=codex_gw_proxy';

async function fakeProc(t, rows) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 't3-gw-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [pid, argv, env] of rows) {
    await fs.mkdir(path.join(root, String(pid)));
    await fs.writeFile(path.join(root, String(pid), 'cmdline'), argv.join('\0') + '\0');
    await fs.writeFile(path.join(root, String(pid), 'environ'), env.join('\0') + '\0');
  }
  await fs.mkdir(path.join(root, 'sys'));
  return root;
}
const harness = (proc, alive = new Set()) => {
  const signals = [];
  // A signalled process leaves /proc, unless it's one that ignores the request.
  return { signals, processes: createGatewayProcesses({ proc, self: 1, wait: async () => {}, kill: (pid, name) => { signals.push([pid, name]); if (!alive.has(pid)) rmSync(path.join(proc, String(pid)), { recursive: true, force: true }); } }) };
};

test('only the agent itself is stopped, not what it started', async t => {
  const proc = await fakeProc(t, [
    [100, ['/mise/codex', 'app-server', '-c', 'model_provider="x"'], [MARK, 'HOME=/h']],
    [101, ['/bin/sh', '-c', 'trap'], [MARK]],
    [102, ['/usr/bin/node', 'server.js', '--port', '3000'], [MARK]],
    [103, ['/mise/codex', 'exec', 'hello'], [MARK]],
  ]);
  const { signals, processes } = harness(proc);
  assert.equal(await processes.stop('codex', 'codex_gw_proxy'), 1);
  assert.deepEqual(signals, [[100, 'SIGTERM']]);
});

test('a direct instance has no marker and can never match', async t => {
  const proc = await fakeProc(t, [[100, ['/mise/codex', 'app-server'], ['HOME=/h']], [101, ['/mise/codex', 'app-server'], ['T3_GATEWAY_INSTANCE=codex_gw_other']]]);
  const { signals, processes } = harness(proc);
  assert.equal(await processes.stop('codex', 'codex_gw_proxy'), 0);
  assert.deepEqual(signals, []);
});

test('a marker must match whole, so one gateway’s name can’t reach another’s', async t => {
  const proc = await fakeProc(t, [[100, ['/mise/codex', 'app-server'], ['T3_GATEWAY_INSTANCE=codex_gw_proxy-2']]]);
  const { signals, processes } = harness(proc);
  await processes.stop('codex', 'codex_gw_proxy');
  assert.deepEqual(signals, []);
});

test('each agent is recognised by its own command', async t => {
  const proc = await fakeProc(t, [
    [100, ['/mise/installs/claude/2.1.318/claude', '--output-format', 'stream-json'], ['T3_GATEWAY_INSTANCE=claudeAgent_gw_p']],
    [101, ['/bin/sh', '-c', 'claude --version'], ['T3_GATEWAY_INSTANCE=claudeAgent_gw_p']],
    [102, ['/mise/@opencode+cli/bin/opencode.exe', 'serve', '--hostname', '127.0.0.1'], ['T3_GATEWAY_INSTANCE=opencode_gw_p']],
    [103, ['/mise/@opencode+cli/bin/opencode.exe', 'run', 'hi'], ['T3_GATEWAY_INSTANCE=opencode_gw_p']],
  ]);
  const { signals, processes } = harness(proc);
  await processes.stop('claude', 'claudeAgent_gw_p');
  await processes.stop('opencode', 'opencode_gw_p');
  assert.deepEqual(signals, [[100, 'SIGTERM'], [102, 'SIGTERM']]);
});

test('this service never stops itself', async t => {
  const proc = await fakeProc(t, [[1, ['/mise/codex', 'app-server'], [MARK]]]);
  const { signals, processes } = harness(proc);
  await processes.stop('codex', 'codex_gw_proxy');
  assert.deepEqual(signals, []);
});

test('Pi RPC and Grok stdio match only marked agent commands, not tool processes or direct instances', async t => {
  const pi = ['T3_GATEWAY_INSTANCE=pi_gw_p'], grok = ['T3_GATEWAY_INSTANCE=grok_gw_p'];
  const proc = await fakeProc(t, [
    [100, ['/usr/bin/node', '/mise/node_modules/@earendil-works/pi-coding-agent/dist/cli.js', '--mode', 'rpc'], pi],
    [101, ['/mise/node_modules/.bin/pi', '--mode', 'rpc'], pi],
    [102, ['/usr/bin/node', 'server.js', 'rpc'], pi],
    [103, ['/mise/pi', '--print', 'rpc'], []],
    [104, ['/mise/pi', '--mode', 'rpc'], ['T3_GATEWAY_INSTANCE=pi_gw_other']],
    [105, ['/mise/grok', '--permission-mode', 'default', 'agent', 'stdio'], grok],
    [106, ['/mise/grok', 'agent', '--always-approve', 'stdio'], grok],
    [107, ['/bin/sh', '-c', 'grok agent stdio'], grok],
    [108, ['/mise/grok', 'models'], grok],
    [109, ['/mise/grok', 'agent', 'stdio'], []],
    [110, ['/mise/pi', '--print', 'rpc'], pi],
    [111, ['/usr/bin/node', '/project/pi/server.js', '--mode', 'rpc'], pi],
  ]);
  const { signals, processes } = harness(proc);
  await processes.stop('pi', 'pi_gw_p');
  await processes.stop('grok', 'grok_gw_p');
  assert.deepEqual(signals, [[100, 'SIGTERM'], [101, 'SIGTERM'], [105, 'SIGTERM'], [106, 'SIGTERM']]);
});

test('a process that ignores the request is ended after a grace period', async t => {
  const proc = await fakeProc(t, [[100, ['/mise/codex', 'app-server'], [MARK]]]);
  const { signals, processes } = harness(proc, new Set([100]));
  await processes.stop('codex', 'codex_gw_proxy');
  assert.deepEqual(signals, [[100, 'SIGTERM'], [100, 'SIGKILL']]);
});

test('a process that vanishes mid-scan is not an error', async t => {
  const proc = await fakeProc(t, [[100, ['/mise/codex', 'app-server'], [MARK]]]);
  await fs.rm(path.join(proc, '100/environ'));
  const { processes } = harness(proc);
  assert.equal(await processes.stop('codex', 'codex_gw_proxy'), 0);
  assert.equal(await createGatewayProcesses({ proc: path.join(proc, 'missing') }).stop('codex', 'x'), 0);
});
