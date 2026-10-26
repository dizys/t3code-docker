// Real setup API in an empty disposable home, shared by HTTP and UI checks.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export async function credentialsFixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 't3-server-credentials-'));
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening'); const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = { ...process.env, HOME: home, T3CODE_HOME: path.join(home, '.t3'), T3_WORKSPACE: path.join(home, 'workspace'),
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    MISE_DATA_DIR: path.join(home, '.local/share/mise'), MISE_STATE_DIR: path.join(home, '.local/state/mise'), MISE_CONFIG_DIR: path.join(home, '.config/mise'),
    T3_SETUP_PORT: String(port), T3_SETUP_KEY: 'credential-fixture-key', T3_SETUP_KEY_SOURCE: 'env', T3_INFRA_LAUNCHER: '/bin/false', T3CODE_PORT: '1', T3_SETUP_ACCEPT_T3_SESSIONS: '0' };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../docker/setup/server.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  const closed = once(child, 'close'), base = 'http://127.0.0.1:' + port + '/__setup';
  const request = (route, body, headers = {}) => fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-t3-setup-key': 'credential-fixture-key', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed; await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  try {
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(logs);
      try { if ((await request('/hello')).ok) return { home, env, base, request, close, logs: () => logs }; } catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Credential fixture did not start.');
  } catch (error) { await close(); throw error; }
}
