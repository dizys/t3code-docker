# Maintaining native T3 patches

Container and Setup behavior is maintained locally in this repository's native
source patch set. The image and its Stable/Nightly updater consume the same
patched distribution.

Register a source patch in `docker/runtime/patches/index.mjs`. Each patch declares
the files it changes and applies bounded, unambiguous source edits. The registry
and patch contents determine the build's SHA-256 revision. Increment the
registry's `BUILD_REVISION` when changing the compiler or packaging contract so
existing immutable artifacts cannot be reused. Upstream source drift fails the
build before a runtime can be published.

The builder checks out the exact upstream release tag and verifies the matching
official CLI archive. It compiles the patched server, keeping that archive's
client, native modules and resource monitor. Its manifest records the patch
revision, upstream source commit and original archive checksum. Compiler
dependencies remain outside the final image.

Linux ARM64 runners use upstream's native `build-exe` command without a
cross-build target, retaining its SEA injection workaround for 16/64 KiB page
kernels. The builder reads that path's `dist-exe/t3` output; explicit targets
use the platform-named output. Keep the build Node version aligned with the
upstream release's declared version for native ARM64 compilation.

Compilation loads the exact tag's checked-in `.env.example`, allowing only the
four public Clerk and relay settings that enable T3 Connect. It excludes local
environment files and operator build overrides. These public defaults require
no private upstream credentials. Native checks exercise `connect status --json`
and compare Connect/relay discovery before and after an integration trial.

CI builds and tests Linux AMD64 and ARM64. The native project smoke starts the
actual binary in a disposable home, reads the same project-root metadata clients
use, creates repositories through the native API, exercises name collisions and
checks that existing projects retain their files and paths. A real same-version
trial checks activation of the patched binary, reconnects the original session,
compares the environment identity, and creates another project in the workspace.
Image jobs reuse the tested runtime artifact. The image update smoke stages the
tested Nightly without selecting or restarting a production runtime.

The **patched T3 runtime** workflow also runs hourly and can be dispatched for an
exact older release when an installation pins that version:

```sh
gh workflow run native-runtime.yml -f version=0.1.2 -f publish=true
```

Publication uses OCI artifacts in the existing public GHCR package. Exact
version tags include the patch revision; channel aliases advance only after
both architectures pass. Runtime artifacts are consumed by Setup. Users keep
pulling the normal `core` and `browser` images. Internal runtime builds do not
add entries to the product's GitHub release history.

Source and test jobs have read-only permissions. A separate publishing job has
package write access and never executes the native binary. Public downloads use
anonymous pull tokens, verify the manifest and archive digest chain, and require
the expected patch revision. User GitHub credentials are unnecessary.

Legacy selected binaries remain usable. A patched build of the same upstream
version installs into a separate cache variant, then follows the normal trial,
device validation, SQLite snapshot and rollback process. Cleanup protects the
active build, its predecessor and each channel's known target.

For a local native build, use Node 26 or newer and Corepack:

```sh
node scripts/build-t3-runtime.mjs 0.1.2 arm64 /tmp/t3-patched-runtime
node scripts/t3-projects-smoke.mjs /tmp/t3-patched-runtime/t3
node scripts/t3-integration-smoke.mjs /tmp/t3-patched-runtime/t3
```

With the existing Playwright installation and `CHROME_PATH`, setting
`T3_PROJECTS_UI_OUTPUT=/tmp/t3-projects-ui` on the project smoke also verifies
the actual client's New project flow on desktop and phone in light and dark.
It captures the destination shown in the command palette and creates projects
through that UI. All sessions, repositories and servers belong to disposable
homes; screenshots contain only synthetic test data.

`node scripts/native-publish-smoke.mjs` checks the real ORAS publication format
against a local OCI layout, including both architectures and channel ordering.
It requires ORAS 1.3.6 and performs no network writes.
