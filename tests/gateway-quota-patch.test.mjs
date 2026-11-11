import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from './lib/strip-types.mjs';
import test from 'node:test';
import { files, quotaFile, quotaSource, patchGatewayQuota } from '../docker/runtime/patches/gateway-quota.mjs';
import { patches, createdFiles } from '../docker/runtime/patches/index.mjs';
import { source } from './fixtures/gateway-quota-source.mjs';
import { source as providerTableSource } from './fixtures/gateway-quota-provider-table-source.mjs';

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

const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

test('provider-table patch preserves native readers, transport, diagnostics and reset-credit calls', () => {
  const before = structuredClone(providerTableSource), patched = patchGatewayQuota(providerTableSource);
  assert.deepEqual(providerTableSource, before);
  const original = before[files[0]], result = patched[files[0]];
  for (const [start, end] of [
    ['const HUB_PROVIDERS', 'function management'],
    ['function management', '  const authFiles'],
    ['  const apiCall', '  const readAccount'],
    ['    const call: HubCall', '  const readAccounts'],
  ]) assert.equal(section(result, start, end), section(original, start, end));
  assert.equal(result.slice(result.indexOf('  const consume')), original.slice(original.indexOf('  const consume')));
  assert.equal(result.split('  project_id: Schema.optional(Schema.String),').length, 2);
  assert.ok(!result.includes('requestHeaders'));
  assert.match(result, /files\.filter\(Schema\.is\(AuthFile\)\)/);
  assert.match(result, /account\.id\.trim\(\) && account\.auth_index\.trim\(\) && account\.provider\.trim\(\)/);
  assert.match(result, /return !account\.disabled \? \[\{ account, provider \}\] : \[\]/);
  assert.match(patched[files[1]], /limitsNotice\(account.usageLimits\)/);
  assert.match(patched[files[2]], /OpenCode Go/);
});

test('provider-table patch fails closed on missing, duplicate, mixed and changed upstream anchors', () => {
  const original = providerTableSource[files[0]];
  for (const anchor of [
    'interface HubProvider {',
    'const HUB_PROVIDERS = new Map<string, HubProvider>([',
    '  project_id: Schema.optional(Schema.String),',
    '    header: Record<string, string>,',
    '    provider: HubProvider,',
    '      apiCall(hub, account, provider.header(account, platform, architecture), url, data);',
    'return provider && !account.disabled ? [{ account, provider }] : [];',
  ]) {
    for (const replacement of ['', anchor + '\n' + anchor]) {
      assert.throws(() => patchGatewayQuota({ ...providerTableSource, [files[0]]: original.replace(anchor, replacement) }), /no longer matches/, anchor);
    }
  }
  for (const fixture of [source, providerTableSource]) {
    for (const file of files) for (const replacement of ['', fixture[file] + fixture[file]]) {
      assert.throws(() => patchGatewayQuota({ ...fixture, [file]: replacement }), /no longer matches/);
    }
  }
  assert.throws(() => patchGatewayQuota({ ...providerTableSource, [files[0]]: original + source[files[0]] }), /no longer matches/);
  assert.throws(() => patchGatewayQuota(patchGatewayQuota(providerTableSource)), /already exists/);
});

// Execute the patched routing with a small synchronous Effect interpreter. The
// native CI smoke covers the real Effect services, provider parsers and network.
function providerTableHarness(accounts) {
  const run = effect => {
    const step = effect[Symbol.iterator]().next();
    assert.equal(step.done, true);
    return step.value;
  };
  const effect = read => ({
    *[Symbol.iterator]() { return read(); },
    pipe(...ops) { return ops.reduce((current, op) => op(current), this); },
  });
  const Effect = {
    fn: () => body => (...args) => effect(() => run(body(...args))),
    provideService: () => current => current,
    mapError: () => current => current,
    orElseSucceed: fallback => current => effect(() => { try { return run(current); } catch { return fallback(); } }),
    forEach: (entries, read) => effect(() => entries.map(entry => run(read(entry)))),
  };
  const nativeCalls = [], additionalCalls = [], transports = [], managementCalls = [];
  const providers = new Map(['codex', 'claude', 'xai', 'antigravity'].map(name => [name, {
    driver: name === 'xai' ? 'grok' : quotaDriver(name),
    header: (account, platform, architecture) => ({ Authorization: `native-${name}`, platform, architecture, project: account.project_id }),
    read: ({ account, call, checkedAt }) => effect(() => {
      nativeCalls.push(account.id);
      run(call(`https://${name}.example.test/quota`, { native: true }));
      if (account.id === 'failed-native') throw new Error('private-fixture-native-error');
      return { usageLimits: { checkedAt, windows: [{ id: 'native' }] } };
    }),
  }]));
  const makeAdditionalQuotaReader = (management, call) => (account, checkedAt) => effect(() => {
    additionalCalls.push(account.id);
    run(management('quota/fetch', { auth_index: account.auth_index }));
    run(call({ id: account.id, auth_index: account.auth_index, provider: account.provider }, 'https://custom.example.test/quota', {}, { Authorization: 'custom-fixture-token' }));
    return { usageLimits: { checkedAt, windows: [{ id: 'additional' }] } };
  });
  const patched = patchGatewayQuota(providerTableSource)[files[0]];
  const js = stripTypeScriptTypes(section(patched, '  const readAccount', '  const consume'));
  const dependencies = {
    Effect, DateTime: { now: effect(() => reset), formatIso: value => value },
    Digest: { Digest: Symbol('Digest') }, digest: {}, platform: 'linux', architecture: 'arm64',
    ProviderDriverKind: { make: value => value }, quotaDriver, makeAdditionalQuotaReader,
    listedIdentity: account => account.email ? { email: account.email } : {},
    makeUnavailableUsageLimits: input => ({ ...input, windows: [] }),
    HUB_PROVIDERS: providers, authFiles: () => effect(() => accounts),
    management: (...args) => effect(() => managementCalls.push(args)),
    apiCall: (...args) => effect(() => transports.push(args)),
  };
  const read = new Function(...Object.keys(dependencies), js + '\nreturn readAccounts;')(...Object.values(dependencies));
  const hub = { url: 'https://hub.example.test', managementKey: 'fixture-only' };
  return { result: run(read(hub)), nativeCalls, additionalCalls, transports, managementCalls, hub };
}

test('native providers keep their drivers and headers while additional providers keep the hub and account identity', () => {
  const accounts = ['codex', 'claude', 'xai', 'antigravity', 'meta', 'opencode-go', 'another-provider'].map(provider => ({
    id: provider, auth_index: provider, provider, project_id: 'kept-project', email: `${provider}@example.test`,
  }));
  const { result, nativeCalls, additionalCalls, transports, managementCalls, hub } = providerTableHarness([
    ...accounts, { id: 'disabled-native', provider: 'codex', disabled: true }, { id: 'disabled-additional', provider: 'meta', disabled: true },
  ]);
  assert.deepEqual(nativeCalls, ['codex', 'claude', 'xai', 'antigravity']);
  assert.deepEqual(additionalCalls, ['meta', 'opencode-go', 'another-provider']);
  assert.deepEqual(result.map(account => account.driver), ['codex', 'claudeAgent', 'grok', 'antigravity', 'muse', 'opencode-go', 'another-provider']);
  assert.equal(result.length, 7);
  assert.ok(result.every(account => account.usageLimits.checkedAt === reset && account.usageLimits.windows.length === 1));
  assert.equal(result.find(account => account.id === 'meta').email, 'meta@example.test');
  for (const [sentHub, account, headers, url, body] of transports) {
    assert.equal(sentHub, hub);
    assert.equal(account.project_id, 'kept-project');
    if (nativeCalls.includes(account.id)) {
      assert.equal(headers.Authorization, `native-${account.provider}`);
      assert.equal(headers.architecture, 'arm64');
      assert.equal(headers.platform, 'linux');
      assert.equal(url, `https://${account.provider}.example.test/quota`);
      assert.deepEqual(body, { native: true });
    } else {
      assert.equal(headers.Authorization, 'custom-fixture-token');
      assert.equal(url, 'https://custom.example.test/quota');
      assert.deepEqual(body, {});
    }
  }
  assert.equal(managementCalls.length, 3);
  assert.ok(managementCalls.every(([sentHub, path]) => sentHub === hub && path === 'quota/fetch'));
});

test('a native provider failure stays sanitized and does not block other account readers', () => {
  const { result } = providerTableHarness([
    { id: 'failed-native', auth_index: 'failed-native', provider: 'antigravity' },
    { id: 'meta', auth_index: 'meta', provider: 'meta' },
    { id: 'codex', auth_index: 'codex', provider: 'codex' },
  ]);
  assert.equal(result[0].driver, 'antigravity');
  assert.deepEqual(result[0].usageLimits.windows, []);
  assert.equal(result[0].usageLimits.reason, 'probeFailed');
  assert.ok(!JSON.stringify(result).includes('private-fixture'));
  assert.ok(result.slice(1).every(account => account.usageLimits.windows.length));
});
