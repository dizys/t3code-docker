import { source as providerTableSource } from './gateway-quota-provider-table-source.mjs';

// The shared name helper and localized collector from v0.1.11-nightly.20261119.4918.
export const source = {
  ...providerTableSource,
  'packages/shared/src/usageLimits.ts': String.raw`
const hubAccountName = (account: { readonly id: string }) => account.id.replace(/\.json$/i, "");
`,
  'packages/shared/src/usageLimitsCopy.ts': `import {
  type LimitPresentations,
  providersWithLimits,
} from "./usageLimits.ts";

export function collectLimitNotices(
  presentations: LimitPresentations,
  resolve: MFunctionType = mFallback,
): readonly string[] {
  const label = (environmentLabel: string, subject: string) =>
    presentations.size > 1 ? \x60\${environmentLabel} · \${subject}\x60 : subject;
  const notices = new Set<string>();
  for (const presentation of presentations.values()) {
    const environmentLabel = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (provider.usageLimits?.unavailable?.reason === "unsupported") continue;
      const notice = provider.usageLimits ? limitsNotice(provider.usageLimits, resolve) : null;
      const name = provider.displayName?.trim() || String(provider.driver);
      if (notice) notices.add(\x60\${label(environmentLabel, name)}: \${notice}\x60);
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.error) {
        notices.add(\x60\${label(environmentLabel, source.label)}: \${source.error}\x60);
      } else if (source.accounts.length === 0) {
        notices.add(
          resolve(
            msg("{source}: No accounts reported.", {
              source: label(environmentLabel, source.label),
            }),
          ),
        );
      }
    }
  }
  return [...notices];
}`,
};
