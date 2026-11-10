#!/usr/bin/env node
// Own the disposable preview lifecycle so local and CI audits cannot leave a
// background server behind. No production endpoint or credential is used.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const server = spawn(process.execPath, ['scripts/console-preview.mjs', '--port', String(port)], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'ignore', 'pipe'] });
let output = ''; server.stderr.on('data', chunk => { output += chunk; });
try {
  const url = `http://127.0.0.1:${port}/__setup/`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(url)).ok; } catch {}
    if (ready) break;
    if (server.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!ready) throw new Error('Disposable console did not start.');
  const audit = spawn(process.execPath, ['scripts/access-ui-audit.js', url, 'dev'], { cwd: new URL('..', import.meta.url), stdio: 'inherit' });
  process.exitCode = (await once(audit, 'exit'))[0] ?? 1;
} finally { server.kill('SIGTERM'); if (server.exitCode === null) await once(server, 'exit'); }
