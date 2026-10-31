// OpenSSH closes inherited descriptors. A private FIFO separates its own
// diagnostics from a remote command's stderr without retaining a raw log.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execute } from './hostkeys.mjs';
import { outputFilter } from './redact.mjs';

export async function createSshDiagnostics(secret, write = () => {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 't3-ssh-test-'));
  const file = path.join(directory, 'diagnostics');
  let handle, ended = false, text = '';
  try {
    await fs.chmod(directory, 0o700);
    const answer = await execute('/usr/bin/mkfifo', ['-m', '600', '--', file]);
    if (answer.code !== 0) throw new Error('Could not prepare SSH diagnostics');
    handle = await fs.open(file, constants.O_RDWR | constants.O_NONBLOCK);
    const filter = outputFilter(secret, value => { text = (text + value).slice(-65536); write(value); });
    const reading = (async () => {
      const buffer = Buffer.alloc(8192), decoder = new TextDecoder();
      try {
        while (true) {
          let length = 0;
          try { length = (await handle.read(buffer, 0, buffer.length, null)).bytesRead; }
          catch (error) { if (error.code !== 'EAGAIN') throw error; }
          if (length) filter.write(decoder.decode(buffer.subarray(0, length), { stream: true }));
          else if (ended) break;
          else await new Promise(resolve => setTimeout(resolve, 10));
        }
      } finally { filter.write(decoder.decode()); filter.end(); }
    })();
    // Prevent an unhandled rejection while the child is still running.
    void reading.catch(() => {});
    return { file, async close() {
      ended = true;
      try { await reading; return text; }
      finally { await handle.close(); await fs.rm(directory, { force: true, recursive: true }); }
    } };
  } catch (error) { await handle?.close(); await fs.rm(directory, { force: true, recursive: true }); throw error; }
}
