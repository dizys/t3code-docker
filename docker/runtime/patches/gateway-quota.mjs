import { readFileSync } from "node:fs";

export const files = ["apps/server/src/usage/cliproxyApi.ts", "packages/shared/src/usageLimits.ts", "apps/web/src/components/usage/UsageLimitsPooled.tsx"];
export const quotaFile = "apps/server/src/usage/cliproxyQuota.ts";
export const creates = [quotaFile];
export const assets = [new URL("./cliproxy-quota.ts", import.meta.url)];
export const quotaSource = readFileSync(assets[0], "utf8");
const replaceOnce = (text, before, after, file) => {
  if (typeof text !== "string" || text.split(before).length !== 2) throw new Error(`The gateway-quota patch no longer matches ${file}. Review the upstream source before publishing this runtime.`);
  return text.replace(before, after);
};

export function patchGatewayQuota(source) {
  if (Object.hasOwn(source, quotaFile)) throw new Error("The gateway-quota module already exists. Review the upstream source before publishing this runtime.");
  const next = { ...source, [quotaFile]: quotaSource };
  const change = (file, before, after) => { next[file] = replaceOnce(next[file], before, after, file); };
  change(files[0], 'import { codexPlanLabel }', 'import { makeAdditionalQuotaReader, quotaDriver } from "./cliproxyQuota.ts";\nimport { codexPlanLabel }');
  change(files[0], '  email: Schema.optional(Schema.String),', `  email: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
  runtime_only: Schema.optional(Schema.Boolean),
  supports_quota: Schema.optional(Schema.Boolean),
  quota_plugin_id: Schema.optional(Schema.String),`);
  change(files[0], 'const AuthFiles = Schema.Struct({ files: Schema.Array(AuthFile) });', 'const AuthFiles = Schema.Struct({ files: Schema.Array(Schema.Unknown) });');
  change(files[0], '    return (yield* decodeAuthFiles(response)).files;', `    return (yield* decodeAuthFiles(response)).files.filter(Schema.is(AuthFile))
      .filter((account) => account.id.trim() && account.auth_index.trim() && account.provider.trim());`);
  change(files[0], '    data?: unknown,\n  ) {', '    data?: unknown,\n    requestHeaders?: Record<string, string>,\n  ) {');
  change(files[0], '      header,', '      header: requestHeaders ?? header,');
  change(files[0], 'driver: ProviderDriverKind.make(account.provider === "codex" ? "codex" : "claudeAgent"),', 'driver: ProviderDriverKind.make(quotaDriver(account.provider)),');
  change(files[0], '    const read = Effect.gen(function* () {', `    if (account.provider !== "codex" && account.provider !== "claude") {
      const readAdditionalQuota = makeAdditionalQuotaReader(
        (path, body) => management(hub, path, body),
        (entry, url, data, headers) => apiCall(hub, entry, url, data, headers),
      );
      return { ...base, ...yield* readAdditionalQuota(account, checkedAt) };
    }
    const read = Effect.gen(function* () {`);
  change(files[0], '!account.disabled && (account.provider === "codex" || account.provider === "claude"),', '!account.disabled,');
  change(files[1], `      } else if (source.accounts.length === 0) {
        notices.push(\x60${'${label(environmentLabel, source.label)}'}: No accounts reported.\x60);
      }`, `      } else if (source.accounts.length === 0) {
        notices.push(\x60${'${label(environmentLabel, source.label)}'}: No accounts reported.\x60);
      }
      for (const account of source.accounts) {
        const notice = limitsNotice(account.usageLimits);
        if (notice) notices.push(\x60${'${label(environmentLabel, source.label)}'} · ${'${account.email ?? hubAccountName(account)}'}: ${'${notice}'}\x60);
      }`);
  // Unknown gateway providers are valid contract drivers. Give their pool a
  // human-readable label without assigning it to a different native driver.
  change(files[2], '  const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);', '  const label = providerClients.get(pool.driver)?.label ?? (pool.driver === "opencode-go" ? "OpenCode Go" : String(pool.driver));');
  return next;
}
