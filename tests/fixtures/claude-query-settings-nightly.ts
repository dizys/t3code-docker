// Upstream v0.1.10-nightly.20261112.4580, 40526f96f6ae3dfe74ae60ca279e748d7838a691.
  const compactQuerySettings =
    input.settings?.autoCompactWindow === undefined || input.settings.autoCompactWindow.length === 0
      ? querySettings
      : ({
          ...(typeof querySettings === "object" && querySettings !== null ? querySettings : {}),
          autoCompactWindow: Number(input.settings.autoCompactWindow),
        } as ClaudeSdkSettings);
  // Claude Code expands a bare alias to its own model, so a custom model with an alias's name
  // pins the alias to itself.
  const aliasOverrideEnv = CLAUDE_CODE_MODEL_ALIASES.has(compiledSelection.apiModelId)
    ? {
        [`ANTHROPIC_DEFAULT_${compiledSelection.apiModelId.toUpperCase()}_MODEL`]:
          compiledSelection.apiModelId,
      }
    : undefined;
  // A settings file path cannot take extra keys, so it goes through unchanged.
  const effectiveQuerySettings =
    (input.toolSearchOverride === undefined && aliasOverrideEnv === undefined) ||
    typeof compactQuerySettings === "string"
      ? compactQuerySettings
      : ({
          ...compactQuerySettings,
          env: {
            ...compactQuerySettings?.env,
            ...aliasOverrideEnv,
            ...(input.toolSearchOverride === undefined
              ? {}
              : { ENABLE_TOOL_SEARCH: input.toolSearchOverride }),
          },
        } as ClaudeSdkSettings);
