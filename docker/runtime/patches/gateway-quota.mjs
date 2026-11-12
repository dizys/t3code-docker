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
  const legacyDriver = 'driver: ProviderDriverKind.make(account.provider === "codex" ? "codex" : "claudeAgent"),';
  const providerTable = /HUB_PROVIDERS|interface HubProvider\b|provider: HubProvider\b/.test(source[files[0]] ?? "");
  if (providerTable && source[files[0]].includes(legacyDriver)) {
    throw new Error(`The gateway-quota patch no longer matches ${files[0]}. Review the upstream source before publishing this runtime.`);
  }
  change(files[0], 'import { codexPlanLabel }', 'import { makeAdditionalQuotaReader, quotaDriver } from "./cliproxyQuota.ts";\nimport { codexPlanLabel }');
  const extraFields = `
  name: Schema.optional(Schema.String),
  runtime_only: Schema.optional(Schema.Boolean),
  supports_quota: Schema.optional(Schema.Boolean),
  quota_plugin_id: Schema.optional(Schema.String),`;
  if (providerTable) {
    // Nightly's native Antigravity reader already owns project_id.
    change(files[0], '  project_id: Schema.optional(Schema.String),', '  project_id: Schema.optional(Schema.String),');
    change(files[0], `  email: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  project_id: Schema.optional(Schema.String),`, `  email: Schema.optional(Schema.String),${extraFields}
  disabled: Schema.optional(Schema.Boolean),
  project_id: Schema.optional(Schema.String),`);
  } else {
    change(files[0], '  email: Schema.optional(Schema.String),', `  email: Schema.optional(Schema.String),${extraFields}
  project_id: Schema.optional(Schema.String),`);
  }
  change(files[0], 'const AuthFiles = Schema.Struct({ files: Schema.Array(AuthFile) });', 'const AuthFiles = Schema.Struct({ files: Schema.Array(Schema.Unknown) });');
  change(files[0], '    return (yield* decodeAuthFiles(response)).files;', `    return (yield* decodeAuthFiles(response)).files.filter(Schema.is(AuthFile))
      .filter((account) => account.id.trim() && account.auth_index.trim() && account.provider.trim());`);
  if (providerTable) {
    // Keep the native provider table, transport, TLS diagnostics and reset-credit
    // calls intact. Only accounts without a native reader use our extension.
    for (const anchor of [
      'interface HubProvider {',
      'const HUB_PROVIDERS = new Map<string, HubProvider>([',
      '      apiCall(hub, account, provider.header(account, platform, architecture), url, data);',
      `  const apiCall = Effect.fn("CliproxyApi.apiCall")(function* (
    hub: CliproxyHub,
    account: AuthFile,
    header: Record<string, string>,
    url: string,
    data?: unknown,
  ) {`,
    ]) change(files[0], anchor, anchor);
    change(files[0], `  const readAccount = Effect.fn("CliproxyApi.readAccount")(function* (
    hub: CliproxyHub,
    account: AuthFile,
    provider: HubProvider,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const call: HubCall = (url, data) =>
      apiCall(hub, account, provider.header(account, platform, architecture), url, data);`, `  const readAccount = Effect.fn("CliproxyApi.readAccount")(function* (
    hub: CliproxyHub,
    account: AuthFile,
    provider: HubProvider | undefined,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!provider) {
      const readAdditionalQuota = makeAdditionalQuotaReader(
        (path, body) => management(hub, path, body),
        (entry, url, data, headers) => apiCall(hub, { ...account, ...entry }, headers, url, data),
      );
      return {
        id: account.id,
        driver: ProviderDriverKind.make(quotaDriver(account.provider)),
        ...listedIdentity(account),
        ...yield* readAdditionalQuota(account, checkedAt),
      };
    }
    const call: HubCall = (url, data) =>
      apiCall(hub, account, provider.header(account, platform, architecture), url, data);`);
    change(files[0], 'return provider && !account.disabled ? [{ account, provider }] : [];', 'return !account.disabled ? [{ account, provider }] : [];');
    change(files[0], '// Keyed by the auth-files `provider`; accounts of any other provider are skipped.', '// Keyed by the auth-files `provider`; other providers use the additional quota reader.');
  } else {
    change(files[0], '    data?: unknown,\n  ) {', '    data?: unknown,\n    requestHeaders?: Record<string, string>,\n  ) {');
    change(files[0], '      header,', '      header: requestHeaders ?? header,');
    change(files[0], legacyDriver, 'driver: ProviderDriverKind.make(quotaDriver(account.provider)),');
    change(files[0], '    const read = Effect.gen(function* () {', `    if (account.provider !== "codex" && account.provider !== "claude") {
      const readAdditionalQuota = makeAdditionalQuotaReader(
        (path, body) => management(hub, path, body),
        (entry, url, data, headers) => apiCall(hub, entry, url, data, headers),
      );
      return { ...base, ...yield* readAdditionalQuota(account, checkedAt) };
    }
    const read = Effect.gen(function* () {`);
    change(files[0], '!account.disabled && (account.provider === "codex" || account.provider === "claude"),', '!account.disabled,');
  }
  // Stable uses an array; current Nightly deduplicates notices in a Set.
  // Keep that collector and require exactly one known insertion site.
  const noticeAnchor = method => `      } else if (source.accounts.length === 0) {
        notices.${method}(\x60${'${label(environmentLabel, source.label)}'}: No accounts reported.\x60);
      }`;
  const noticeMethods = ['push', 'add'].filter(method => typeof next[files[1]] === 'string' && next[files[1]].includes(noticeAnchor(method)));
  if (noticeMethods.length !== 1) throw new Error(`The gateway-quota patch no longer matches ${files[1]}. Review the upstream source before publishing this runtime.`);
  const [noticeMethod] = noticeMethods;
  change(files[1], noticeAnchor(noticeMethod), `${noticeAnchor(noticeMethod)}
      for (const account of source.accounts) {
        const notice = limitsNotice(account.usageLimits);
        if (notice) notices.${noticeMethod}(\x60${'${label(environmentLabel, source.label)}'} · ${'${account.email ?? hubAccountName(account)}'}: ${'${notice}'}\x60);
      }`);
  // Unknown gateway providers are valid contract drivers. Give their pool a
  // human-readable label without assigning it to a different native driver.
  change(files[2], '  const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);', '  const label = providerClients.get(pool.driver)?.label ?? (pool.driver === "opencode-go" ? "OpenCode Go" : String(pool.driver));');
  return next;
}
