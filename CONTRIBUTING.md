# Contributing

Issues and pull requests are welcome. Before opening one:

- **`scripts/smoke-test.sh` defines what must keep working.** It starts the
  image and checks, against the running container, the things a user would
  notice if they broke. Run it against your build
  (`./scripts/smoke-test.sh t3code:browser`) and add a check for whatever you
  fixed. Most of its checks were added after something broke.
  The T3 Code archive check stages a real current nightly in a disposable home,
  verifies its checksum, Setup bridge, launcher protocol and native auth probes,
  then deletes it without selecting or starting it. It can also run locally:
  `node scripts/t3-runtime-smoke.mjs docker/runtime docker/t3-client/setup-bridge.js`.
- **CI builds and tests both images on both architectures** before anything is
  published, so a change that only works on amd64 is caught. The slower agent
  lifecycle test runs on amd64 for every build.
- **To work on the setup page or what it adds to T3 Code's pages**, run
  `node scripts/dev-console.mjs` inside a container from this image. It starts
  a scratch T3 Code and the setup page from your working tree behind the
  image's one-port router, as `T3_SINGLE_PORT` would. It restarts the setup
  page as you edit, serves T3 Code's pages with your copy of
  `docker/t3-client/setup-bridge.js`, and prints a pairing link.
  `scripts/setup-bridge-audit.js` checks those pages in a browser, through the
  same router. It covers the pinned Settings entry, grouped navigation,
  native palette links for every page and registered subpage, exact cleanup and
  draft preservation across resize. Its navigation stress case simulates 1800ms
  network latency and asserts that page switches reuse the iframe document.
  `node scripts/setup-tab-audit.js URL` checks the tab headers, page menu,
  keyboard footer links, swipe dismissal and guarded navigation against the
  fixture console. Set `T3_UI_AUDIT_TAB=1` on `ui-audit.js`,
  `skills-ui-audit.js`, `mcp-ui-audit.js`, `files-ui-audit.js` and
  `storage-ui-audit.js` to exercise 480, 639, 640, 704 and 1040px tab frames.
  Omit it to retain their standalone and legacy-embed runs. For native visual
  evidence, `T3_BRIDGE_UI_FIXTURES=1` switches only the final screenshot tour
  to synthetic data after the real authentication and host checks have run.
  It also checks full native appearance synchronization, including custom colors,
  contrast, fonts, size, legacy fallback and unsaved-draft preservation.
  `node scripts/appearance-ui-audit.js URL KEY` checks standalone role parity
  against the pinned native reference, offline Inter delivery and forced-color
  focus at phone, tablet and desktop widths. See the
  [design system](docker/setup/design/README.md) for source mapping and sync rules.
  It covers grouped Settings navigation, its compact phone rail, native search,
  the older sidebar sheet, and opening/closing Setup with focus restored.
  Set `T3_BRIDGE_UI_OUTPUT=/tmp/t3-bridge-ui` to save desktop and phone
  screenshots in both themes.
  `node scripts/console-screens.js` photographs every setup page in light and
  dark, on a phone, a tablet, a desktop and inside T3 Code, in three states:
  set up, first start, and everything needing attention at once. Its data
  comes from `scripts/fixtures/console`, so the pictures do not depend on the
  machine, and nothing it presses reaches the server. Screenshots go to
  `/tmp/t3-console-screens`; `--routes`, `--sizes`, `--themes` and
  `--scenarios` narrow a run. Attach the pages you changed to the pull request.
  For Skills review without installed agents, `node scripts/console-preview.mjs`
  serves the real console at `http://127.0.0.1:23785/__setup/` with an in-memory
  API. It never connects to production or executes source files. Reload reads the
  current console assets; restart resets fixture mutations. This is a review
  server, not a deployment mode. `--scenarios skills --skill-overlays` adds the
  seven-provider library, policy menu, inspector and all three import steps to
  `console-screens.js`. Fixtures use synthetic instruction text and paths.
  `node scripts/skills-ui-audit.js http://127.0.0.1:23785/__setup/ dev` exercises
  desktop, phone, tablet and embedded flows in both themes, including settings
  serialization, stale saves/plans, late replies, replacement consent and partial
  retry. Like the other audits it uses the existing Playwright installation
  (`NODE_PATH` if needed) and `CHROME_PATH` for Chromium.
  Review console changes beyond the populated mockup: empty, loading, unavailable,
  expanded, hover and keyboard-focus states, long paths, and both scroll edges.
  Compare the changed states at the same viewport in light and dark, including a
  narrow phone and the embedded console. Use the shared Kit controls throughout;
  check touch targets and keep recovery actions readable. Add a regression to the
  relevant browser audit for the defect. `node scripts/context-ui-audit.js
  http://127.0.0.1:23785/__setup/ dev` covers Instructions, including failed reads,
  draft preservation and save conflicts; its screenshots go to
  `/tmp/t3-context-ui-audit` (`T3_CONTEXT_UI_OUTPUT` overrides it).
  `node scripts/readme-media.js` rebuilds the README's picture
  (`docs/media/setup-{light,dark}.png`) and the Ports guide's
  (`docs/media/ports-panel.png`) from the same data; run it when a change
  shows on Overview, Agents or Ports.
  `node scripts/ui-audit.js http://127.0.0.1:23780/__setup/ dev` measures the
  same pages for clipped text, uneven buttons and misaligned glyphs.
  `T3_UI_AUDIT_STATES=storage` narrows that shared audit to Storage; comma-separated
  route or overlay names select other states without weakening the default run.
  `node scripts/storage-ui-audit.js http://127.0.0.1:23780/__setup/ dev`
  checks the complete cleanup and maintenance journeys in 18 light/dark
  configurations, including short viewports and real embedded frames. It covers
  protected caches, expired/stale reviews, late replies, repeated submissions,
  background progress, partial retries, unsaved drafts and preference conflicts.
  Its storage data and mutations are intercepted, so it cannot clean a real
  cache or change preferences. Screenshots go to `/tmp/t3-storage-ui-audit`;
  set `T3_STORAGE_UI_OUTPUT` to change that location. The development console
  isolates its home, mise state, and caches under `/tmp/t3-dev/home`.
  `node scripts/files-space-ui-audit.js http://127.0.0.1:23785/__setup/ dev`
  exercises archive options, unsafe-entry disclosure, extraction conflicts and
  low-space recovery, opt-in extraction after upload, stale cleanup/delete
  reviews, repeated submissions and the typed-name gate in both themes and all
  seven Files viewports. `--files-overlays` adds these reviews to
  `console-screens.js`. All mutations stay in the in-memory fixture.
  For a focused visual pass, `T3_STORAGE_UI_SPACING_ONLY=1` checks text alignment,
  paragraph gaps, policy states, expanded limits and preference recovery across
  the same viewports. It stops before the version and cleanup job scenarios.
  The fixture console also supports Storage: run `node scripts/console-preview.mjs`
  and open `http://127.0.0.1:23785/__setup/#storage`. Its writes stay in memory;
  the same browser audit can use this URL. `node scripts/storage-native-smoke.mjs`
  additionally checks the actual Go, Bun, Deno, uv and mise commands in disposable
  homes, using local packages with no network. Install/select those tools first;
  `T3_STORAGE_<TOOL>_BIN` can supply concrete binaries. The image smoke suite runs
  these native checks after its normal first-start installation on both variants
  and architectures.
  `node scripts/access-ui-audit.js http://127.0.0.1:23780/__setup/ dev`
  checks device renaming, revocation and pairing with delayed/failed fixture
  responses, repeated submissions, stale polls and incomplete list refreshes.
  It covers light/dark, phone, tablet, desktop and an actual embedded frame;
  screenshots go to `/tmp/t3-access-ui-audit` (`T3_ACCESS_UI_OUTPUT` overrides
  it). All Access API writes are intercepted and never reach real devices.
  `node scripts/auto-update-ui-audit.js http://127.0.0.1:23785/__setup/ dev`
  checks Updates in both themes on phones, desktop and an embedded frame. It
  includes failed Rust retries, duplicate-error prevention, stale channel
  metadata, progress during delayed requests, same-version container integration
  updates, failed submission recovery and unchanged-version recovery.
  Update and preference writes are intercepted; it can use the fixture console.
  Screenshots go to `/tmp/t3-auto-update-ui-audit` (`T3_AUTO_UPDATE_UI_OUTPUT`
  overrides it).

For shared MCP changes, run `node scripts/mcp-native-smoke.mjs PROVIDER
/absolute/path/to/executable` for Claude, Codex, OpenCode (both V1 and V2) and
Cursor. It uses disposable homes and fixture servers without model requests.
`node scripts/mcp-ui-audit.js` checks the MCP page’s matrix, per-agent Off/On,
snippet import, masked values, edit/update, sharing consent, partial removal,
revision conflicts and failed/late reads in both themes at phone, desktop
and embedded sizes. It uses response fixtures, with screenshots under
`/tmp/t3-mcp-ui-audit`. The standard screenshot matrix includes `mcp`.

For repository skill updates, `node scripts/skills-update-ui-audit.js
http://127.0.0.1:23785/__setup/ dev` covers the Updates view, review queue, supporting-file diffs and folds,
replacement consent, pinned phone actions, pending-save guards, conflicts, expiry
and lost-response recovery. `node scripts/skills-hooks-ui-audit.js` checks the
shared discovery cache, exact-command trust, native revision refresh, disabled
and managed hooks, conflicts, long commands, and filtered plugin views. Both run
light/dark desktop, 1024px, 390px, 360px and embedded layouts. All writes are intercepted. Screenshots go to
`/tmp/t3-skills-updates-ui` and `/tmp/t3-skills-hooks-ui`
(`T3_SKILL_UPDATE_UI_OUTPUT` and `T3_HOOKS_UI_OUTPUT` override them).
The corresponding `_THEMES` and `_WIDTHS` variables narrow an iteration. All
three Skills audits keep drafts and source text in memory; never point their
write fixtures at an un-intercepted production API.

For OpenCode credential changes, run
`node scripts/opencode-auth-smoke.mjs /absolute/path/to/opencode` against both
1.x and 2.x (including 2.0.18, the supported V2 floor). It uses an isolated
home and disposable keys, and checks save, account selection, provider
isolation and removal without a model request. The image smoke suite runs it
against the installed release. `node scripts/opencode-auth-ui-audit.mjs`
starts its own disposable setup server and credential CLI, then checks drafts,
slow and failed reads, account removal, keyboard focus and late writes in
light/dark, mobile, desktop and embedded-query layouts. It requires Playwright
and Chromium; set `CHROME_PATH` if needed. Screenshots go to
`/tmp/t3-opencode-auth-ui` (`T3_AUTH_UI_OUTPUT` overrides it). These audits
never read or change your real OpenCode credentials.

For Pi credential changes, run `node scripts/pi-auth-smoke.mjs /absolute/path/to/pi`
against both 0.80.5 (the supported floor) and the current release. It uses an
isolated home and fake keys, and checks that saved keys sit beside a `/login`
subscription, that Pi lists their providers' models, and removal, without a
login or model request. The image smoke suite runs it against the installed
release, then signs Pi in and out through the Setup API.

For Credentials changes, run `node --test tests/credential*.test.mjs`
and `node scripts/credentials-ui-audit.mjs`. The browser audit starts a real
Setup API in a disposable home and a loopback API server. It tests drafts,
secret replacement, concurrent edits, host-key review, stale addresses, failed
reads, repeated saves, deletion focus, deep links and long metadata in both
themes, standalone, legacy embed and Settings widths. SSH scans and host trust
are intercepted; it never contacts an external service or changes a production
credential. Screenshots go to `/tmp/t3-credentials-ui`
(`T3_CREDENTIALS_UI_OUTPUT` overrides it). `T3_CREDENTIALS_UI_WIDTHS=390,640,1280`
narrows the matrix; `T3_CREDENTIALS_UI_THEMES=light` narrows the themes. The image
smoke suite runs both themes at those three widths on both browser architectures,
plus installed-helper and loopback API checks on each image variant.

For handoff comparisons, start `console-preview.mjs`, then run
`node scripts/credentials-visual-audit.mjs http://127.0.0.1:23785/__setup/`.
It captures the list, empty state, SSH/API details, editor, conflict, host-key
review and deletion, including phone states in both themes. It uses public
synthetic fixture records and keeps newly entered secrets masked. Outputs go to
`/tmp/t3-credentials-visual` (`T3_CREDENTIALS_VISUAL_OUTPUT` overrides it). Compare
these at the supplied handoff’s viewport; include real screenshots in the PR.

T3 functionality specific to this container and Setup belongs in the local
source patch set under `docker/runtime/patches`. Maintain the patched distribution
here, including Stable/Nightly update support. See [Maintaining native T3
patches](docs/native-runtime-patches.md) for the build and verification workflow.

Use plain language in project writing. Do not use em dashes in responses,
commit messages, pull requests, release titles or release notes.

Releases are made from tags. Pushing `vX.Y.Z` builds each image for each
architecture, tests each one against the exact digest that was pushed, runs the
agent lifecycle test and measures the image size on amd64, and then combines
the tested digests into one manifest without rebuilding. `latest` points at
`browser`. Published releases are then mirrored to Docker Hub; see
[Docker Hub publishing](docs/dockerhub-publishing.md).

`node scripts/files-ui-audit.js http://127.0.0.1:23785/__setup/ dev` checks Files
against synthetic in-memory paths. It covers desktop, laptop, tablet, phone,
narrow phone and embedded layouts in both themes, including 800px and 1100px
frames inside a larger window. It checks toolbar grouping, filename space,
wrapping badges, deep paths, resize and scroll preservation, selection, polling,
late replies, previews, Sizes, managed paths and permission/missing states.
Screenshots go to
`/tmp/t3-files-ui-audit` (`T3_FILES_UI_OUTPUT` overrides it). Use the existing
Playwright installation through `NODE_PATH` and `CHROME_PATH`, as above. It cannot
read or change the production filesystem.

`T3_FILES_UI_LAYOUT_ONLY=1` runs the focused Files layout cases, including
Details open/closed, long labels and paths, and Sizes. The default run retains
the full interaction checks. `T3_FILES_UI_VARIANTS=laptop,embedded-modal,embedded-compact`
narrows either run while iterating on a constrained console.

`node scripts/files-space-ui-audit.js URL KEY` checks archive and cleanup flows.
It reads the console document from that URL and serves its download fixture over
loopback HTTP, verifying the ZIP bytes saved by Chromium. API writes stay mocked;
native attachments bypass Playwright response interception.

`node scripts/files-change-ui-audit.js URL KEY` also covers selected Trash
actions and readable labels, managed/read-only controls, unlock/relock, blocked
keyboard shortcuts, and the shared Kit menu’s disabled styles, click guards and
keyboard focus. Its file changes stay in synthetic in-memory fixtures.

`node scripts/console-editor-ui-audit.js URL KEY` checks the shared source
editor and Files selection bar at desktop, laptop, tablet, phone and embedded
frame widths in both themes. It checks highlighted Markdown, native undo, Find
and Escape, loading a large Markdown file, bounded viewport DOM, read-only
skills and selection/action overlap. Evidence is written to `/tmp/t3-editor-ui-audit`
(`T3_EDITOR_UI_OUTPUT` overrides it). This fixture audit runs in browser CI.

Source syntax and viewport limits live in `docker/setup/client/code-text.js`.
`code-editor.js` owns source rendering and the native input surface; each caller
owns its save, revision, conflict and dirty-close logic. Use Kit’s `onRender`
hook to sync an editor after a layer patch, and destroy it on close to release
resize observers and queued animation frames.
