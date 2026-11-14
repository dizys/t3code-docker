// Exact upstream v0.1.10-nightly.20261113.4616,
// commit 59e64eef881632a23f89c4138bcf37f23d92bf93.
  const autoCompactWindow =
    input.settings?.autoCompactWindow === undefined || input.settings.autoCompactWindow.length === 0
      ? undefined
      : input.settings.autoCompactWindow;
  const compactQuerySettings =
    autoCompactWindow === undefined
      ? querySettings
      : ({
          ...(typeof querySettings === "object" && querySettings !== null ? querySettings : {}),
          autoCompactWindow: Number(autoCompactWindow),
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
    (input.toolSearchOverride === undefined &&
      aliasOverrideEnv === undefined &&
      autoCompactWindow === undefined) ||
    typeof compactQuerySettings === "string"
      ? compactQuerySettings
      : ({
          ...compactQuerySettings,
          env: {
            ...compactQuerySettings?.env,
            ...aliasOverrideEnv,
            // Claude Code ranks this env var above the autoCompactWindow setting.
            ...(autoCompactWindow === undefined
              ? {}
              : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: autoCompactWindow }),
            ...(input.toolSearchOverride === undefined
              ? {}
              : { ENABLE_TOOL_SEARCH: input.toolSearchOverride }),
          },
        } as ClaudeSdkSettings);
