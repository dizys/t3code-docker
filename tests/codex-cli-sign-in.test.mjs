import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { authFixture } from './fixtures/opencode-auth.mjs';

const settingsFile = (f) => path.join(f.home, '.t3/userdata/settings.json');
const managed = {
  theme: 'dark',
  providerInstances: {
    codex: { driver: 'codex', enabled: true, config: { setupMode: 'managed', model: 'm' } },
    'codex-personal': { driver: 'codex', config: { setupMode: 'managed' } },
  },
};
const codexFacts = (f, authenticated) => ({ codex: {
  id: 'codex', name: 'Codex', installed: true, configured: true, runnable: true, installedVersion: '0.166.0',
  executable: f.executable, authenticated,
} });
const codexRow = async (f) => (await (await f.request('/harnesses')).json()).harnesses.find((row) => row.id === 'codex');

test('native connection changes are visible on a warm Setup cache without probing every agent', { timeout: 30000 }, async t => {
  const f=await authFixture();t.after(f.close);
  await fs.mkdir(path.dirname(settingsFile(f)),{recursive:true});
  const existing=structuredClone(managed);existing.providerInstances.codex.config.setupMode='existing';
  await fs.writeFile(settingsFile(f),JSON.stringify(existing));
  await f.facts(codexFacts(f,true));
  const warm=await f.request('/auth/use-cli',{agent:'codex'});
  assert.equal(warm.status,200);
  assert.equal((await warm.json()).changed,false);
  assert.equal((await codexRow(f)).t3OwnSignIn,false,'warm the cache while T3 uses the CLI');
  // T3 Code or a terminal can change this file without calling Setup's APIs.
  await fs.writeFile(settingsFile(f),JSON.stringify(managed));
  assert.equal((await codexRow(f)).t3OwnSignIn,true,'the next poll must see T3 managing its own connection');
  const switched=await f.request('/auth/use-cli',{agent:'codex'});
  assert.equal(switched.status,200);
  assert.equal((await switched.json()).changed,true);
  assert.equal((await codexRow(f)).t3OwnSignIn,false);
});

test('an unreadable sign-in for a new executable cannot reuse the old executable verdict', { timeout: 30000 }, async t => {
  const f=await authFixture();t.after(f.close);
  await fs.mkdir(path.dirname(settingsFile(f)),{recursive:true});
  const existing=structuredClone(managed);existing.providerInstances.codex.config.setupMode='existing';
  await fs.writeFile(settingsFile(f),JSON.stringify(existing));
  await f.facts(codexFacts(f,true));
  assert.equal((await f.request('/auth/use-cli',{agent:'codex'})).status,200);
  assert.equal((await codexRow(f)).signedIn,true);
  const changed=codexFacts(f,null);changed.codex.installedVersion='0.167.0';changed.codex.executable=f.executable+'.new';
  await f.facts(changed);
  assert.equal((await codexRow(f)).signedIn,null,'the changed installation has no verdict yet');
  assert.equal((await codexRow(f)).signedIn,null,'an inconclusive refresh cannot carry a verdict across executables');
});

test('Setup points T3 Code at the CLI sign-in only when asked, and only with one to use', { timeout: 30000 }, async (t) => {
  const f = await authFixture(); t.after(f.close);
  await fs.mkdir(path.dirname(settingsFile(f)), { recursive: true });
  await fs.writeFile(settingsFile(f), JSON.stringify(managed));
  await f.facts(codexFacts(f, false));

  assert.equal((await fetch(f.base + '/auth/use-cli', { method: 'POST', body: '{"agent":"codex"}' })).status, 401);
  assert.equal((await f.request('/auth/use-cli', { agent: 'codex' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.request('/auth/use-cli', { agent: 'nobody' })).status, 400);

  // Nothing to switch to: the CLI is asked, and the settings stay as they are.
  const signedOut = await f.request('/auth/use-cli', { agent: 'codex' });
  assert.equal(signedOut.status, 400);
  assert.match((await signedOut.json()).error, /Sign in to Codex first/);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile(f), 'utf8')), managed);
  assert.equal((await codexRow(f))?.t3OwnSignIn, true, 'the row says T3 Code uses its own connection');

  await f.facts(codexFacts(f, true));
  const switched = await f.request('/auth/use-cli', { agent: 'codex' });
  assert.equal(switched.status, 200);
  const body = await switched.json();
  assert.equal(body.ok, true);
  assert.equal(body.changed, true);
  assert.equal(body.warning, undefined);
  const written = JSON.parse(await fs.readFile(settingsFile(f), 'utf8'));
  assert.equal(written.theme, 'dark');
  assert.equal(written.providerInstances.codex.config.setupMode, 'existing');
  assert.equal(written.providerInstances.codex.config.model, 'm');
  assert.match(written.providerInstances.codex.config.binaryPath, /codex$/, 'T3 Code runs the Codex installed here');
  assert.deepEqual(written.providerInstances['codex-personal'], managed.providerInstances['codex-personal']);
  assert.equal((await codexRow(f)).t3OwnSignIn, false, 'the very next read reflects the switch');

  const again = await (await f.request('/auth/use-cli', { agent: 'codex' })).json();
  assert.equal(again.changed, false);

  // A settings file nobody can parse is never overwritten.
  await fs.writeFile(settingsFile(f), '{ not json');
  const refused = await f.request('/auth/use-cli', { agent: 'codex' });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /settings could not be changed/);
  assert.equal(await fs.readFile(settingsFile(f), 'utf8'), '{ not json');
});
