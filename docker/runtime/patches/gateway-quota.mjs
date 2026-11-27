import { readFileSync } from "node:fs";

const sharedNoticesFile = "packages/shared/src/usageLimits.ts";
const localizedNoticesFile = "packages/shared/src/usageLimitsCopy.ts";
export const files = ["apps/server/src/usage/cliproxyApi.ts", sharedNoticesFile, "apps/web/src/components/usage/UsageLimitsPooled.tsx"];
export const optionalFiles = [localizedNoticesFile];
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
  const modernCall = 'apiCall(hub, account, provider.header(account), url, data);';
  const platformCall = 'apiCall(hub, account, provider.header(account, platform, architecture), url, data);';
  const modernHeader = `    const call: HubCall = (url, data) => ${modernCall}`;
  const platformHeader = `    const call: HubCall = (url, data) =>
      ${platformCall}`;
  const accountHeader = providerTable && source[files[0]].includes(modernHeader);
  if (providerTable && (source[files[0]].includes(legacyDriver) || (accountHeader && source[files[0]].includes(platformHeader)))) {
    throw new Error(`The gateway-quota patch no longer matches ${files[0]}. Review the upstream source before publishing this runtime.`);
  }
  change(files[0], 'import { codexPlanLabel }', 'import { makeAdditionalQuotaReader, quotaDriver } from "./cliproxyQuota.ts";\nimport { codexPlanLabel }');
  const extraFields = `
  name: Schema.optional(Schema.String),
  runtime_only: Schema.optional(Schema.Boolean),
  supports_quota: Schema.optional(Schema.Boolean),
  quota_plugin_id: Schema.optional(Schema.String),`;
  if (accountHeader) {
    // Newer releases removed the native Antigravity reader and its project field.
    change(files[0], `  email: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  id_token: Schema.optional(`, `  email: Schema.optional(Schema.String),${extraFields}
  disabled: Schema.optional(Schema.Boolean),
  project_id: Schema.optional(Schema.String),
  id_token: Schema.optional(`);
  } else if (providerTable) {
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
    const headerCall = accountHeader ? modernHeader : platformHeader;
    for (const anchor of [
      'interface HubProvider {',
      'const HUB_PROVIDERS = new Map<string, HubProvider>([',
      accountHeader ? modernCall : platformCall,
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
${headerCall}`, `  const readAccount = Effect.fn("CliproxyApi.readAccount")(function* (
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
${headerCall}`);
    change(files[0], 'return provider && !account.disabled ? [{ account, provider }] : [];', 'return !account.disabled ? [{ account, provider }] : [];');
    change(files[0], '// Keyed by the auth-files `provider`; accounts of any other provider are skipped.', '// Keyed by the auth-files `provider`; other providers use the additional quota reader.');
    // The Nightly response still carries unreadProviders. Every enabled account
    // now has a reading, including an explicit reason if a reader is unavailable.
    if (next[files[0]].includes('unreadProviders')) {
      change(files[0], `    const unreadProviders = [
      ...new Set(
        accounts.flatMap((account) =>
          account.disabled || HUB_PROVIDERS.has(account.provider) || !account.provider.trim()
            ? []
            : [account.provider.trim()],
        ),
      ),
    ].toSorted();`, '    const unreadProviders: ReadonlyArray<string> = [];');
    }
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
  // Older releases collect notices in usageLimits.ts. The localized
  // collector moved to usageLimitsCopy.ts and takes the caller's resolver.
  const noticeAnchor = method => `      } else if (source.accounts.length === 0) {
        notices.${method}(\x60${'${label(environmentLabel, source.label)}'}: No accounts reported.\x60);
      }`;
  const sharedNotices = next[sharedNoticesFile];
  const noticeMethods = ['push', 'add'].filter(method => typeof sharedNotices === 'string' && sharedNotices.includes(noticeAnchor(method)));
  const localized = Object.hasOwn(next, localizedNoticesFile);
  if (noticeMethods.length !== (localized ? 0 : 1)) throw new Error(`The gateway-quota patch no longer matches ${sharedNoticesFile}. Review the upstream source before publishing this runtime.`);
  const nativeFailedAccounts = '  const failedAccounts = unshownFailedHubAccounts(presentations);';
  if (localized && next[localizedNoticesFile].includes(nativeFailedAccounts)) {
    change(localizedNoticesFile, nativeFailedAccounts, nativeFailedAccounts);
    change(sharedNoticesFile, '        if (account.usageLimits.unavailable?.reason !== "probeFailed") continue;', `        const unavailable = account.usageLimits.unavailable;
        if (
          unavailable?.reason !== "probeFailed" &&
          !(unavailable?.reason === "unsupported" && unavailable.message)
        ) continue;`);
  } else if (localized) {
    const accountName = String.raw`const hubAccountName = (account: { readonly id: string }) => account.id.replace(/\.json$/i, "");`;
    change(sharedNoticesFile, `\n${accountName}\n`, `\nexport ${accountName}\n`);
    change(localizedNoticesFile, '  providersWithLimits,', '  hubAccountName,\n  providersWithLimits,');
    const anchor = `      } else if (source.accounts.length === 0) {
        notices.add(
          resolve(
            msg("{source}: No accounts reported.", {
              source: label(environmentLabel, source.label),
            }),
          ),
        );
      }`;
    change(localizedNoticesFile, anchor, `${anchor}
      for (const account of source.accounts) {
        const notice = limitsNotice(account.usageLimits, resolve);
        if (!notice) continue;
        notices.add(
          resolve(
            msg("{source} · {account}: {notice}", {
              source: label(environmentLabel, source.label),
              account: account.email ?? hubAccountName(account),
              notice,
            }),
          ),
        );
      }`);
  } else {
    const [noticeMethod] = noticeMethods;
    const anchor = noticeAnchor(noticeMethod);
    change(sharedNoticesFile, anchor, `${anchor}
      for (const account of source.accounts) {
        const notice = limitsNotice(account.usageLimits);
        if (notice) notices.${noticeMethod}(\x60${'${label(environmentLabel, source.label)}'} · ${'${account.email ?? hubAccountName(account)}'}: ${'${notice}'}\x60);
      }`);
  }
  // Unknown gateway providers are valid contract drivers. Give their pool a
  // human-readable label without assigning it to a different native driver.
  change(files[2], '  const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);', '  const label = providerClients.get(pool.driver)?.label ?? (pool.driver === "opencode-go" ? "OpenCode Go" : String(pool.driver));');
  return next;
}
