import { source as providerTableSource } from './gateway-quota-provider-table-source.mjs';

// Complete notice collector from v0.1.10-nightly.20261111.4544. Other anchors
// retain the provider-table layout; native CI compiles the full release tag.
export const source = {
  ...providerTableSource,
  'packages/shared/src/usageLimits.ts': `export function collectLimitNotices(presentations: LimitPresentations): readonly string[] {
  const label = (environmentLabel: string, subject: string) =>
    presentations.size > 1 ? \x60\${environmentLabel} · \${subject}\x60 : subject;
  const notices = new Set<string>();
  for (const presentation of presentations.values()) {
    const environmentLabel = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (provider.usageLimits?.unavailable?.reason === "unsupported") continue;
      const notice = provider.usageLimits ? limitsNotice(provider.usageLimits) : null;
      const name = provider.displayName?.trim() || String(provider.driver);
      if (notice) notices.add(\x60\${label(environmentLabel, name)}: \${notice}\x60);
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.error) {
        notices.add(\x60\${label(environmentLabel, source.label)}: \${source.error}\x60);
      } else if (source.accounts.length === 0) {
        notices.add(\x60\${label(environmentLabel, source.label)}: No accounts reported.\x60);
      }
    }
  }
  return [...notices];
}`,
};
