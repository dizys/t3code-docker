export const files = [
  'apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts',
  'packages/contracts/src/server.ts',
  'apps/server/src/ws.ts',
];
export const creates = ['apps/server/src/provider/GatewayModelContext.ts'];
export const assets = [new URL('./gateway-context.ts', import.meta.url)];
import { readFileSync } from 'node:fs';

export function patchGatewayContext(source) {
  const next = { ...source };
  const change = (file, before, after) => {
    if (typeof next[file] !== 'string' || next[file].split(before).length !== 2) throw new Error(`The gateway-context patch no longer matches ${file}. Review the upstream source before publishing this runtime.`);
    next[file] = next[file].replace(before, after);
  };
  change(files[0], 'import * as DocumentText from "../../provider/DocumentText.ts";',
    'import { applyClaudeGatewayContext, claudeGatewayContextKey } from "../../provider/GatewayModelContext.ts";\nimport * as DocumentText from "../../provider/DocumentText.ts";');
  change(files[0], `  // A settings file path cannot take extra keys, so it goes through unchanged.
  const effectiveQuerySettings =
    input.toolSearchOverride === undefined || typeof compactQuerySettings === "string"
      ? compactQuerySettings
      : ({
          ...compactQuerySettings,
          env: { ...compactQuerySettings?.env, ENABLE_TOOL_SEARCH: input.toolSearchOverride },`,
    `  const gatewayQuerySettings = applyClaudeGatewayContext(
    input.environment, compiledSelection.apiModelId, compactQuerySettings,
  ) as typeof compactQuerySettings;
  // A settings file path cannot take extra keys, so it goes through unchanged.
  const effectiveQuerySettings =
    input.toolSearchOverride === undefined || typeof gatewayQuerySettings === "string"
      ? gatewayQuerySettings
      : ({
          ...gatewayQuerySettings,
          env: { ...gatewayQuerySettings?.env, ENABLE_TOOL_SEARCH: input.toolSearchOverride },`);
  change(files[0], '            canApplyClaudeSelectionLive(existing.selection, compiledSelection) &&',
    `            canApplyClaudeSelectionLive(existing.selection, compiledSelection) &&
            claudeGatewayContextKey(adapterOptions.environment, existing.selection.apiModelId) ===
              claudeGatewayContextKey(adapterOptions.environment, compiledSelection.apiModelId) &&`);
  change(files[1], '  customModelCapabilityOverrides: Schema.optionalKey(Schema.Boolean),',
    '  customModelCapabilityOverrides: Schema.optionalKey(Schema.Boolean),\n  gatewayModelLimits: Schema.optionalKey(Schema.Boolean),');
  change(files[2], '          customModelCapabilityOverrides: true,',
    '          customModelCapabilityOverrides: true,\n          gatewayModelLimits: true,');
  next[creates[0]] = readFileSync(assets[0], 'utf8');
  return next;
}
