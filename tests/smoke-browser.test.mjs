// Exercise the shipping audit staging function through a filesystem-backed
// Docker transport. A local audit can pass while CI is missing one of its
// modules; resolve the actual copied dependency graph before accepting it.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('the image smoke test stages Skills and Files audits with their complete dependency graphs', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-smoke-browser-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = await fs.readFile(new URL('../scripts/smoke-test.sh', import.meta.url), 'utf8');
  const body = name => {
    const value=source.match(new RegExp('^'+name+'\\(\\) \\{[\\s\\S]*?^\\}','m'))?.[0];
    assert.ok(value, 'the shipping smoke function exists');return value;
  };
  const container = path.join(root, 'container'), log = path.join(root, 'audits.jsonl');
  const transport = path.join(root, 'docker.cjs');
  await fs.writeFile(transport, `
const fs = require('node:fs'), path = require('node:path'), { createRequire } = require('node:module');
const args = process.argv.slice(2), root = process.env.SMOKE_CONTAINER;
const inside = file => path.join(root, file);
if (args[0] === 'cp') {
  if (args[1].endsWith(process.env.SMOKE_DROP_FILE || '\\0')) process.exit(0);
  const from = args[1]; let to = inside(args[2].split(':').slice(1).join(':'));
  if (fs.existsSync(to) && fs.statSync(to).isDirectory()) to = path.join(to, path.basename(from));
  fs.cpSync(from, to, { recursive: true });
} else if (args[0] === 'exec') {
  let index = 1;
  while (args[index] === '-e') index += 2;
  const [command, ...rest] = args.slice(index + 1);
  if (command === 'mkdir') {
    for (const directory of rest.filter(value => value !== '-p')) fs.mkdirSync(inside(directory), { recursive: true });
  } else if (command === 'node') {
    const audit = inside(rest[0]), seen = new Set();
    const inspect = file => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/require\\(['"](\\.[^'"]+)['"]\\)/g)) inspect(createRequire(file).resolve(match[1]));
    };
    inspect(audit);
    require(path.join(path.dirname(audit),'lib/skills-fixtures.cjs')).createSkillsFixtures();
    fs.appendFileSync(process.env.SMOKE_AUDITS, JSON.stringify(path.basename(audit)) + '\\n');
  } else process.exit(9);
} else process.exit(9);
`);
  await fs.writeFile(path.join(root, 'docker'), `#!/bin/bash\nexec '${process.execPath}' '${transport}' "$@"\n`, { mode: 0o700 });
  const run = async (drop = '', name = 'skills_editor_works') => {
    await fs.rm(container, { recursive: true, force: true });
    await fs.rm(log, { force: true });
    await fs.mkdir(path.join(container, 'tmp'), { recursive: true });
    return spawnSync('bash', ['-c', `set -euo pipefail\nHAS_BROWSER=1\nNAME=fixture\nSETUP_KEY=fixture\nUI_AUDIT_LOG='${path.join(root, 'output.log')}'\n${body(name)}\n${name}`], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SMOKE_CONTAINER: container, SMOKE_AUDITS: log, SMOKE_DROP_FILE: drop },
    });
  };
  const result = await run();
  assert.equal(result.status, 0, await fs.readFile(path.join(root, 'output.log'), 'utf8'));
  assert.deepEqual((await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse), [
    'skills-ui-audit.js', 'skills-hooks-ui-audit.js', 'skills-update-ui-audit.js',
  ]);
  assert.notEqual((await run('skill-audit.cjs')).status, 0, 'a missing helper must fail the smoke audit');
  assert.notEqual((await run('skills-fixtures.cjs')).status, 0, 'a missing fixture module must fail the smoke audit');
  assert.notEqual((await run('files-fixtures.cjs')).status, 0, 'the shared Files fixture must be staged too');
  const files=await run('','files_browser_works');
  assert.equal(files.status,0,await fs.readFile(path.join(root,'output.log'),'utf8'));
  assert.deepEqual((await fs.readFile(log,'utf8')).trim().split('\n').map(JSON.parse),[
    'files-ui-audit.js','files-change-ui-audit.js','files-space-ui-audit.js','console-editor-ui-audit.js',
  ]);
  assert.notEqual((await run('console-download-fixture.cjs','files_browser_works')).status,0,'native download transport must be staged');
});
