import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { UsageLimitSourceError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// These responses can contain API keys. Project only quota fields, never the
// original payload, into snapshots, diagnostics or errors.
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;
const number = (value: unknown): number | undefined => {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
};
const iso = (value: unknown, seconds = false): string | undefined => {
  const ms = seconds ? (number(value) ?? NaN) * 1000
    : typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
  // Match the contract's four-digit ISO dates and reject missing/zero epochs.
  return Number.isFinite(ms) && ms > 0 && ms <= 253402300799999 ? new Date(ms).toISOString() : undefined;
};
const json = (value: unknown): Record<string, unknown> => {
  if (typeof value === "string") value = JSON.parse(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid quota response");
  return record(value);
};
const period = (value: string): { kind: ServerProviderUsageWindow["kind"]; label: string; windowDurationMins?: number } => {
  switch (value.toLowerCase()) {
    case "5h": case "five-hour": case "five_hour": return { kind: "session", label: "5 hours", windowDurationMins: 300 };
    case "week": case "weekly": return { kind: "weekly", label: "Weekly", windowDurationMins: 10080 };
    case "day": case "daily": return { kind: "other", label: "Daily", windowDurationMins: 1440 };
    case "month": case "monthly": return { kind: "monthly", label: "Monthly" };
    default: return { kind: "other", label: value || "Quota" };
  }
};

export function quotaDriver(provider: string): string {
  if (provider === "claude") return "claudeAgent";
  if (provider === "meta") return "muse";
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(provider) ? provider : "gateway";
}

export function parseGroupedQuota(value: unknown): Pick<ServerProviderUsageLimits, "windows"> & { plan?: string } {
  const root = json(value), windows: ServerProviderUsageWindow[] = [], ids = new Set<string>();
  const groups = Array.isArray(root.groups) ? root.groups : [];
  for (const [groupIndex, raw] of groups.slice(0, 100).entries()) {
    const group = record(raw), groupName = text(group.displayName ?? group.display_name) ?? `Quota group ${groupIndex + 1}`;
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const [index, entry] of buckets.slice(0, 100).entries()) {
      const bucket = record(entry);
      const remaining = number(bucket.remainingFraction ?? bucket.remaining_fraction);
      if (remaining === undefined || remaining < 0 || remaining > 1) continue;
      const window = text(bucket.window) ?? "", facts = period(window);
      const bucketLabel = text(bucket.displayName ?? bucket.display_name) ?? text(bucket.description) ?? facts.label;
      // Preserve distinct buckets with the same period and different labels.
      const key = text(bucket.bucketId ?? bucket.bucket_id) ?? `${window}:${bucketLabel || `bucket-${index + 1}`}`;
      const id = `${encodeURIComponent(groupName)}:${encodeURIComponent(key)}`;
      if (ids.has(id)) continue;
      ids.add(id);
      const resetsAt = iso(bucket.resetTime ?? bucket.reset_time);
      windows.push({
        id, ...facts, label: `${groupName} · ${bucketLabel}`,
        usedPercent: Math.round((1 - remaining) * 1000000) / 10000,
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  const subscription = record(root.subscription), plan = text(subscription.tierName ?? subscription.tier_name) ?? text(subscription.plan);
  return { windows, ...(plan ? { plan } : {}) };
}

export function parseMetaQuota(value: unknown): Pick<ServerProviderUsageLimits, "windows"> & { plan?: string } {
  const root = json(value), usage = record(root.subs_usage), windows: ServerProviderUsageWindow[] = [];
  for (const id of ["window", "weekly"] as const) {
    const raw = record(usage[id]), used = number(raw.used_percent);
    if (used === undefined || used < 0) continue;
    const resetsAt = iso(raw.resets_at, true), duration = number(raw.window_duration_mins);
    const windowDurationMins = duration !== undefined && Number.isSafeInteger(duration) && duration > 0 ? duration : undefined;
    windows.push({
      id, kind: id === "weekly" ? "weekly" : "session",
      label: id === "weekly" ? "Weekly" : windowDurationMins ? `${windowDurationMins / 60} hours` : "Session",
      usedPercent: Math.min(100, used),
      ...(resetsAt ? { resetsAt } : {}),
      ...(windowDurationMins ? { windowDurationMins } : {}),
    });
  }
  const plan = text(root.subs_tier_name) ?? text(usage.tier);
  return { windows, ...(plan ? { plan } : {}) };
}

interface QuotaAccount {
  readonly id: string;
  readonly provider: string;
  readonly auth_index: string;
  readonly name?: string;
  readonly project_id?: string;
  readonly runtime_only?: boolean;
  readonly supports_quota?: boolean;
  readonly quota_plugin_id?: string;
}
type Management = (path: string, body?: unknown) => Effect.Effect<unknown, unknown>;
type ApiCall = (account: QuotaAccount, url: string, data: unknown, headers: Record<string, string>) => Effect.Effect<string, unknown>;
class QuotaUnavailable extends Error {
  constructor(readonly reason: "unsupported" | "probeFailed", message: string) { super(message); }
}
const antigravityHeaders = {
  Authorization: "Bearer $TOKEN$", "Content-Type": "application/json",
  "User-Agent": "antigravity/hub/2.23.0 darwin/arm64",
};
const antigravityHosts = ["daily-cloudcode-pa.googleapis.com", "daily-cloudcode-pa.sandbox.googleapis.com", "cloudcode-pa.googleapis.com"];

export function makeAdditionalQuotaReader(management: Management, apiCall: ApiCall) {
  const read = Effect.fn("CliproxyApi.additionalQuota")(function* (account: QuotaAccount) {
    if (account.provider === "antigravity") {
      let project = text(account.project_id);
      if (!project) {
        const assist = yield* apiCall(account,
          "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
          { metadata: { ideType: "ANTIGRAVITY" } }, antigravityHeaders).pipe(
            Effect.flatMap(body => Effect.try(() => json(body))));
        project = text(assist.cloudaicompanionProject) ?? text(record(assist.cloudaicompanionProject).id);
      }
      if (!project) return yield* Effect.fail(new QuotaUnavailable("probeFailed", "Antigravity did not report a project for this account. Check its sign-in in CLIProxyAPI."));
      let lastError: unknown;
      for (const host of antigravityHosts) {
        const result = yield* apiCall(account, `https://${host}/v1internal:retrieveUserQuotaSummary`, { project }, antigravityHeaders).pipe(
          Effect.flatMap(body => Effect.try(() => parseGroupedQuota(body))), Effect.result);
        if (result._tag === "Success" && result.success.windows.length) return result.success;
        if (result._tag === "Failure") lastError = result.failure;
      }
      return yield* Effect.fail(lastError ?? new QuotaUnavailable("probeFailed", "Antigravity returned no quota windows. Try refreshing Limits later."));
    }
    if (account.provider === "meta") {
      if (account.runtime_only) return yield* Effect.fail(new QuotaUnavailable("unsupported", "Muse quota needs an OAuth account with a saved DCA token in CLIProxyAPI."));
      // $TOKEN$ resolves to the inference key for Meta, not its quota credential.
      // Keep the downloaded DCA token inside this request. Never return or log it.
      const auth = record(yield* management(`auth-files/download?name=${encodeURIComponent(account.name ?? account.id)}`));
      const token = typeof auth.dca_token === "string" ? auth.dca_token.trim() : "";
      if (!/^dca:[^\s]+$/.test(token)) return yield* Effect.fail(new QuotaUnavailable("unsupported", "Muse quota needs an OAuth account with a saved DCA token in CLIProxyAPI."));
      const body = yield* apiCall(account, "https://api.meta.ai/muse-code/key", {}, {
        Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json", "x-api-version": "1.0.0",
      });
      return yield* Effect.try(() => parseMetaQuota(body));
    }
    // Let the hub select the registered provider, including OpenCode-Go and
    // declarative probes. Pin its advertised plugin when supplied by v8.
    const result = yield* management("quota/fetch", {
      auth_index: account.auth_index,
      ...(account.quota_plugin_id ? { plugin_id: account.quota_plugin_id } : {}),
    }).pipe(Effect.result);
    if (result._tag === "Failure") {
      const missing = Schema.is(UsageLimitSourceError)(result.failure) && /HTTP (404|405|501)\b/.test(result.failure.detail);
      if (missing) return yield* Effect.fail(new QuotaUnavailable("unsupported", "CLIProxyAPI has no quota reader for this account. Install or update its quota plugin in CLIProxyAPI."));
      return yield* Effect.fail(result.failure);
    }
    return yield* Effect.try(() => parseGroupedQuota(result.success));
  });
  return Effect.fn("CliproxyApi.readAdditionalQuota")(function* (account: QuotaAccount, checkedAt: string) {
    const result = yield* read(account).pipe(Effect.timeout("30 seconds"), Effect.result);
    if (result._tag === "Success") {
      const { plan, windows } = result.success;
      return { ...(plan ? { plan } : {}), usageLimits: {
        checkedAt, windows,
        ...(!windows.length ? { unavailable: { reason: "probeFailed" as const, message: account.provider === "meta"
          ? "Meta did not include subscription usage in its quota response. Quota is unknown; try refreshing Limits later."
          : "The provider returned no quota windows. Quota is unknown; try refreshing Limits later." } } : {}),
      } };
    }
    const error = result.failure;
    return { usageLimits: { checkedAt, windows: [], unavailable: {
      reason: error instanceof QuotaUnavailable ? error.reason : "probeFailed" as const,
      message: error instanceof QuotaUnavailable ? error.message
        : Schema.is(UsageLimitSourceError)(error) ? error.detail
        : "The hub could not read this account's quota. Try refreshing Limits or check its sign-in in CLIProxyAPI.",
    } } };
  });
}
