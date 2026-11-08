#!/usr/bin/env node
// Native resource loaders in disposable homes. No sign-in, external inference,
// or MCP process is started. Pass grok, muse or pi and an absolute executable.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const setup = new URL(process.env.T3_SETUP_DIR || '../docker/setup/', import.meta.url);
const { createMcpService } = await import(new URL('mcp.mjs', setup));
const { createSkillsService, skillRoots } = await import(new URL('skills.mjs', setup));
const { agentsMdTargets, writeAgentsMd, reconcileAgentsMd } = await import(new URL('context.mjs', setup));
const execute = promisify(execFile), [provider, executable] = process.argv.slice(2);
assert.ok(['grok', 'muse', 'pi'].includes(provider) && path.isAbsolute(executable || ''), 'Pass grok, muse or pi and an absolute native executable.');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-resources-native-'));
try {
  const home = path.join(root, 'home'), cwd = path.join(root, 'project');
  await fs.mkdir(home, { recursive: true }); await fs.mkdir(cwd);
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', XDG_CONFIG_HOME: path.join(home, '.config'), GROK_HOME: path.join(home, 'custom-grok'), PI_CODING_AGENT_DIR: path.join(home, 'custom-pi') };
  const options = { home, env, io: fs, baseDir: path.join(home, '.t3') };
  await writeAgentsMd(fs, options.baseDir, '# NATIVE_RESOURCE_PROBE');
  await reconcileAgentsMd(fs, options.baseDir, { ...options, only: [provider] });
  const instructions = agentsMdTargets(env, home).find(row => row.provider === provider).path;
  const skills = createSkillsService(options);
  await skills.create(provider, 'resource-probe', '---\nname: resource-probe\ndescription: Verify native resource loading.\n---\n# Disposable skill\n');
  const mcp = createMcpService(options), definition = await mcp.create({ name: 'resource-probe', type: 'local', command: [process.execPath, '--version'], env: { FIXTURE_VALUE: 'native' } });
  // Disabled entries prove configuration loading without starting a server.
  await mcp.setLink(provider, 'resource-probe', true, definition.revision, undefined, false);
  const file = path.join(skillRoots(provider, options)[0].path, 'resource-probe/SKILL.md');
  const native = async args => (await execute(executable, args, { cwd, env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  if (provider === 'grok') {
    const inspect = async () => JSON.parse(await native(['inspect', '--json']));
    let result = await inspect();
    assert.ok(result.projectInstructions.some(row => JSON.stringify(row).includes(instructions)), 'Grok loads the global rule.');
    assert.ok(result.skills.some(row => JSON.stringify(row).includes(file)), 'Grok loads the user skill.');
    assert.match(await native(['mcp', 'list']), /resource-probe/, 'Grok lists the disabled native MCP entry.');
    const row = (await skills.list(provider)).skills.find(row => row.path === file);
    await skills.setState(provider, row.id, row.stateRevision, undefined, 'disabled');
    result = await inspect();
    const skill = result.skills.find(row => JSON.stringify(row).includes(file));
    assert.ok(skill?.disabled === true || skill?.enabled === false, 'Grok marks the native user skill disabled.');
  } else if (provider === 'muse') {
    const inspect = async () => JSON.parse(await native(['skills', 'list', '--json']));
    let result = await inspect(); assert.ok(result.skills.some(row => row.name === 'resource-probe'));
    const row = (await skills.list(provider)).skills.find(row => row.path === file);
    await skills.setState(provider, row.id, row.stateRevision, undefined, 'off');
    result = await inspect(); assert.equal(result.skills.find(row => row.name === 'resource-probe').activation, 'off');
    for (const state of ['user-invocable-only', 'on']) {
      const current = (await skills.list(provider, { refresh: true })).skills.find(row => row.path === file);
      await skills.setState(provider, current.id, current.stateRevision, undefined, state);
      assert.equal((await inspect()).skills.find(row => row.name === 'resource-probe').activation, state);
    }
    await native(['exec', '--provider', 'echo', '--disable-shell', '--disable-write', '--disable-sandbox', 'Reply OK']);
    assert.equal(JSON.parse(await fs.readFile(path.join(home, '.config/muse/settings.json'), 'utf8')).schema_version, 1);
    // Capture the real model request at a local rejecting fixture. The echo
    // provider alone cannot prove that the global instruction reached context.
    let included = false;
    const server = createServer((request, response) => {
      let content = '';
      request.on('data', chunk => { content += chunk; });
      request.on('end', () => {
        if (request.url.endsWith('/models')) {
          const models = [{ id: 'muse-spark-1.2' }];
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: models, models }));
        } else {
          included ||= content.includes('NATIVE_RESOURCE_PROBE');
          response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Disposable instruction fixture captured the request.', type: 'invalid_request_error' } }));
        }
      });
    });
    let child;
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      child = spawn(executable, ['exec', '--provider', 'meta', '--api-key-stdin', '--model', 'muse-spark-1.2', '--base-url', `http://127.0.0.1:${server.address().port}`,
        '--disable-shell', '--disable-write', '--disable-sandbox', '--disable-web-tools', '--disable-reminders', '--max-model-steps', '1', 'Reply OK'], { cwd, env, stdio: ['pipe', 'ignore', 'ignore'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
      try {
        child.stdin.on('error', () => {}); child.stdin.end('fixture-native-resource-key\n');
        await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        assert.ok(included, 'Muse includes the managed global instructions in its native request.');
      } finally { clearTimeout(timer); }
    } finally {
      child?.kill('SIGKILL'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  } else {
    const resolved = await fs.realpath(executable);
    let dist = path.dirname(resolved);
    for (const candidate of [dist, path.join(path.dirname(dist), '@earendil-works/pi-coding-agent/dist'), path.join(path.dirname(dist), '@mariozechner/pi-coding-agent/dist')]) {
      if (await fs.stat(path.join(candidate, 'core/resource-loader.js')).then(() => true, () => false)) { dist = candidate; break; }
    }
    const moduleAt = file => pathToFileURL(path.join(dist, file)).href;
    const loaderScript = path.join(root, 'pi-loader.mjs');
    await fs.writeFile(loaderScript, `
      import assert from 'node:assert/strict';
      const {loadProjectContextFiles}=await import(${JSON.stringify(moduleAt('core/resource-loader.js'))});
      const {SettingsManager}=await import(${JSON.stringify(moduleAt('core/settings-manager.js'))});
      const {DefaultPackageManager}=await import(${JSON.stringify(moduleAt('core/package-manager.js'))});
      const {loadMcpConfig}=await import(${JSON.stringify(moduleAt('extensions/mcp/config.js'))});
      const cwd=${JSON.stringify(cwd)}, agentDir=${JSON.stringify(env.PI_CODING_AGENT_DIR)}, file=${JSON.stringify(file)};
      assert.ok(loadProjectContextFiles({cwd,agentDir}).some(row=>row.path===${JSON.stringify(instructions)}&&row.content.includes('NATIVE_RESOURCE_PROBE')));
      const settingsManager=SettingsManager.create(cwd,agentDir,{projectTrusted:false});
      const resources=await new DefaultPackageManager({cwd,agentDir,settingsManager}).resolve();
      const skill=resources.skills.find(row=>row.path===file);
      assert.ok(skill); assert.equal(skill.enabled,process.argv[2]!=='disabled');
      const mcp=loadMcpConfig({cwd,agentDir,projectTrusted:false});assert.deepEqual(mcp.errors,[]);
      assert.ok(mcp.servers.some(row=>row.name==='resource-probe'));
    `);
    await execute(process.execPath, [loaderScript], { cwd, env, timeout: 30000 });
    const row = (await skills.list(provider)).skills.find(row => row.path === file);
    await skills.setState(provider, row.id, row.stateRevision, undefined, 'disabled');
    await execute(process.execPath, [loaderScript, 'disabled'], { cwd, env, timeout: 30000 });
  }
  console.log(`PASS ${provider}: native user resources and skill disable setting, disposable home, no external model requests`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
