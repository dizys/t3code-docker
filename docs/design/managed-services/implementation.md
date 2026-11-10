# PR #119 implementation and evidence

Status: implementation under verification. Keep the PR in draft until native
image checks and the remaining release gates have evidence. The architecture
documents describe the full target. A prototype pass or a local fixture pass
does not close the complete production matrix in `acceptance.csv`.

## Implemented behavior

- Shared Services surface and Access Devices / Connections / SSH tabs using
  the existing routes, Kit layers, appearance tokens, forms and inspector.
- Optional image-approved OpenSSH, Tailscale and cloudflared downloads. Exact
  image-owned metadata, digest/size verification, inspected archive extraction,
  protected staging, durable file manifests and offline verified-cache reuse.
- Tini with separate system/user s6 domains. A compiled subreaper owns payload
  groups and controller installer children. Replacement waits for cleanup and
  s6 finish acknowledgement. Custom workers drop account privileges, groups,
  capabilities and setuid escalation before reading user definitions.
- Per-domain SQLite intent, expected revisions, durable operation IDs,
  idempotency keys, sequenced events, resumable nested forwarding and explicit
  recovery phases. Stop for now, disable, removal, uninstall and provider logout
  have distinct behavior. Access interruptions require a recorded acknowledgement
  of an alternative access path.
- Literal argv, explicit shell mode, installed mise pins, isolated resolution,
  environment rows, Vault Token references, local health, bounded crash backoff
  and separate bounded output. Tool/Vault removal protects disabled and pending
  registrations, including previous configuration needed for recovery.
- Existing-network registrations and client SSH/editor instructions. Managed
  userspace Tailscale sign-in and explicit TCP Serve operations. Cloudflare
  named connector configuration stays distinct from provider hostname/policy
  ownership and native T3 HTTP quick tunnels.
- A lazy cloudflared adapter keeps native T3 process ownership, verifies cached
  bytes, and performs no download for a version probe. Retained catalogue
  services can be manually updated after a new image supplies an exact target.
- Last-known rows remain visible as unavailable when a controller disconnects.
  Browser submission recovery reuses the original key after a lost response.

## Executed local checks

The full local Node suite passes all 1,790 tests after integration with the
latest main branch, including Plugins. The Services browser audit
passes all four layouts with lost-response recovery, route setup and removal,
reported client evidence, access-impact acknowledgement and private-key input
clearing. Notifications remain hidden while a service dialog or editor is open,
so they cannot cover its actions on a phone. The Access regression audit passes
all ten layout/appearance combinations.

The native ARM proof uses real SQLite, HTTP, kernel process groups, a compiled
monitor and real s6 binaries extracted from Debian packages. On this development
host the s6 binaries are relocated into a temporary directory; production CI
uses the unmodified image packages. It verifies exact literal arguments, a
minimal environment, stdout/stderr, local readiness, single ownership, ignored
TERM, descendant and monitor exit, runner death, restart, temporary stop and
disable. Real mise inventory and exact Node resolution ignore hostile project
and home hooks. No live home, credential or production service is opened.

`tests/services*.test.mjs` adds hostile schema, stale review, dependency,
idempotency, forwarding recovery, rollback recovery, crash budget, archive and
log tests. `tests/t3-session.test.mjs` verifies that maintenance permission is
checked again after a scope grant or revocation.

The Services browser audit uses actual controller journals and inert artifact
and process adapters. It exercises 1440px light, 390px dark, 1198px embedded dark
and 360px light at 20px interface text. The Access regression audit exercises
five layouts in light and dark, including the native embedding fixture. This
is browser automation of the real console, not provider/network acceptance.

Commands:

```sh
node --test tests/*.test.mjs
node scripts/services-native-smoke.mjs
node scripts/services-ui-audit.mjs
node scripts/access-fixture-audit.mjs
scripts/test-services-e2e.sh IMAGE
```

The browser scripts need Playwright Core and a Chromium executable. CI installs
the pinned browser driver and retains screenshots as `managed-services-console`.
The image test is wired into both native architectures and both image variants.
It creates and removes its own containers and volumes.

## Native image acceptance in progress

The disposable image test verifies absent baked SSH, real on-demand dependency
closure, positive SSH login, root/password denial, public host-key sidecar
recovery, mismatch refusal, connector archive/CLI compatibility, token privacy,
worker credentials/capabilities, restart and offline recreation. Recreation
changes PUID/PGID and checks a fresh SSH login with the same host identity.
The installed Tailscale CLI is exercised against a disposable Unix socket
LocalAPI for background TCP Serve, JSON status, targeted removal and retention
of another route. This checks the CLI/configuration contract without a tailnet
account; it does not establish remote forwarding or provider acceptance.
Tampered cached bytes must fail before an offline reinstall; restoring the
original bytes permits verified reuse. A separate rootless container tests
custom services without protected system storage. It retains a `noexec` home
and uses an executable, user-owned runtime tmpfs for s6 launchers through
`T3_RUN_DIR`. Existing image smoke and native-runtime tests remain required.

Native ARM image evidence covers the prepare, restart and offline recreation
phases, including changed PUID/PGID login, identity preservation, and tampered
cache rejection. The complete image matrix remains pending until both
architectures and variants, including the rootless phase, pass.

## Gates still requiring evidence

- External SSH/editor sessions over a real LAN, tailnet and Cloudflare Access
  policy, including ACL denial, account expiry and lost provider responses.
- The complete storage/ENOSPC/interruption and legacy/downgrade matrix from
  `acceptance.csv`, beyond the specific local recovery tests.
- Native host custom palettes, real assistive technology, forced colors,
  virtual keyboards and the full zoom/clipboard matrix. Fixture embedding and
  automated geometry are narrower evidence.
- Broad operation/artifact retention and protected identity export/restore.
  Logs and event reads are bounded; this implementation does not claim an
  automatic policy for pruning all durable history or cached versions.
- Consolidating the existing Setup/router owners into s6, integration of
  optional-service updates into the global Updates page, multiple connector
  instances and kernel Tailscale mode. These are not exposed as working options.

No local test is a reason to merge before these applicable gates are resolved
or the PR's supported release scope is explicitly narrowed and reviewed.
