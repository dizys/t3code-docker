import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from './lib/strip-types.mjs';
import test from 'node:test';
import { source, stableSource } from './fixtures/gateway-capabilities-source.mjs';
import { files, patchGatewayCapabilities } from '../docker/runtime/patches/gateway-capabilities.mjs';
import { patches } from '../docker/runtime/patches/index.mjs';

// The upstream reader normalizes absent capabilities to null, not undefined.
const readCustomModelEntries = values => values.map(raw => typeof raw === 'string'
  ? { slug: raw, name: raw, capabilities: null }
  : { ...raw, name: raw.name ?? raw.slug, capabilities: raw.capabilities ?? null });
const load = (text, names, dependencies) => {
  const js = stripTypeScriptTypes(text.replaceAll('export ', ''));
  return new Function(...Object.keys(dependencies), `${js}\nreturn {${names.join(',')}};`)(...Object.values(dependencies));
};
const caps = levels => ({ optionDescriptors: levels.length ? [{ id: 'effort', type: 'select', label: 'Reasoning', options: levels.map(id => ({ id, label: id })) }] : [] });

test('explicit capabilities replace matching built-ins, including empty controls, while plain ids retain native facts', () => {
  const patched = patchGatewayCapabilities(source);
  const { providerModelsFromSettings: models } = load(patched[files[0]], ['providerModelsFromSettings'], { readCustomModelEntries });
  const builtIn = [{ slug: 'known', name: 'Native', shortName: 'Short', capabilities: caps(['medium']) }];
  const before = structuredClone(builtIn);
  assert.equal(models(builtIn, [], null), builtIn);
  assert.equal(models(builtIn, ['known'], null)[0], builtIn[0]);
  assert.deepEqual(models(builtIn, [{ slug: 'known', name: 'Rename' }], null)[0], { slug: 'known', name: 'Rename', capabilities: caps(['medium']) });
  for (const capabilities of [caps(['max']), caps([])]) {
    const result = models(builtIn, [{ slug: 'known', capabilities }, { slug: 'unknown', capabilities: caps([]) }], caps(['high']));
    assert.deepEqual(result[0], { ...builtIn[0], capabilities });
    assert.deepEqual(result[1].capabilities, caps([]));
    assert.equal(result.filter(model => model.slug === 'known').length, 1);
  }
  assert.deepEqual(builtIn, before);
});

test('Claude runtime overrides remove built-in remapping, defaults, aliases and suffixes only for explicit entries', () => {
  const resolveClaudeCatalogModel = (catalog, slug) => catalog.models.find(entry => entry.model.slug === slug);
  const dependencies = {
    readCustomModelEntries, withUltracodeToggle: value => value, resolveClaudeCatalogModel,
    getClaudeCatalogModelCapabilities: (catalog, slug) => resolveClaudeCatalogModel(catalog, slug)?.model.capabilities ?? caps([]),
    getProviderOptionDescriptors: ({ caps: capabilities, selections = [] }) => capabilities.optionDescriptors.map(descriptor => {
      const selected = selections.find(selection => selection.id === descriptor.id)?.value;
      const currentValue = descriptor.options.some(option => option.id === selected) ? selected : descriptor.currentValue;
      return { ...descriptor, currentValue };
    }),
    getProviderOptionCurrentValue: descriptor => descriptor?.currentValue ?? descriptor?.options.find(option => option.isDefault)?.id,
  };
  const { scopeClaudeModelCatalog: scope, resolveClaudeCatalogEffort: resolve, normalizeClaudeCatalogEffort: normalize } = load(patchGatewayCapabilities(source)[files[1]], ['scopeClaudeModelCatalog', 'resolveClaudeCatalogEffort', 'normalizeClaudeCatalogEffort'], dependencies);
  const catalog = { models: [{ model: { slug: 'known', name: 'Native', aliases: ['opus'], capabilities: caps(['medium']) }, runtime: { effortMap: { max: 'high' }, modelSuffixes: { contextWindow: { expanded: '[1m]' } } }, compatibility: { minVersion: '99.0.0' } }] };
  const before = structuredClone(catalog);
  assert.equal(scope(catalog, []), catalog);
  assert.equal(scope(catalog, ['known']).models[0], catalog.models[0]);
  const scoped = scope(catalog, [{ slug: 'known', capabilities: caps(['low', 'max']) }, { slug: 'unknown', capabilities: caps([]) }]);
  assert.equal(scoped.models.length, 2);
  assert.deepEqual(scoped.models[0].runtime, {});
  assert.deepEqual(scoped.models[0].compatibility, {});
  assert.equal(scoped.models[0].model.aliases, undefined);
  for (const level of ['low', 'max']) assert.equal(normalize(scoped, resolve(scoped, 'known', level), 'known'), level);
  assert.equal(resolve(scoped, 'known', undefined), undefined, 'no fabricated default');
  assert.equal(resolve(scoped, 'known', 'medium'), undefined, 'unsupported bundled choice removed');
  assert.equal(resolve(scoped, 'unknown', 'high'), undefined, 'empty controls suppress unknown-model fallback');
  assert.equal(normalize(catalog, 'max', 'known'), 'high', 'direct runtime remains unchanged');
  assert.deepEqual(catalog, before);
});

test('Codex forwards exact effort into both native turn fields and suppresses name defaults only for explicit capabilities', () => {
  const text = patchGatewayCapabilities(source)[files[2]].split('\nfunction callSite')[0].replace(/^import .*;\n/, '');
  const decoded = [];
  const identity = function* (value) { return value; };
  const dependencies = {
    readCustomModelEntries,
    getProviderOptionDescriptors: ({ caps: capabilities, selections = [] }) => capabilities.optionDescriptors.map(descriptor => {
      const selected = selections.find(selection => selection.id === descriptor.id)?.value;
      return { ...descriptor, currentValue: descriptor.options.some(option => option.id === selected) ? selected : undefined };
    }),
    getProviderOptionCurrentValue: descriptor => descriptor?.currentValue,
    getModelSelectionStringOptionValue: (selection, id) => selection.options?.find(option => option.id === id)?.value,
    codexDefaultReasoningEffortOverride: slug => slug === 'gpt-6-astra' ? 'medium' : undefined,
    codexRuntimeModeTurnDefaults: () => ({}),
    decodeTurnReasoningEffort: function* (value) { decoded.push(value); return value; },
    decodeCodexTurnStartParamsWithCollaborationMode: identity,
    Effect: { fn: () => generator => input => generator(input).next().value },
  };
  const { buildCodexTurnStartParams: build } = load(text, ['buildCodexTurnStartParams'], dependencies);
  const base = { nativeThreadId: 'thread', codexInput: [], runtimePolicy: { cwd: '/workspace', interactionMode: 'default' }, omitServiceTier: true, modelSelection: { model: 'gpt-6-astra' } };
  assert.equal(build(base).effort, 'medium');
  assert.equal(build({ ...base, customModels: ['gpt-6-astra'] }).effort, 'medium');
  const customModels = [{ slug: 'gpt-6-astra', capabilities: caps([]) }];
  const unknown = build({ ...base, customModels });
  assert.ok(!('effort' in unknown));
  assert.ok(!('reasoning_effort' in unknown.collaborationMode.settings));
  assert.ok(!('effort' in build({ ...base, customModels, modelSelection: { model: 'gpt-6-astra', options: [{ id: 'reasoningEffort', value: 'high' }] } })), 'removed choices do not leak from stale thread selections');
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    const capabilities = caps([effort]);
    capabilities.optionDescriptors[0].id = 'reasoningEffort';
    const result = build({ ...base, customModels: [{ slug: 'gpt-6-astra', capabilities }], modelSelection: { model: 'gpt-6-astra', options: [{ id: 'reasoningEffort', value: effort }] } });
    assert.equal(result.effort, effort);
    assert.equal(result.collaborationMode.settings.reasoning_effort, effort);
    assert.equal(decoded.at(-1), effort);
  }
  assert.match(patchGatewayCapabilities(source)[files[2]], /customModels: adapterOptions\.settings\.customModels/);
  const auxiliaryText = patchGatewayCapabilities(source)[files[5]].replace(/import \{[\s\S]*?from "@t3tools\/shared\/model";\n/, '');
  const { auxiliary } = load(auxiliaryText, ['auxiliary'], { ...dependencies, DEFAULT_TEXT_GENERATION_REASONING_EFFORT: 'low' });
  assert.deepEqual(auxiliary({ customModels: [] }, 'gpt-6-astra', base.modelSelection, false), ['--config', 'model_reasoning_effort="low"']);
  assert.deepEqual(auxiliary({ customModels }, 'gpt-6-astra', base.modelSelection, false), []);
  const capabilities = { optionDescriptors: [{ ...caps(['ultra']).optionDescriptors[0], id: 'reasoningEffort' }] };
  const config = { customModels: [{ slug: 'gpt-6-astra', capabilities }] };
  const selection = { model: 'gpt-6-astra', options: [{ id: 'reasoningEffort', value: 'ultra' }] };
  assert.deepEqual(auxiliary(config, 'gpt-6-astra', selection, false), ['--config', 'model_reasoning_effort="ultra"']);
  assert.deepEqual(auxiliary(config, 'gpt-6-astra', selection, true), [], 'fallback models do not inherit choices for the requested model');
  const stableText = patchGatewayCapabilities(stableSource)[files[5]].replace(/import \{[\s\S]*?from "@t3tools\/shared\/model";\n/, '');
  const { auxiliary: stableAuxiliary } = load(stableText, ['auxiliary'], { ...dependencies, DEFAULT_TEXT_GENERATION_REASONING_EFFORT: 'low' });
  assert.doesNotMatch(stableText, /fellBack \?/);
  assert.deepEqual(stableAuxiliary({ customModels: [] }, 'gpt-6-astra', base.modelSelection, false), ['--config', 'model_reasoning_effort="low"']);
  assert.deepEqual(stableAuxiliary({ customModels }, 'gpt-6-astra', selection, false), []);
  assert.deepEqual(stableAuxiliary(config, 'gpt-6-astra', selection, false), ['--config', 'model_reasoning_effort="ultra"']);
});

test('runtime advertises the complete override contract and fails closed on source drift', () => {
  const before = structuredClone(source), patched = patchGatewayCapabilities(source);
  assert.ok(patches.some(patch => patch.name === 'gateway-capabilities'));
  assert.match(patched[files[3]], /customModelCapabilityOverrides: Schema\.optionalKey\(Schema.Boolean\)/);
  assert.match(patched[files[4]], /customModelCapabilityOverrides: true/);
  assert.deepEqual(source, before);
  for (const fixture of [source, stableSource]) for (const file of files) for (const repeated of [false, true]) {
    const input = { ...fixture, [file]: repeated ? fixture[file] + fixture[file] : 'changed' };
    const original = structuredClone(input);
    assert.throws(() => patchGatewayCapabilities(input), /no longer matches/);
    assert.deepEqual(input, original);
  }
  assert.throws(() => patchGatewayCapabilities(patched), /no longer matches/);
  const file = files[5];
  const mixed = { ...stableSource, [file]: stableSource[file].replace('        getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??', '        (fellBack ? undefined : getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")) ??') };
  assert.throws(() => patchGatewayCapabilities(mixed), /no longer matches/);
});
