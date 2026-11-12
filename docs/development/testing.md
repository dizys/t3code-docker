# Testing a change

Run source tests during development, the relevant feature checks before a PR,
and the image smoke suite for changes to container behavior. Add a regression
for the behavior you fix.

## Source and image checks

Use Node 24, Git, Bash, `zip` and `unzip` for the source suite. Shell checks
also use ShellCheck. CI's lint job in
[build.yml](../../.github/workflows/build.yml) lists the complete commands.

```bash
node --test tests/*.test.mjs
node scripts/harness-ui-audit.js
scripts/generate-mise-idiomatic.sh --check
docker compose config >/dev/null
docker compose -f compose.yaml -f compose.tailscale.yaml config >/dev/null
```

You can also run the source suite with `bun test tests/*.test.mjs`. Keep Node 24
installed: the SQLite WAL fixtures and browser audit loader use real Node child
processes. CI continues to run the suite with Node.

Build an image and run the user-visible checks:

```bash
docker build --target browser -t t3code:browser .
./scripts/smoke-test.sh t3code:browser
```

**`scripts/smoke-test.sh` defines what must keep working.** It starts the
image and checks what users would notice if it broke. Most checks were added
after a regression. Test the `core` target too when your change affects both.

The archive check stages a real current Nightly in a disposable home. It
verifies its checksum, Setup bridge, launcher protocol and native auth probes,
then deletes it without selecting or starting it. To run it directly:

```bash
node scripts/t3-runtime-smoke.mjs docker/runtime docker/t3-client/setup-bridge.js
```

## What CI runs

| Change or event | Validation |
| --- | --- |
| Image, source, tests or workflow change | Lint, source tests, native runtime builds, core/browser smoke tests on amd64/arm64, agent lifecycle on amd64 |
| Documentation only | Lint, all source tests, Compose validation and the lint job's browser checks; image matrix skipped |
| Tag, scheduled run or manual dispatch | Full matrix regardless of changed paths |

The documentation allowlist in `scripts/lib/ci-scope.mjs` covers root
documentation, `docs/` and the README screenshot generator. Unknown events,
missing history and paths outside the allowlist run the full matrix.
New PR pushes cancel that PR's superseded run without cancelling main or
release runs. Smoke checks print elapsed times.

## Browser checks

Start with the [console guide](console.md), then choose the matching command
from the [browser audit reference](ui-audits.md). Audits use the existing
Playwright installation, optionally supplied through `NODE_PATH`, and Chromium
through `CHROME_PATH`.

For local scenario concurrency, set `T3_UI_AUDIT_WORKERS=2`. CI uses two workers
for Skills library/hooks, Files, the shared editor, Updates, MCP and Gateways.
Each scenario owns its context, fixtures and cleanup; ZIP downloads have a
separate HTTP fixture. Suites run sequentially, keeping total browser
concurrency at two.

The ten Skills update-review scenarios stay serial: their native phone
keyboard-scroll assertion has failed under concurrency on amd64. Vault,
native integration and lifecycle checks also remain serial. All selected
scenarios run even after a failure, with timings and failure screenshots.
Invalid worker counts and empty selections fail.

## Native feature checks

Use exact executable paths. These scripts use disposable homes and local
fixtures, without paid inference. Run the relevant native check when a change
affects how an agent reads configuration, credentials or resources.

### Managed services and Tailscale

```bash
node --test tests/services*.test.mjs tests/tailscale-networking.test.mjs
node scripts/services-ui-audit.mjs
scripts/test-services-e2e.sh t3code:core
scripts/test-services-tailscale-e2e.sh t3code:core
```

The Tailscale acceptance test requires a Linux Docker host with `/dev/net/tun`
and nftables support. It creates two disposable containers, separate persistent
volumes and a private network with a digest-pinned Headscale test controller.
Its generated credentials stay in temporary files and are removed with the
containers. It never uses a production tailnet or user credential.

Real pinned Tailscale daemons exercise IPv4/IPv6 TCP and UDP, HTTP, HTTPS with a
fixture CA, MagicDNS full/short names, Docker/public DNS, explicit TCP Serve
and blocked implicit listeners. It checks daemon failure, container restart
and recreation, retained device identity and service registrations, exact DNS
restoration, other services staying up, and disabled startup. CI runs it on
native amd64 and arm64 `core` images; the shared Services/browser suites also
run on both image variants.

### MCP and agent resources

```bash
node scripts/mcp-native-smoke.mjs PROVIDER /absolute/path/to/executable
node scripts/agent-resources-native-smoke.mjs PROVIDER /absolute/path/to/executable
```

Run MCP checks for Claude, Codex, OpenCode V1 and V2, Cursor, Grok, Muse and Pi.
Muse uses its local echo provider. Run resource checks for Grok, Muse and Pi
to verify instruction/skill loading and native skill settings.

Antigravity private-profile normalization and Cursor's instruction workspace
are covered by `tests/agent-resources-patch.test.mjs`. Changes must also build
against the current Stable and Nightly source anchors.

### Gateways

```bash
node scripts/gateways-native-smoke.mjs PROVIDER /absolute/path/to/executable
```

Run against Claude, Codex, OpenCode, Pi and Grok Build. These checks pass real
adapter output to real agents against a fixture gateway, in disposable homes
without sign-in. They verify configuration precedence, including Codex `-c`
over `config.toml` and Claude `settings.json` over environment variables.

Pi checks extension registration and effort forwarding. Grok checks its private
catalogue, exact effort menus, absence of controls for unknown models, and
Responses routing for turns and auxiliary requests. `scripts/t3-integration-smoke.mjs`
checks their T3 API contract, including redaction and usage hubs. Changes to
instance or process behavior also require real T3 turns in the development
console with a fixture gateway.

### Authentication

| Feature | Command | Required versions and behavior |
| --- | --- | --- |
| OpenCode | `node scripts/opencode-auth-smoke.mjs /absolute/path/to/opencode` | V1 and V2, including supported V2 floor 2.0.18; save, account selection, provider isolation and removal |
| Pi | `node scripts/pi-auth-smoke.mjs /absolute/path/to/pi` | Supported floor 0.80.5 and current release; keys coexist with a `/login` subscription, provider models appear, and removal works |

These use isolated homes and disposable keys without login or model requests.
The image suite tests the installed release; it also signs Pi in and out
through Setup. See the browser reference for OpenCode and Codex sign-in UI
checks.

### Storage and toolchains

```bash
node scripts/storage-native-smoke.mjs
```

This checks actual Go, Bun, Deno, uv and Mise commands in disposable homes,
using local packages without network access. Install/select those tools first,
or set `T3_STORAGE_<TOOL>_BIN` to concrete executables. Image smoke runs it after
first-start installation on both image variants and architectures.

For Node runtime resolution, run `node scripts/node-runtime-smoke.mjs` as the
unprivileged container user. It reproduces installed but unselected Node
shims and verifies image Node/npm/npx, Pi probes and launchers, selected global
and project versions, explicit `system`, and missing-version errors without
downloads or changes to the real home. Image smoke runs it on both variants
and architectures.

### Vault

```bash
node --test tests/credential*.test.mjs
node scripts/credentials-ui-audit.mjs
```

The tests use real `ssh`, `ssh-keygen` and `git` with throwaway keys and
folders. **Always pass a temporary `home` to new Vault tests and scripts.**
The store adds an `Include` line to `.ssh/config` under that home.

The browser audit starts real Setup and a loopback API server in a disposable
home. SSH scans and host trust are intercepted. It never contacts an external
service or changes a production credential. The image suite also checks the
installed `t3-vault` and loopback API on each variant.

To add a credential type, update `docker/setup/credentials/types.mjs` and its
copy in `scripts/fixtures/console/credentials.json`; a test compares them.
The store, CLI and form come from that table. Add code in `deliver.mjs` only
when a type needs more than environment variables and files.

## Native T3 patches

Container-specific T3 and Setup functionality belongs in
`docker/runtime/patches`, including Stable/Nightly update support. Follow
[Maintaining native T3 patches](../native-runtime-patches.md) for source
anchors, builds and verification.
