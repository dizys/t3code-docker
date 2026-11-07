// Exact upstream excerpts, v0.1.7-nightly.20261102.4066. Executed after patching.
export const source = {
  'packages/provider-core/src/server/snapshotProbe.ts': `export function providerModelsFromSettings(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<CustomModelSetting>,
  customModelCapabilities: ModelCapabilities | null,
): ReadonlyArray<ServerProviderModel> {
  const entries = readCustomModelEntries(customModels);
  if (entries.length === 0) return builtInModels;

  const nameOverrides = new Map(
    entries.filter((entry) => entry.name !== entry.slug).map((entry) => [entry.slug, entry.name]),
  );
  const resolvedBuiltInModels = builtInModels.map((model) => {
    const name = nameOverrides.get(model.slug);
    if (!name) return model;
    const { shortName: _shortName, ...rest } = model;
    return { ...rest, name };
  });
  const seen = new Set(resolvedBuiltInModels.map((model) => model.slug));
  const customEntries: ServerProviderModel[] = [];

  for (const entry of entries) {
    if (seen.has(entry.slug)) {
      continue;
    }
    seen.add(entry.slug);
    customEntries.push({
      slug: entry.slug,
      name: entry.name,
      isCustom: true,
      capabilities: entry.capabilities ?? customModelCapabilities,
    });
  }

  return [...resolvedBuiltInModels, ...customEntries];
}`,
  'apps/server/src/provider/ClaudeModelCatalog.ts': `export function scopeClaudeModelCatalog(
  catalog: ClaudeModelCatalog,
  customModels: ReadonlyArray<CustomModelSetting>,
): ClaudeModelCatalog {
  const customEntries = readCustomModelEntries(customModels);
  if (customEntries.length === 0) return catalog;
  const customAliases = new Set(customEntries.map((entry) => entry.slug.toLowerCase()));

  const builtInModels = catalog.models.map((entry) => {
    if (!entry.model.aliases?.some((alias) => customAliases.has(alias.toLowerCase()))) {
      return entry;
    }
    return {
      ...entry,
      model: {
        ...entry.model,
        aliases: entry.model.aliases.filter((alias) => !customAliases.has(alias.toLowerCase())),
      },
    };
  });
  const builtInSlugs = new Set(builtInModels.map((entry) => entry.model.slug));
  const customCatalogModels: Array<ClaudeCatalogModel> = [];
  for (const entry of customEntries) {
    if (!entry.capabilities || builtInSlugs.has(entry.slug)) continue;
    customCatalogModels.push({
      model: {
        slug: entry.slug,
        name: entry.name,
        isCustom: true,
        capabilities: withUltracodeToggle(entry.capabilities),
      },
      runtime: {},
      compatibility: {},
    });
  }

  return { models: [...builtInModels, ...customCatalogModels] };
}

export function resolveClaudeCatalogEffort(
  catalog: ClaudeModelCatalog,
  model: string | null | undefined,
  raw: string | null | undefined,
): string | undefined {
  if (!resolveClaudeCatalogModel(catalog, model)) {
    const effort = raw?.trim();
    return effort && ["low", "medium", "high", "xhigh", "max"].includes(effort)
      ? effort
      : undefined;
  }

  const caps = getClaudeCatalogModelCapabilities(catalog, model);
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "effort");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function normalizeClaudeCatalogEffort(
  catalog: ClaudeModelCatalog,
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!effort) return undefined;
  const effortMap = resolveClaudeCatalogModel(catalog, model)?.runtime.effortMap;
  if (!effortMap || !Object.prototype.hasOwnProperty.call(effortMap, effort)) return effort;
  return effortMap[effort] ?? undefined;
}`,
  'apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts': `import { getModelSelectionStringOptionValue, modelSelectionsEqual } from "@t3tools/shared/model";
export const buildCodexTurnStartParams = Effect.fn("CodexAdapterV2.buildCodexTurnStartParams")(
  function* (input: {
    readonly nativeThreadId: string;
    readonly codexInput: ReadonlyArray<CodexSchema.V2TurnStartParams__UserInput>;
    readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
    readonly modelSelection: ModelSelection;
    readonly hasT3Mcp?: boolean;
    readonly browserToolsAvailable?: boolean;
    readonly deviceToolsAvailable?: boolean;
    /** ChatGPT token sharing does not accept service tiers. */
    readonly omitServiceTier?: boolean;
    readonly appContext?: ProviderAdapter.ProviderAdapterV2TurnInput["appContext"];
  }) {
    const runtimeModeDefaults = codexRuntimeModeTurnDefaults(input.runtimePolicy.runtimeMode);
    const approvalPolicy =
      input.runtimePolicy.approvalPolicy === undefined
        ? runtimeModeDefaults.approvalPolicy
        : yield* decodeTurnApprovalPolicy(input.runtimePolicy.approvalPolicy);
    const sandboxPolicy =
      input.runtimePolicy.sandboxPolicy === undefined
        ? runtimeModeDefaults.sandboxPolicy
        : yield* decodeTurnSandboxPolicy(input.runtimePolicy.sandboxPolicy);
    const selectedEffort =
      getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort") ??
      codexDefaultReasoningEffortOverride(input.modelSelection.model);
    const effort =
      selectedEffort === undefined ? undefined : yield* decodeTurnReasoningEffort(selectedEffort);
    const serviceTier =
      input.omitServiceTier === true
        ? undefined
        : getCodexServiceTierOptionValue(input.modelSelection);
    // MCP-written app context must be quoted user input, not developer instructions.
    const appContext = Object.fromEntries(
      (input.appContext ?? []).map((entry) => [
        entry.key,
        { kind: "untrusted" as const, value: entry.text },
      ]),
    );
    const t3Context =
      input.hasT3Mcp === true
        ? buildCodexAdditionalContext(
            { model: input.modelSelection.model, reasoningEffort: effort ?? undefined },
            {
              browser: input.browserToolsAvailable ?? true,
              device: input.deviceToolsAvailable ?? false,
            },
          )
        : undefined;
    const additionalContext =
      t3Context === undefined && Object.keys(appContext).length === 0
        ? undefined
        : { ...t3Context, ...appContext };
    return yield* decodeCodexTurnStartParamsWithCollaborationMode({
      threadId: input.nativeThreadId,
      input: input.codexInput,
      ...(additionalContext ? { additionalContext } : {}),
      cwd: input.runtimePolicy.cwd,
      model: input.modelSelection.model,
      // Catalogues can default summaries to "none"; request them explicitly on every turn.
      summary: "detailed",
      // Omitting the reviewer on resume preserves the previous Auto reviewer.
      approvalsReviewer: runtimeModeDefaults.approvalsReviewer,
      ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
      ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
      ...(effort === undefined ? {} : { effort }),
      ...(serviceTier === undefined ? {} : { serviceTier }),
      // Codex supplies its own mode instructions; send both modes to clear Plan on exit.
      collaborationMode: {
        mode: input.runtimePolicy.interactionMode,
        settings: {
          model: input.modelSelection.model,
          ...(effort === undefined ? {} : { reasoning_effort: effort }),
        },
      },
    });
  },
);
function callSite() {
              modelSelection: turnInput.modelSelection,
              hasT3Mcp:
}
`,
  'packages/contracts/src/server.ts': 'export const ServerConfig = Schema.Struct({',
  'apps/server/src/ws.ts': '          secretProviderSettings: true,',
  'apps/server/src/textGeneration/CodexTextGeneration.ts': `import {
  getModelSelectionStringOptionValue,
  readCustomModelEntries,
} from "@t3tools/shared/model";
function auxiliary(codexConfig, model, modelSelection, fellBack) {
      const reasoningEffort =
        (fellBack
          ? undefined
          : getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")) ??
        DEFAULT_TEXT_GENERATION_REASONING_EFFORT;
      return [
          "--config",
          \`model_reasoning_effort="\${reasoningEffort}"\`,
      ];
}
`,
};

// Stable v0.1.7 has no auxiliary fallback or custom-entry import yet.
export const stableSource = {
  ...source,
  'apps/server/src/textGeneration/CodexTextGeneration.ts': source['apps/server/src/textGeneration/CodexTextGeneration.ts']
    .replace(`import {
  getModelSelectionStringOptionValue,
  readCustomModelEntries,
} from "@t3tools/shared/model";`, 'import { codexModelFamily, getModelSelectionStringOptionValue } from "@t3tools/shared/model";')
    .replace(`        (fellBack
          ? undefined
          : getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")) ??`, '        getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??'),
};
