# Contributing

Issues and pull requests are welcome. For a bug report, include the image tag,
architecture, what you expected, what happened, and a way to reproduce it.
Remove credentials from logs and screenshots.

## Get started

Use a checkout with Node 24 for source tests and Docker for image tests:

```bash
git clone https://github.com/dizys/t3code-docker
cd t3code-docker
node --test tests/*.test.mjs
```

See [Testing a change](docs/development/testing.md) for prerequisites and the
complete checks. To build and test the browser image:

```bash
docker build --target browser -t t3code:browser .
./scripts/smoke-test.sh t3code:browser
```

**The smoke suite defines what must keep working.** It checks the running
container from a user's perspective. Add a regression for the behavior you fix.
CI tests both `core` and `browser` on amd64 and arm64, plus the agent lifecycle
on amd64.

## Find the right workflow

| Working on | Start here |
| --- | --- |
| Setup layout or interactions | [Console development](docs/development/console.md) and [browser audits](docs/development/ui-audits.md) |
| Agents, toolchains, auth, MCP, gateways or Vault | [Feature and native checks](docs/development/testing.md#native-feature-checks) |
| Services, networking or Tailscale | [Managed service checks](docs/development/testing.md#managed-services-and-tailscale) |
| Container-specific native T3 behavior | [Maintaining native T3 patches](docs/native-runtime-patches.md) |
| Tags, release evidence and registry delivery | [Making a release](docs/development/releases.md) |

For UI work, choose one of these from your checkout:

```bash
node scripts/console-preview.mjs  # fixture API, for layouts and interactions
node scripts/dev-console.mjs      # real T3 and Setup, for native integration
```

The preview is at `http://127.0.0.1:23785/__setup/`; the development console
uses port `23780`. Both use the development key `dev`. The development console
needs the image's native T3 executable. Their state is disposable; read the
[console guide](docs/development/console.md) before running audits.

## Before opening a PR

- Explain the concrete problem and resulting behavior. Keep the diff focused.
- Run source tests and the feature checks relevant to the change. Report what
  passed and any checks you could not run.
- For UI changes, check both themes, phone and embedded layouts, plus loading,
  empty and failure states. Attach screenshots and add a browser regression.
- Update the user guide when behavior or configuration changes. Rebuild README
  images when Overview, Agents or Ports visibly changes.
- Use plain language. Avoid em dashes in prose, commits, PRs and release notes.

Documentation-only PRs keep lint, source tests and Compose validation, while
skipping the image matrix. Source, image, test or workflow changes run the full
matrix. A new push replaces that PR's earlier CI run. Details and local
concurrency controls are in the [testing guide](docs/development/testing.md#what-ci-runs).

## Releases

Merge reviewed changes, tag the intended commit, and create a draft release.
Publish only after CI has tested the exact images and attached evidence.
Publication triggers Docker Hub delivery. Follow the
[release guide](docs/development/releases.md) for the commands and verification.
Every stable release explicitly thanks its contributors. The pipeline preserves
original PR author credit when maintainers revise or merge their work.
