import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { files, quotaFile, quotaSource, patchGatewayQuota } from '../docker/runtime/patches/gateway-quota.mjs';
import { patches, createdFiles } from '../docker/runtime/patches/index.mjs';
import { source } from './fixtures/gateway-quota-source.mjs';

// Run the production parsers directly, with erased type-only imports. The
// runtime integration smoke covers their real Effect transport and contracts.
const pure = quotaSource.slice(quotaSource.indexOf('// These responses'), quotaSource.indexOf('interface QuotaAccount'));
const { parseGroupedQuota, parseMetaQuota, quotaDriver } = new Function(stripTypeScriptTypes(pure.replaceAll('export ', ''), { mode: 'transform' }) + '\nreturn {parseGroupedQuota, parseMetaQuota, quotaDriver};')();
const reset = '2026-11-08T03:00:00.000Z';
const group = buckets => ({ groups: [{ displayName: 'Claude models', buckets }] });

test('grouped quota preserves exhaustion, precision, independent models and reset windows', () => {
  const input = { ...group([{ window: '5h', remainingFraction: 0, resetTime: reset }, { window: 'weekly', remainingFraction: '0.87654' }]), subscription: { tierName: 'Go' }, api_key: 'secret-should-not-leave-parser' };
  const before = structuredClone(input), result = parseGroupedQuota(input);
  assert.equal(result.plan, 'Go');
  assert.deepEqual(result.windows.map(({ kind, usedPercent, resetsAt, windowDurationMins }) => ({ kind, usedPercent, resetsAt, windowDurationMins })), [
    { kind: 'session', usedPercent: 100, resetsAt: reset, windowDurationMins: 300 },
    { kind: 'weekly', usedPercent: 12.346, resetsAt: undefined, windowDurationMins: 10080 },
  ]);
  const reordered = parseGroupedQuota(group([...input.groups[0].buckets].reverse()));
  assert.deepEqual(reordered.windows.map(window => window.id).sort(), result.windows.map(window => window.id).sort());
  assert.equal(parseGroupedQuota({ groups: [...input.groups, { displayName: 'Gemini', buckets: [{ window: 'weekly', remainingFraction: 1 }] }] }).windows.length, 3);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.deepEqual(input, before);
});

test('missing, non-finite and invalid fractions never become zero or full quota', () => {
  const invalid = [undefined, null, '', ' ', true, {}, NaN, Infinity, 'NaN', -0.1, 1.1];
  const result = parseGroupedQuota(group(invalid.map((remainingFraction, index) => ({ window: String(index), remainingFraction }))));
  assert.deepEqual(result.windows, []);
  assert.deepEqual(parseGroupedQuota({}).windows, []);
  assert.throws(() => parseGroupedQuota('invalid'));
  assert.throws(() => parseGroupedQuota('null'));
  assert.throws(() => parseGroupedQuota([]));
});

test('snake-case plugin fields and unknown periods retain explicit facts without inventing durations', () => {
  const result = parseGroupedQuota(JSON.stringify({ subscription: { tier_name: 'Go' }, groups: [{ display_name: 'All models', buckets: [{ window: 'rolling', remaining_fraction: 0.5, reset_time: reset }, { window: 'monthly', remainingFraction: 0.7, resetTime: 'invalid' }] }] }));
  assert.equal(result.plan, 'Go');
  assert.equal(result.windows[0].label, 'All models · rolling');
  assert.equal(result.windows[0].resetsAt, reset);
  assert.equal(result.windows[0].windowDurationMins, undefined);
  assert.equal(result.windows[1].kind, 'monthly');
  assert.equal(result.windows[1].resetsAt, undefined);
});

test('bucket display names and descriptions preserve distinct windows with the same period', () => {
  const result = parseGroupedQuota(group([
    { window: 'rolling', displayName: '5-hour rolling', description: 'Fallback', remainingFraction: 0.2 },
    { window: 'rolling', description: 'Daily allowance', remainingFraction: 0.3 },
  ]));
  assert.deepEqual(result.windows.map(window => window.label), ['Claude models · 5-hour rolling', 'Claude models · Daily allowance']);
  assert.notEqual(result.windows[0].id, result.windows[1].id);
  assert.ok(result.windows.every(window => window.windowDurationMins === undefined));
});

test('Muse reports only subscription usage, retaining an explicit zero and valid reset epochs', () => {
  const result = parseMetaQuota({ api_key: 'LLM|private', user_email: 'private@example.test', subs_tier_name: 'Everyday', subs_usage: { window: { used_percent: '2', window_duration_mins: 300, resets_at: Date.parse(reset) / 1000 }, weekly: { used_percent: 0, resets_at: 0 } } });
  assert.equal(result.plan, 'Everyday');
  assert.deepEqual(result.windows.map(window => [window.usedPercent, window.label, window.resetsAt]), [[2, '5 hours', reset], [0, 'Weekly', undefined]]);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.deepEqual(parseMetaQuota({ subs_tier_name: 'Free' }), { plan: 'Free', windows: [] });
  for (const used_percent of [null, '', true, -1, NaN, Infinity, 'invalid']) assert.deepEqual(parseMetaQuota({ subs_usage: { weekly: { used_percent } } }).windows, []);
  assert.equal(parseMetaQuota({ subs_usage: { weekly: { used_percent: 110 } } }).windows[0].usedPercent, 100);
});

test('unknown quota providers stay distinct from native Claude and OpenCode drivers', () => {
  for (const [provider, driver] of [['claude', 'claudeAgent'], ['codex', 'codex'], ['meta', 'muse'], ['antigravity', 'antigravity'], ['opencode-go', 'opencode-go'], ['another-provider', 'another-provider'], ['invalid/driver', 'gateway']]) assert.equal(quotaDriver(provider), driver);
});

test('runtime registers the asset, binds hubs independently and exposes account failures in native Limits', () => {
  const before = structuredClone(source), patched = patchGatewayQuota(source);
  assert.deepEqual(source, before);
  assert.equal(patched[quotaFile], quotaSource);
  assert.ok(createdFiles.includes(quotaFile));
  assert.ok(patches.find(patch => patch.name === 'gateway-quota').assets.length);
  assert.match(patched[files[0]], /requestHeaders \?\? header/);
  assert.match(patched[files[0]], /management\(hub, path, body\)/);
  assert.match(patched[files[0]], /!account.disabled,/);
  assert.match(patched[files[1]], /limitsNotice\(account.usageLimits\)/);
  assert.match(patched[files[2]], /OpenCode Go/);
  for (const file of files) for (const replacement of ['', source[file] + source[file]]) assert.throws(() => patchGatewayQuota({ ...source, [file]: replacement }), /no longer matches/);
  assert.throws(() => patchGatewayQuota(patched), /already exists/);
});
