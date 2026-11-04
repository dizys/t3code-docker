import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uniqueName } from '../docker/setup/files/entries.mjs';

const execute = promisify(execFile);

test('long extensions fail without blocking the Setup event loop', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 't3-unique-name-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const name = 'a.' + 'x'.repeat(253);
  await fs.writeFile(path.join(directory, name), 'keep');
  // A subprocess timeout catches the old synchronous infinite loop safely.
  const source = `
    import assert from 'node:assert/strict';
    import { uniqueName } from ${JSON.stringify(new URL('../docker/setup/files/entries.mjs', import.meta.url).href)};
    const [directory, name] = process.argv.slice(1);
    for (const options of [{}, { suffix: 'copy' }, { reserved: new Set([name]) }]) {
      await assert.rejects(uniqueName(directory, name, options), { code: 'invalid' });
    }
  `;
  await execute(process.execPath, ['--input-type=module', '-e', source, directory, name], { timeout: 5000, killSignal: 'SIGKILL' });
  assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), 'keep');
});

test('collision names preserve ordinary extensions and multibyte characters', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 't3-unique-name-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of ['note.txt', 'é'.repeat(125) + '.txt']) {
    const next = await uniqueName(directory, name, { reserved: new Set([name]) });
    assert.ok(Buffer.byteLength(next) <= 255);
    assert.ok(next.isWellFormed());
    assert.match(next, / \(2\)\.txt$/);
  }
});
