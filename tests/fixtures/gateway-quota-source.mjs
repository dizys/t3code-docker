// Bounded anchors from T3 Stable 0.1.7 and Nightly 0.1.8. Native CI applies
// the patch to the full tag and exercises the resulting executable over HTTP.
export const source = {
  'apps/server/src/usage/cliproxyApi.ts': `import { codexPlanLabel } from "../provider/CodexProvider.ts";
const AuthFile = Schema.Struct({
  id: Schema.String,
  auth_index: Schema.String,
  provider: Schema.String,
  email: Schema.optional(Schema.String),
});
const AuthFiles = Schema.Struct({ files: Schema.Array(AuthFile) });
function authFiles() {
    return (yield* decodeAuthFiles(response)).files;
}
const apiCall = Effect.fn("CliproxyApi.apiCall")(function* (
    hub: CliproxyHub,
    account: typeof AuthFile.Type,
    url: string,
    data?: unknown,
  ) {
    const raw = yield* management(hub, "api-call", {
      header,
    });
});
const readAccount = Effect.fn("CliproxyApi.readAccount")(function* (hub, account) {
    const base = {
      driver: ProviderDriverKind.make(account.provider === "codex" ? "codex" : "claudeAgent"),
    };
    const read = Effect.gen(function* () {
      // Existing Claude and Codex readers.
    });
});
const readAccounts = accounts.filter(
  (account) =>
    !account.disabled && (account.provider === "codex" || account.provider === "claude"),
);`,
  'packages/shared/src/usageLimits.ts': `export function collectLimitNotices() {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.error) {
        notices.push(\x60\${label(environmentLabel, source.label)}: \${source.error}\x60);
      } else if (source.accounts.length === 0) {
        notices.push(\x60\${label(environmentLabel, source.label)}: No accounts reported.\x60);
      }
    }
}`,
  'apps/web/src/components/usage/UsageLimitsPooled.tsx': `function Pool() {
  const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
}`,
};
