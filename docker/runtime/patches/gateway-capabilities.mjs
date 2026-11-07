// Explicit per-instance model facts must win in the picker AND at turn compilation.
// Advertise this only as a complete contract; older runtimes keep plain model ids.
export const files = [
  'packages/provider-core/src/server/snapshotProbe.ts',
  'apps/server/src/provider/ClaudeModelCatalog.ts',
  'apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts',
  'packages/contracts/src/server.ts',
  'apps/server/src/ws.ts',
  'apps/server/src/textGeneration/CodexTextGeneration.ts',
];

function replaceOnce(text, before, after, file) {
  if (typeof text !== 'string' || text.split(before).length !== 2) throw new Error(`The gateway-capabilities patch no longer matches ${file}. Review the upstream source before publishing this runtime.`);
  return text.replace(before, after);
}

export function patchGatewayCapabilities(source) {
  const next = { ...source };
  const change = (file, before, after) => { next[file] = replaceOnce(next[file], before, after, file); };
  change(files[0], `  const nameOverrides = new Map(
    entries.filter((entry) => entry.name !== entry.slug).map((entry) => [entry.slug, entry.name]),
  );
  const resolvedBuiltInModels = builtInModels.map((model) => {
    const name = nameOverrides.get(model.slug);
    if (!name) return model;
    const { shortName: _shortName, ...rest } = model;
    return { ...rest, name };
  });`, `  const overrides = new Map(entries.map((entry) => [entry.slug, entry]));
  const resolvedBuiltInModels = builtInModels.map((model) => {
    const entry = overrides.get(model.slug);
    if (!entry) return model;
    const named = entry.name !== entry.slug;
    if (!named && entry.capabilities === null) return model;
    const { shortName: _shortName, ...rest } = model;
    return {
      ...(named ? rest : model),
      ...(named ? { name: entry.name } : {}),
      ...(entry.capabilities === null ? {} : { capabilities: entry.capabilities }),
    };
  });`);
  change(files[1], `  const builtInModels = catalog.models.map((entry) => {
    if (!entry.model.aliases?.some((alias) => customAliases.has(alias.toLowerCase()))) {`, `  const overrides = new Map(customEntries.map((entry) => [entry.slug, entry]));
  const builtInModels = catalog.models.map((original) => {
    const override = overrides.get(original.model.slug);
    // Explicit capabilities describe this route, not the bundled model's runtime
    // aliases, effort remapping, suffixes, context limits or version requirements.
    const entry: ClaudeCatalogModel = !override?.capabilities ? original : {
      model: {
        slug: original.model.slug,
        name: override.name === override.slug ? original.model.name : override.name,
        isCustom: original.model.isCustom,
        capabilities: withUltracodeToggle(override.capabilities),
      },
      runtime: {},
      compatibility: {},
    };
    if (!entry.model.aliases?.some((alias) => customAliases.has(alias.toLowerCase()))) {`);
  change(files[2], 'import { getModelSelectionStringOptionValue, modelSelectionsEqual } from "@t3tools/shared/model";',
    'import { getModelSelectionStringOptionValue, getProviderOptionCurrentValue, getProviderOptionDescriptors, modelSelectionsEqual, readCustomModelEntries } from "@t3tools/shared/model";');
  change(files[2], '    readonly modelSelection: ModelSelection;\n    readonly hasT3Mcp?: boolean;',
    '    readonly modelSelection: ModelSelection;\n    readonly customModels?: CodexSettings["customModels"];\n    readonly hasT3Mcp?: boolean;');
  change(files[2], `    const selectedEffort =
      getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort") ??
      codexDefaultReasoningEffortOverride(input.modelSelection.model);`, `    const explicitCapabilities = readCustomModelEntries(input.customModels ?? []).find(
      (entry) => entry.slug === input.modelSelection.model && entry.capabilities !== null,
    )?.capabilities;
    const explicitEffort = explicitCapabilities ? getProviderOptionCurrentValue(
      getProviderOptionDescriptors({
        caps: explicitCapabilities,
        selections: input.modelSelection.options,
      }).find((descriptor) => descriptor.id === "reasoningEffort"),
    ) : undefined;
    const selectedEffort = explicitCapabilities
      ? (typeof explicitEffort === "string" ? explicitEffort : undefined)
      : getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort") ??
        codexDefaultReasoningEffortOverride(input.modelSelection.model);`);
  change(files[2], '              modelSelection: turnInput.modelSelection,\n              hasT3Mcp:',
    '              modelSelection: turnInput.modelSelection,\n              customModels: adapterOptions.settings.customModels,\n              hasT3Mcp:');
  change(files[3], 'export const ServerConfig = Schema.Struct({', `export const ServerConfig = Schema.Struct({
  /** Explicit per-instance model capabilities override bundled picker and runtime facts. */
  customModelCapabilityOverrides: Schema.optionalKey(Schema.Boolean),`);
  change(files[4], '          secretProviderSettings: true,', '          customModelCapabilityOverrides: true,\n          secretProviderSettings: true,');
  // Stable 0.1.7 predates Nightly's auxiliary-model fallback. Keep each exact
  // source shape paired with its own effort block, rather than guessing drift.
  const stableImport = 'import { codexModelFamily, getModelSelectionStringOptionValue } from "@t3tools/shared/model";';
  const stable = next[files[5]]?.includes(stableImport);
  if (stable) change(files[5], stableImport,
    'import { codexModelFamily, getModelSelectionStringOptionValue, getProviderOptionCurrentValue, getProviderOptionDescriptors, readCustomModelEntries } from "@t3tools/shared/model";');
  else change(files[5], '  getModelSelectionStringOptionValue,\n  readCustomModelEntries,',
    '  getModelSelectionStringOptionValue,\n  getProviderOptionCurrentValue,\n  getProviderOptionDescriptors,\n  readCustomModelEntries,');
  const beforeEffort = stable ? `      const reasoningEffort =
        getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
        DEFAULT_TEXT_GENERATION_REASONING_EFFORT;` : `      const reasoningEffort =
        (fellBack
          ? undefined
          : getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")) ??
        DEFAULT_TEXT_GENERATION_REASONING_EFFORT;`;
  change(files[5], beforeEffort, `      const explicitCapabilities = readCustomModelEntries(codexConfig.customModels).find(
        (entry) => entry.slug === model && entry.capabilities !== null,
      )?.capabilities;
      const explicitEffort = explicitCapabilities ? getProviderOptionCurrentValue(
        getProviderOptionDescriptors({
          caps: explicitCapabilities,
          selections: ${stable ? 'modelSelection.options' : 'fellBack ? [] : modelSelection.options'},
        }).find((descriptor) => descriptor.id === "reasoningEffort"),
      ) : undefined;
      const reasoningEffort = explicitCapabilities
        ? (typeof explicitEffort === "string" ? explicitEffort : undefined)
        : ${stable ? 'getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")' : '(fellBack\n            ? undefined\n            : getModelSelectionStringOptionValue(modelSelection, "reasoningEffort"))'} ??
          DEFAULT_TEXT_GENERATION_REASONING_EFFORT;`);
  change(files[5], '          "--config",\n          `model_reasoning_effort="${reasoningEffort}"`,',
    '          ...(reasoningEffort === undefined ? [] : ["--config", `model_reasoning_effort="${reasoningEffort}"`]),');
  return next;
}
