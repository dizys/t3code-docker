# Browser audit reference

Use this page to find the audit for a changed feature. Start with
[Working on the console](console.md) for development and fixture environments.
Use `NODE_PATH` for an existing Playwright installation and `CHROME_PATH` for
Chromium when they are not discovered automatically.

Commands below use the fixture preview at `http://127.0.0.1:23785/__setup/`
with key `dev`, unless they start their own server or need real T3. Any `URL`
and `KEY` placeholders refer to a disposable development instance. Each
feature audit keeps the writes it describes in disposable or intercepted
fixtures. Do not point write fixtures at an un-intercepted production API.

Use filters for iteration, then run the full relevant audit before a PR.
Keep both themes, phone layouts and embedded frames in final evidence.

## Navigation, appearance and layers

| Command | Checks |
| --- | --- |
| `node scripts/setup-bridge-audit.js` | Real T3 pages through the development router: Settings entry, grouped navigation, native palette links, cleanup and draft preservation on resize |
| `node scripts/setup-tab-audit.js URL` | Fixture tab headers, page menu, footer keyboard links, swipe dismissal and guarded navigation |
| `node scripts/layers-ui-audit.js` | Real opening/closing animations, quick closes, nested dialogs, restored focus and reduced motion on desktop, phone and Settings layouts |
| `node scripts/appearance-ui-audit.js URL KEY` | Standalone role parity with the pinned native reference, offline Inter and forced-color focus on phone, tablet and desktop |
| `node scripts/ui-audit.js http://127.0.0.1:23780/__setup/ dev` | Clipped text, button sizing and glyph alignment |

The bridge audit needs the real development console and its printed ports.
Follow the audit command it prints, set `T3_PAIR_CREDENTIAL` to a pairing
credential from that scratch T3, and pass `--t3 URL` and `--setup URL`. Use
`--bridge docker/t3-client/setup-bridge.js` to test the working bridge.
Its navigation stress case uses 1800ms latency and verifies that page switches
reuse the iframe document. It checks native appearance synchronization,
including custom colors, contrast, fonts, size, legacy fallback and drafts.
It also covers the compact phone Settings rail, native search, the older
sidebar sheet and focus after closing Setup.

Set `T3_BRIDGE_UI_OUTPUT=/tmp/t3-bridge-ui` to save desktop/phone screenshots
in both themes. `T3_BRIDGE_UI_FIXTURES=1` switches only the final screenshot
tour to synthetic data, after real authentication and host checks run.

Set `T3_UI_AUDIT_TAB=1` on the shared layout, Skills, MCP, Files, Storage or
Gateways audit for tab frames at 480, 639, 640, 704 and 1040px. Omitting it
retains standalone and legacy-embed coverage. `T3_UI_AUDIT_STATES=storage`
narrows the shared audit; comma-separated route or overlay names select other
states without changing its default coverage.

Layers uses local styles and Kit without a server or production API. It runs
in browser image smoke. See the [design system](../../docker/setup/design/README.md)
for source mapping and synchronization rules.

## Instructions and Skills

```bash
node scripts/context-ui-audit.js http://127.0.0.1:23785/__setup/ dev
node scripts/skills-ui-audit.js http://127.0.0.1:23785/__setup/ dev
node scripts/skills-update-ui-audit.js http://127.0.0.1:23785/__setup/ dev
node scripts/skills-hooks-ui-audit.js
```

| Audit | Coverage | Screenshot directory |
| --- | --- | --- |
| Instructions | Failed reads, draft preservation and save conflicts | `/tmp/t3-context-ui-audit` |
| Skills library | Desktop, phone, tablet and embedded flows; settings serialization, stale saves/plans, late replies, replacement consent and partial retry | `/tmp/t3-skills-ui-audit` |
| Skills updates | Review queue, supporting-file diffs/folds, replacement consent, pinned phone actions, pending-save guards, conflicts, expiry and lost responses | `/tmp/t3-skills-updates-ui` |
| Skills hooks | Discovery cache, exact-command trust, native revision refresh, disabled/managed hooks, conflicts, long commands and filtered plugins | `/tmp/t3-skills-hooks-ui` |

`T3_SKILLS_UI_UNIFIED_ONLY=1` narrows the library audit to grouped locations,
draft guards, the selected save target, and failed/late location reads. Those
checks also run in the full audit.

Updates and hooks cover light/dark desktop, 1024px, 390px, 360px and embedded
layouts. `T3_SKILL_UPDATE_UI_OUTPUT` and `T3_HOOKS_UI_OUTPUT` override their
output directories. Their corresponding `_THEMES` and `_WIDTHS` variables
narrow an iteration. Instructions output uses `T3_CONTEXT_UI_OUTPUT`.
Skills library output uses `T3_SKILLS_UI_OUTPUT`.
All three Skills audits keep drafts and source text in memory and intercept
writes. Skills update-review remains serial; see [testing](testing.md#browser-checks).

## Files and the shared editor

```bash
node scripts/files-ui-audit.js http://127.0.0.1:23785/__setup/ dev
node scripts/files-space-ui-audit.js http://127.0.0.1:23785/__setup/ dev
node scripts/files-change-ui-audit.js http://127.0.0.1:23785/__setup/ dev
node scripts/console-editor-ui-audit.js http://127.0.0.1:23785/__setup/ dev
```

| Audit | Coverage |
| --- | --- |
| Files | Toolbar grouping, filename space, wrapping badges, deep paths, resize/scroll preservation, selection, polling, late replies, previews, Sizes, managed paths and permission/missing states |
| Files space | Archive options, unsafe entries, extraction conflicts, low-space recovery, opt-in extraction after upload, stale cleanup/delete reviews, repeated submissions and typed-name gates |
| Files changes | Selected Trash actions, readable labels, managed/read-only controls, unlock/relock, blocked shortcuts and Kit menu disabled styles, click guards and focus |
| Shared editor | Highlighted Markdown, native undo, Find/Escape, large Markdown files, bounded viewport DOM, read-only skills and selection/action overlap |

Files covers both themes at desktop, laptop, tablet, phone, narrow-phone and
embedded sizes, including 800px and 1100px frames inside a larger window.
Its output is `/tmp/t3-files-ui-audit`, overridden by `T3_FILES_UI_OUTPUT`.
`T3_FILES_UI_LAYOUT_ONLY=1` focuses on layout, Details, long paths and Sizes.
`T3_FILES_UI_VARIANTS=laptop,embedded-modal,embedded-compact` narrows either
mode. The default retains all interaction checks.

Files space covers all seven Files viewports in both themes. It reads the
console document from the supplied URL and serves a loopback download fixture
to verify ZIP bytes saved by Chromium. Native attachments bypass Playwright
response interception; API writes remain mocked. `--files-overlays` adds the
reviews to `console-screens.js`. All file mutations use synthetic in-memory
paths and cannot change the production filesystem.

The editor audit runs in browser CI. It checks caret hit-testing and multiline
selection alignment while scrolling Files, Instructions and Skills, including
reserved-scrollbar and overlay-size viewports. Native scrollbars stay visible.
Screenshots go to `/tmp/t3-editor-ui-audit` (`T3_EDITOR_UI_OUTPUT` overrides it).
Use `T3_EDITOR_UI_VARIANTS=desktop T3_EDITOR_UI_MOTION=no-preference` for a
focused normal-motion check; the default covers all layouts with reduced motion.

## Storage and Updates

```bash
node scripts/storage-ui-audit.js http://127.0.0.1:23785/__setup/ dev
node scripts/auto-update-ui-audit.js http://127.0.0.1:23785/__setup/ dev
```

Storage checks cleanup and maintenance in 18 light/dark configurations,
including short viewports and real embedded frames. It covers protected
caches, expired/stale reviews, late replies, repeated submissions, progress,
partial retries, unsaved drafts and preference conflicts. Output goes to
`/tmp/t3-storage-ui-audit` (`T3_STORAGE_UI_OUTPUT` overrides it).

`T3_STORAGE_UI_SPACING_ONLY=1` focuses on text alignment, paragraph gaps,
policy states, expanded limits and preference recovery. It stops before
version and cleanup job scenarios. The fixture Storage page is at `#storage`.
The audit can also use the real development console URL; its storage data and
mutations are intercepted, so it cannot clean real caches or preferences.
For native tool checks, see [testing](testing.md#storage-and-toolchains).

Updates covers both themes on phones, desktop and embedded frames. It checks
failed Rust retries, duplicate errors, stale channel metadata, progress during
delays, same-version integration updates, failed submissions and
unchanged-version recovery. Update/preference writes are intercepted.
Output goes to `/tmp/t3-auto-update-ui-audit`, overridden by
`T3_AUTO_UPDATE_UI_OUTPUT`.

## Services and Access

```bash
node scripts/services-ui-audit.mjs
node scripts/access-fixture-audit.mjs
node scripts/access-ui-audit.js http://127.0.0.1:23780/__setup/ dev
```

Services starts a disposable loopback fixture with real controller journals
and inert adapters. It checks SSH installation, package ownership, service
lifecycle, Tailscale sign-in states, routes, lost-response recovery and layout.
It performs no live sign-in. Output defaults to `/tmp/t3-pr119-evidence/ui`
(`T3_SERVICES_UI_OUTPUT` overrides it).

`access-fixture-audit.mjs` owns a disposable preview and runs the Access audit,
then stops the preview. Use it when you do not need a persistent review server.

Access checks device rename/revoke/pairing, delayed and failed responses,
repeated submissions, stale polls and incomplete refreshes. It covers both
themes, phone, tablet, desktop and a real embedded frame. API writes are
intercepted and never reach real devices. Screenshots go to
`/tmp/t3-access-ui-audit` (`T3_ACCESS_UI_OUTPUT` overrides it).

## MCP and Gateways

```bash
node scripts/mcp-ui-audit.js http://127.0.0.1:23785/__setup/ dev
node scripts/gateways-ui-audit.js http://127.0.0.1:23785/__setup/ dev
```

MCP checks the matrix, per-agent Off/On, reachable agent lists at every size,
snippet import, masked values, edit/update, sharing consent, partial removal,
revision conflicts and failed/late reads. It uses response fixtures in both
themes at phone, desktop and embedded sizes. Output is
`/tmp/t3-mcp-ui-audit`; `mcp` is also in the standard screenshot matrix.

Gateways checks the whole page in both themes on phone, desktop, embedded and
optional tab sizes. It fails if layout drifts from MCP. It uses the real
service with stand-ins from `scripts/lib/gateways-fixtures.cjs`, including
failure addresses such as `down.example.test`. Output goes to
`/tmp/t3-gateways-ui-audit`. Also run the relevant
[native checks](testing.md#gateways).

## Agent sign-in

```bash
node scripts/opencode-auth-ui-audit.mjs
node scripts/codex-sign-in-ui-audit.mjs
```

Both start disposable Setup servers and use Playwright/Chromium.

OpenCode checks drafts, slow/failed reads, account removal, focus and late
writes in light/dark, mobile, desktop and embedded-query layouts. It never
reads or changes real OpenCode credentials. Screenshots go to
`/tmp/t3-opencode-auth-ui` (`T3_AUTH_UI_OUTPUT` overrides it).

Codex checks the row while T3 Code uses its own ChatGPT connection:
confirmation, an expired sign-in, switching and focus. It covers both themes
on mobile, desktop and embedded layouts. Screenshots go to
`/tmp/t3-codex-sign-in-ui` (`T3_CODEX_SIGNIN_UI_OUTPUT` overrides it).

## Vault

```bash
node scripts/credentials-ui-audit.mjs
```

This uses real Setup in a disposable home and a loopback API server. It checks
paste detection, drafts, secret replacement, concurrent edits, host-key review,
stale addresses, failed reads, repeated saves, deletion focus, deep links and
long metadata. SSH scans and host trust are intercepted; production credentials
and external services are untouched. New tests must supply a temporary home;
see [Vault testing](testing.md#vault).

Output goes to `/tmp/t3-credentials-ui` (`T3_CREDENTIALS_UI_OUTPUT` overrides
it). Use `T3_CREDENTIALS_UI_WIDTHS=390,640,1280` or
`T3_CREDENTIALS_UI_THEMES=light` to narrow an iteration. CI runs both themes at
those three widths on both browser architectures, including standalone,
legacy-embed and Settings layouts.

For visual handoff, start the fixture preview and run:

```bash
node scripts/credentials-visual-audit.mjs http://127.0.0.1:23785/__setup/
```

It captures the list, empty state, details, add dialog, editor, conflict,
host-key review and deletion, including phone states in both themes. Records
are public synthetic fixtures; newly entered secrets stay masked. Output goes
to `/tmp/t3-credentials-visual` (`T3_CREDENTIALS_VISUAL_OUTPUT` overrides it).
Include the resulting screenshots in the PR.
