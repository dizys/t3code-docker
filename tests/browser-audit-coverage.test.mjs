// Freeze the existing scenario matrix while changing only its scheduling.
// Load the real audit entrypoints; stub the browser and stop at the queue
// boundary so omitted/duplicated viewports cannot hide behind green workers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const both = variants => ['light', 'dark'].flatMap(theme => variants.map(variant => [theme, ...variant]));
const skills = [[1440,900],[1024,900],[390,844],[360,640],[1198,878,true]];
const matrices = {
  'files-ui-audit.js': both([['desktop',1440,1000],['laptop',1280,800],['tablet',834,1112],['phone',390,844],['narrow',320,740],['embedded',1198,878],['embedded-modal',1440,900,1100,740],['embedded-compact',1440,900,800,740],['embedded-phone',390,844]]),
  'files-change-ui-audit.js': both([['desktop',1440,1000],['compact',1280,800],['small-desktop',1100,1000],['tablet',834,1112],['phone',390,844],['narrow',320,740],['embedded',1198,878],['embedded-phone',390,844]]),
  'files-space-ui-audit.js': both([['desktop',1440,900],['compact',1280,800],['tablet',834,1112],['phone',390,844],['narrow',320,740],['embedded',1198,878],['embedded-phone',390,844]]),
  'console-editor-ui-audit.js': both([['desktop',1440,900],['laptop',1280,800],['tablet',820,900],['phone',390,844],['tab-narrow',480,900,true],['tab-medium',704,900,true],['tab-wide',1040,900,true]]),
  'skills-ui-audit.js': both([[1440,900],[1024,900],[390,844],[360,720],[820,900],[1198,878,true]]),
  'skills-hooks-ui-audit.js': both(skills),
  'skills-update-ui-audit.js': both(skills),
  'auto-update-ui-audit.js': [[320,740,false],[360,800,false],[390,844,false],[1100,1000,false],[390,844,true],[1198,878,true]].flatMap(variant => ['light','dark'].map(theme => [theme,...variant])),
  'gateways-ui-audit.js': both([['desktop'],['phone'],['embedded'],['embedded-phone']]),
  'mcp-ui-audit.js': both([['desktop'],['phone'],['embedded'],['embedded-phone']]),
};

const loader = `
const Module = require('node:module'), path = require('node:path');
const original = Module._load;
Module._load = function(request, ...args) {
  if (request.endsWith('/browser-audit-cases.cjs')) return { runCases: async cases => console.log('CASES:' + JSON.stringify(cases)) };
  if (request === 'playwright' || request === 'playwright-core') return { chromium: { launch: async () => ({ close: async () => {} }) } };
  return original.call(this, request, ...args);
};
global.fetch = async () => ({ ok: true, json: async () => ({ harnesses: [], setup: {} }) });
const entry = process.env.AUDIT_ENTRY;
process.argv = ['node', entry, 'http://fixture.invalid/', 'fixture'];
require(entry);
`;

test('all ten audit entrypoints retain every original theme, viewport and embed scenario', async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 't3-audit-coverage-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const capture = (entry, extra = {}) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^T3_.*UI/.test(key)));
    for (const prefix of ['FILES','EDITOR','SKILLS','HOOKS','SKILL_UPDATE','AUTO_UPDATE','GATEWAYS','MCP']) env[`T3_${prefix}_UI_OUTPUT`] = output;
    const result = spawnSync(process.execPath, ['-e', loader], {
      env: { ...env, ...extra, AUDIT_ENTRY: new URL('../scripts/' + entry, import.meta.url).pathname },
      encoding: 'utf8', timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split('\n').filter(line => line.startsWith('CASES:'));
    assert.equal(lines.length, 1, entry + ' registers one complete queue');
    return JSON.parse(lines[0].slice(6));
  };
  for (const [entry, expected] of Object.entries(matrices)) assert.deepEqual(capture(entry), expected, entry);
  for (const entry of ['files-ui-audit.js','mcp-ui-audit.js','gateways-ui-audit.js']) {
    const height = entry === 'gateways-ui-audit.js' ? 820 : 900;
    const expected = entry === 'files-ui-audit.js'
      ? both([480,639,640,704,1040].map(width => ['tab-' + width,width,height]))
      : both([480,639,640,704,1040].map(width => ['tab-' + width]));
    assert.deepEqual(capture(entry, { T3_UI_AUDIT_TAB: '1' }), expected, entry + ' retains all tab breakpoints');
  }
  assert.deepEqual(capture('files-ui-audit.js', { T3_FILES_UI_VARIANTS: 'phone', T3_FILES_UI_THEMES: 'dark' }), [['dark','phone',390,844]]);
});
