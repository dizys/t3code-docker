import { source as legacy } from './gateway-quota-source.mjs';

// Bounded provider-table layout from v0.1.9-nightly.20261110.4491.
// Native CI compiles the full source and exercises the real readers over HTTP.
export const source = {
  ...legacy,
  'apps/server/src/usage/cliproxyApi.ts': `import { codexPlanLabel } from "../provider/CodexProvider.ts";
const AuthFile = Schema.Struct({
  id: Schema.String,
  auth_index: Schema.String,
  provider: Schema.String,
  email: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  project_id: Schema.optional(Schema.String),
});
const AuthFiles = Schema.Struct({ files: Schema.Array(AuthFile) });
interface HubProvider {
  readonly driver: ProviderDriverKind;
  readonly header: (account: AuthFile, platform: NodeJS.Platform, architecture: NodeJS.Architecture) => Record<string, string>;
}
// Keyed by the auth-files \x60provider\x60; accounts of any other provider are skipped.
const HUB_PROVIDERS = new Map<string, HubProvider>([
  ["codex", CODEX_HUB],
  ["claude", CLAUDE_HUB],
  ["xai", GROK_HUB],
  ["antigravity", ANTIGRAVITY_HUB],
]);
function management() {
  // Hub responses can contain credentials; expose only failure kind, HTTP status or Node code.
  return describeManagementFailure(error);
}
  const authFiles = Effect.fn("CliproxyApi.authFiles")(function* (hub: CliproxyHub) {
    const response = yield* management(hub, "auth-files");
    return (yield* decodeAuthFiles(response)).files;
  });

  const apiCall = Effect.fn("CliproxyApi.apiCall")(function* (
    hub: CliproxyHub,
    account: AuthFile,
    header: Record<string, string>,
    url: string,
    data?: unknown,
  ) {
    const raw = yield* management(hub, "api-call", {
      auth_index: account.auth_index,
      method: data === undefined ? "GET" : "POST",
      url,
      header,
      ...(data === undefined ? {} : { data: yield* encodeJson(data) }),
    });
    return raw;
  });

  const readAccount = Effect.fn("CliproxyApi.readAccount")(function* (
    hub: CliproxyHub,
    account: AuthFile,
    provider: HubProvider,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const call: HubCall = (url, data) =>
      apiCall(hub, account, provider.header(account, platform, architecture), url, data);
    const reading = yield* provider.read({ account, call, checkedAt }).pipe(
      Effect.provideService(Digest.Digest, digest),
      Effect.orElseSucceed(() => ({
        ...listedIdentity(account),
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "The hub could not read this account's usage.",
        }),
      })),
    );
    return { id: account.id, driver: provider.driver, ...reading };
  });

  const readAccounts = Effect.fn("CliproxyApi.readAccounts")(function* (
    hub: CliproxyHub,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const accounts = yield* authFiles(hub).pipe(
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({ detail: "The hub could not list accounts." }),
      ),
    );
    return yield* Effect.forEach(
      accounts.flatMap((account) => {
        const provider = HUB_PROVIDERS.get(account.provider);
        return provider && !account.disabled ? [{ account, provider }] : [];
      }),
      ({ account, provider }) => readAccount(hub, account, provider),
      { concurrency: 4 },
    );
  });

  const consume = (hub, account, creditId) => apiCall(hub, account,
    CODEX_HUB.header(account, platform, architecture), CREDIT_URL, { creditId });
`,
};
