import { FilesError } from './paths.mjs';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';

/** Directory names as raw bytes, on any runtime. Node streams `Dirent`
 * objects with a buffer `name`; other runtimes may hand back the name
 * buffers themselves, or lack buffer `opendir` entirely and fall back to
 * one `readdir`. Either way the result iterates `{ name: Buffer }` and
 * offers `close()` for `finally`, so the pinned-descriptor lookup and the
 * fatal UTF-8 decoding at the call sites stay exactly as they are. */
export async function opendirRaw(pinned) {
  try {
    const directory = await fs.opendir(pinned, { encoding: 'buffer', bufferSize: 64 });
    return {
      close: () => directory.close(),
      [Symbol.asyncIterator]: async function* () {
        for await (const entry of directory) yield { name: Buffer.isBuffer(entry) ? entry : entry.name };
      },
    };
  } catch (error) {
    if (error?.code !== 'ERR_INVALID_ARG_TYPE') throw error;
    const names = await fs.readdir(pinned, { encoding: 'buffer' });
    return {
      close: async () => {},
      [Symbol.asyncIterator]: async function* () { for (const name of names) yield { name: Buffer.from(name) }; },
    };
  }
}

// No shell, ever. Both the process deadline and captured output are bounded.
// CLIs that consume paths must put -- before them at their call site.
export function createCommandRunner(env = process.env) {
  return (file, args, { cwd, timeout = 5000, maxBuffer = 4 * 1024 * 1024, input, signal, env: extra = {} } = {}) => new Promise((resolve, reject) => {
    const child = execFile(file, args, { cwd, timeout, maxBuffer, env: { ...env, ...extra }, encoding: 'utf8', signal }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
    // A handled broken pipe is an ordinary failed CLI, not a server crash.
    child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? undefined : input);
  });
}

export function createLimiter(concurrency, maxWaiting = Infinity) {
  let active = 0; const waiting = [];
  const pump = () => {
    while (active < concurrency && waiting.length) {
      const { work, resolve, reject } = waiting.shift(); active++;
      Promise.resolve().then(work).then(resolve, reject).finally(() => { active--; pump(); });
    }
  };
  return work => new Promise((resolve, reject) => { if(waiting.length>=maxWaiting){reject(new FilesError('busy','Too many file operations are waiting. Let an operation finish before trying again.'));return;}waiting.push({ work, resolve, reject }); pump(); });
}

export async function mapLimit(values, limit, work) {
  const result = new Array(values.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) { const index = next++; result[index] = await work(values[index], index); }
  }));
  return result;
}
