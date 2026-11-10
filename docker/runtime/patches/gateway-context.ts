// Route metadata belongs to one provider instance, never process.env or the
// shared Claude home. Claude's window override is process-scoped, so changing
// it requires a query replacement rather than a live setModel call.
type Limits = { context: number; input?: number; output?: number };
type Settings = Record<string, unknown>;

function limitsByModel(environment: NodeJS.ProcessEnv | undefined): Record<string, Limits> {
  const raw = environment?.T3_GATEWAY_MODEL_LIMITS;
  if (!raw || raw.length > 256000) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const row = value as Record<string, unknown>;
      const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= 10000000;
      if (!valid(row.context)) return [];
      const context = row.context;
      return [[id, { context,
        ...(valid(row.input) && row.input <= context ? { input: row.input } : {}),
        ...(valid(row.output) && row.output < (valid(row.input) && row.input <= context ? row.input : context) ? { output: row.output } : {}),
      }]];
    }));
  } catch { return {}; }
}

export function claudeGatewayContextKey(environment: NodeJS.ProcessEnv | undefined, model: string): string {
  const models = limitsByModel(environment), limits = Object.hasOwn(models, model) ? models[model] : undefined;
  return limits ? JSON.stringify([limits.input ?? limits.context, limits.output ?? null]) : "";
}

export function applyClaudeGatewayContext(
  environment: NodeJS.ProcessEnv | undefined,
  model: string,
  settings: string | object | undefined,
): string | object | undefined {
  const models = limitsByModel(environment), limits = Object.hasOwn(models, model) ? models[model] : undefined;
  // A path must remain a path. T3's normal query path resolves --settings files
  // before this point. Unknown routes keep Claude's own operational defaults.
  if (!limits || typeof settings === "string") return settings;
  const base = (settings ?? {}) as Settings;
  const object = (value: unknown): Settings => value && typeof value === "object" && !Array.isArray(value) ? value as Settings : {};
  const requested = typeof base.autoCompactWindow === "number" && base.autoCompactWindow > 0 ? base.autoCompactWindow : undefined;
  const perModel = object(base.modelSettings);
  return {
    ...base,
    env: { ...object(base.env),
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(limits.input ?? limits.context),
      ...(limits.output ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Math.min(128000, limits.output)) } : {}),
    },
    // Native helper models inherit the parent's environment. Give every known
    // route its own compaction cap, and unknown helpers a conservative default.
    autoCompactWindow: requested ?? 200000,
    modelSettings: {
      ...perModel,
      ...Object.fromEntries(Object.entries(models).map(([id, row]) => {
        const previous = object(perModel[id]);
        const explicit = typeof previous.autoCompactWindow === "number" && previous.autoCompactWindow > 0 ? previous.autoCompactWindow : Infinity;
        return [id, { ...previous, autoCompactWindow: Math.min(
          1000000, Math.max(100000, row.input ?? row.context), requested ?? Infinity, explicit,
        ) }];
      })),
    },
  };
}
