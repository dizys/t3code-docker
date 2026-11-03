import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installVaultSkill, vaultSkillFolders } from '../docker/setup/credentials/skill.mjs';
import { skillMetadata } from '../docker/setup/skills.mjs';
import { credentialMentions } from '../docker/setup/credentials/usage.mjs';

const SKILL = fileURLToPath(new URL('../docker/setup/credentials/SKILL.md', import.meta.url));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-vault-skill-')), home = path.join(root, 'home'), source = path.join(root, 'SKILL.md'), stateFile = path.join(root, 'state', 'skill.json');
  await fs.mkdir(home); await fs.writeFile(source, 'version one\n');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: path.join(root, 'claude-config') };
  const install = (options = {}) => installVaultSkill({ home, env, stateFile, source, ...options });
  const files = () => vaultSkillFolders({ home, env }).map(folder => path.join(folder, 'SKILL.md'));
  const read = file => fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return { root, home, env, source, stateFile, install, files, read, publish: text => fs.writeFile(source, text) };
}

test('the folders are the ones that reach every agent, and follow CLAUDE_CONFIG_DIR', () => {
  const home = '/fixture/home';
  assert.deepEqual(vaultSkillFolders({ home }), ['/fixture/home/.claude/skills/t3-vault', '/fixture/home/.agents/skills/t3-vault', '/fixture/home/.gemini/config/skills/t3-vault']);
  assert.equal(vaultSkillFolders({ home, env: { CLAUDE_CONFIG_DIR: '/fixture/claude' } })[0], '/fixture/claude/skills/t3-vault');
  assert.equal(vaultSkillFolders({ home, env: { CLAUDE_CONFIG_DIR: 'relative/claude' } })[0], '/fixture/home/relative/claude/skills/t3-vault');
  assert.equal(vaultSkillFolders({ home, env: { CLAUDE_CONFIG_DIR: '   ' } })[0], '/fixture/home/.claude/skills/t3-vault');
});

test('it installs into all three folders, and remembers what it installed', async t => {
  const f = await fixture(t);
  await f.install();
  for (const file of f.files()) { assert.equal(await f.read(file), 'version one\n', file); assert.equal((await fs.stat(file)).mode & 0o777, 0o644, file); }
  assert.equal((await fs.stat(path.dirname(f.stateFile))).mode & 0o777, 0o700);
  for (const file of f.files()) assert.deepEqual((await fs.readdir(path.dirname(file))).filter(name => name !== 'SKILL.md'), [], 'no temporary file left');
  assert.deepEqual(Object.keys(JSON.parse(await f.read(f.stateFile))), ['digest']);
});

test('running again with nothing new changes nothing', async t => {
  const f = await fixture(t);
  await f.install();
  const times = await Promise.all(f.files().map(async file => (await fs.stat(file)).mtimeMs));
  await f.install();
  assert.deepEqual(await Promise.all(f.files().map(async file => (await fs.stat(file)).mtimeMs)), times);
});

test('an untouched copy gets the new version', async t => {
  const f = await fixture(t);
  await f.install();
  await f.publish('version two\n'); await f.install();
  for (const file of f.files()) assert.equal(await f.read(file), 'version two\n', file);
  await f.publish('version three\n'); await f.install();
  for (const file of f.files()) assert.equal(await f.read(file), 'version three\n', file);
});

test('an edited copy is left alone, then and on every later update', async t => {
  const f = await fixture(t), [edited, ...others] = f.files();
  await f.install();
  await fs.writeFile(edited, 'my own words\n');
  await f.publish('version two\n'); await f.install();
  assert.equal(await f.read(edited), 'my own words\n');
  for (const file of others) assert.equal(await f.read(file), 'version two\n', file);
  await f.publish('version three\n'); await f.install();
  assert.equal(await f.read(edited), 'my own words\n');
  for (const file of others) assert.equal(await f.read(file), 'version three\n', file);
});

test('a removed copy stays removed, and updating doesn\'t bring it back', async t => {
  const f = await fixture(t), [removed, ...others] = f.files();
  await f.install();
  await fs.rm(path.dirname(removed), { recursive: true });
  await f.install();
  assert.equal(await f.read(removed), null, 'not by a plain restart');
  await f.publish('version two\n'); await f.install();
  assert.equal(await f.read(removed), null, 'and not by an update');
  for (const file of others) assert.equal(await f.read(file), 'version two\n', file);
});

test('a skill of that name that was there first is someone\'s own, and is left alone', async t => {
  const f = await fixture(t), [existing, ...others] = f.files();
  await fs.mkdir(path.dirname(existing), { recursive: true }); await fs.writeFile(existing, 'already mine\n');
  await f.install();
  assert.equal(await f.read(existing), 'already mine\n');
  for (const file of others) assert.equal(await f.read(file), 'version one\n', file);
});

test('one agent\'s unwritable folder doesn\'t affect the others', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.home, '.gemini'), 'a file where a folder should be');
  await f.install();
  const [claude, agents] = f.files();
  assert.equal(await f.read(claude), 'version one\n'); assert.equal(await f.read(agents), 'version one\n');
  assert.equal(await fs.readFile(path.join(f.home, '.gemini'), 'utf8'), 'a file where a folder should be');
});

test('damaged state counts as a first run and doesn\'t overwrite an edit', async t => {
  const f = await fixture(t), [edited] = f.files();
  await f.install();
  await fs.writeFile(edited, 'my own words\n'); await fs.writeFile(f.stateFile, '{broken');
  await f.publish('version two\n'); await f.install();
  assert.equal(await f.read(edited), 'my own words\n');
});

test('a source that can\'t be read fails loudly and writes no state, so a later run still installs', async t => {
  const f = await fixture(t);
  await assert.rejects(f.install({ source: path.join(f.root, 'absent') }), { code: 'ENOENT' });
  await assert.rejects(fs.stat(f.stateFile), { code: 'ENOENT' });
  await f.install();
  for (const file of f.files()) assert.equal(await f.read(file), 'version one\n', file);
});

test('the real SKILL.md is named t3-vault and its commands exist', async t => {
  const text = await fs.readFile(SKILL, 'utf8');
  assert.match(text, /^---\nname: t3-vault\ndescription: .+\n---\n/);
  const metadata = skillMetadata(text, 'not-from-the-folder');
  assert.equal(metadata.name, 't3-vault');
  assert.ok(metadata.description.length > 20 && metadata.description.length < 1024);
  // An agent follows this file literally, so every option it names has to work.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-vault-skill-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../docker/setup/credentials/cli.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [cli, '--help'], { env: { PATH: process.env.PATH, HOME: root, T3CODE_HOME: path.join(root, '.t3') }, encoding: 'utf8' }).stdout;
  const types = spawnSync(process.execPath, [cli, 'types'], { env: { PATH: process.env.PATH, HOME: root, T3CODE_HOME: path.join(root, '.t3') }, encoding: 'utf8' }).stdout;
  for (const [, command] of text.matchAll(/t3-vault ([a-z-]+)/g)) assert.ok(help.includes('t3-vault ' + command), command);
  for (const [, option] of text.matchAll(/(--[a-z][a-z-]+)/g)) assert.ok(help.includes(option) || types.includes(option) || option === '--user', option);
  assert.deepEqual([...credentialMentions(text)], [], 'the Vault\'s own skill doesn\'t count as using anything');
  assert.match(text, /request_secret/); assert.match(text, /t3-vault list/);
  assert.doesNotMatch(text, /t3-ssh|t3-api/);
});
