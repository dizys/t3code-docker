import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { injectSetupBridge, refreshSetupBridge } from '../docker/runtime/client-shell.mjs';

const bridge = '// data-t3-setup-entry\nconst currentBridge = true;';
test('only the image-owned marked bridge is replaced, idempotently', () => {
  const shell = '<html><body><script src="/assets/native.js"></script><script data-t3-setup-bridge>oldModal()</script>\n</body></html>';
  const next = injectSetupBridge(shell, bridge);
  assert(next.includes('<script src="/assets/native.js"></script>'));
  assert(!next.includes('oldModal'));
  assert.equal(next.match(/data-t3-setup-bridge/g).length, 1);
  assert.equal(injectSetupBridge(next, bridge), next);
  for (const source of ['<body>no closing body', '<body>data-t3-setup-bridge</body>']) assert.throws(() => injectSetupBridge(source, bridge));
  assert.throws(() => injectSetupBridge('<body></body>', bridge + '</SCRIPT>'));
});

test('a retained runtime receives current navigation without changing runtime or preferences', async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 't3-client-refresh-'));
  t.after(() => fs.rm(dir, {recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'client'));
  const shell = path.join(dir,'client/index.html'), source = path.join(dir,'bridge.js');
  await fs.writeFile(shell, '<body><script data-t3-setup-bridge>oldModal()</script></body>');
  await fs.writeFile(source, bridge);
  await fs.writeFile(path.join(dir,'t3'), 'runtime bytes');
  await fs.writeFile(path.join(dir,'preferences.json'), '{"keep":"exact"}');
  const runtime = {binary:path.join(dir,'t3'),bundled:false};
  assert.equal(await refreshSetupBridge(runtime, source), true);
  assert.equal(await refreshSetupBridge(runtime, source), false);
  assert.equal(await fs.readFile(path.join(dir,'t3'),'utf8'), 'runtime bytes');
  assert.equal(await fs.readFile(path.join(dir,'preferences.json'),'utf8'), '{"keep":"exact"}');
  assert.equal(await refreshSetupBridge({...runtime,bundled:true}, '/missing'), false);
  await fs.writeFile(source, 'invalid bridge');
  const before = await fs.readFile(shell, 'utf8');
  await assert.rejects(refreshSetupBridge(runtime, source));
  assert.equal(await fs.readFile(shell,'utf8'), before);
  assert(!(await fs.readdir(path.join(dir,'client'))).some(name=>name.endsWith('.tmp')));
});
