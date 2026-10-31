# Setup design system

Setup uses the existing vanilla JavaScript Kit and `tc-` components. Its shared
appearance follows native T3 Code Settings. The measured reference is **T3 0.1.4**,
[commit 783581d](https://github.com/pingdotgg/t3code/tree/783581d461dc72cdd8f78fc8abb4ad536dfc4547/apps/web/src).
Stable **0.1.5**, [commit 6d450a4](https://github.com/pingdotgg/t3code/tree/6d450a4284852af137b2f3407fddd89eb76e7644/apps/web/src),
and the checked `0.1.5-nightly.20261029.3867` use the same shared recipes.

| File | Responsibility |
| --- | --- |
| `tokens.css` | Standalone native light/dark defaults, semantic roles, rem geometry and density. |
| `components.css` | Shared controls, rows, groups, typography, navigation and feedback. |
| `ui.js` | Existing `window.T3C` icons, provider marks and shared behavior. |
| `../console.css` | Console composition, page layouts, overlays and responsive navigation. |
| `../client/appearance.js` | Validated native appearance messages mapped to Kit tokens. |

These files started with `t3code-console-handoff/design-system/`. They are now
maintained here, rather than replaced by an unreviewed handoff bundle. Preserve
the fixes and additions below when updating recipes.

## Following native T3

Compare `apps/web/src/index.css`, `themePalette.ts`, `appearanceFonts.ts`,
`components/ui`, `components/AppRouteModal.tsx` and `components/settings` in the
pinned native source. The console uses its neutral canvas, foreground/muted text,
40% card fills, 60% card borders, control radius, switches and inset focus rings.
The sidebar is 15rem and the breadcrumb header is 3rem. Embedded modal bounds
match native Settings: 80rem by 60rem, 1.5rem gutters, 2.5rem on large screens,
and full screen below 640px.

Native `primary` maps to Setup `--accent`, the action color. Native `accent`
is a neutral interactive surface and maps to `--hover`/`--pressed`. Warning,
error, success and information keep separate semantic colors. Do not use the
primary color for all status indicators or hardcode blue in action recipes.

`setup-bridge.js` sends a versioned appearance snapshot on the existing trusted
ready/theme exchange. It reads resolved semantic values, including native
contrast adjustments, font families, smoothing, interface size and control
radius. Root class/style/theme mutations are coalesced per animation frame;
identical snapshots are skipped. The receiver accepts only allowlisted,
browser-supported literal values from its same-origin parent. There are no
arbitrary CSS selectors, URLs, font downloads or configuration writes.

Palette-only changes update CSS without rendering the application, preserving
drafts, menus, selection and focus. Missing roles fall back to native standalone
defaults; theme-only legacy messages clear previous overrides. The unlock page
uses the same receiver. Standalone Setup retains its own Light/Dark/System
selector. Native interface size is bounded to its supported 12px to 20px range;
rem geometry follows it while hairlines, switch end insets and minimum 44px
touch targets retain their physical size.

Standalone Setup keeps its primary phone tabs, More, and focused
Files/Skills/MCP screens. Its sidebar switches at 1024px. Inside native
Settings, Setup is a tab of that surface: a pinned entry, grouped navigation
on wide windows, and a page switcher on compact windows.

### Settings host and navigation

`client/routes.js` owns page names, icons, groups, shortcuts, aliases and
native-palette metadata. `T3Model.navModel` projects only the information a
host needs. Signed-in `/hello` responses include that model, allowlisted SVG
geometry and palette entries. Anonymous `/hello` still returns only the
service name and `signedIn: false`. Status details and credentials never
cross this boundary.

The native bridge copies attributes from a native Settings page row, never
its React tree. It pins Setup outside the scrolling list and mounts one
iframe in the Settings body. It updates keyed navigation rows in place. The
child decides the current page, including after a cancelled discard prompt;
the parent only requests navigation. Back, native-settings links and Close
have distinct behavior. Leaving restores the exact original inert and ARIA
attributes and disconnects per-open observers and listeners.

Three independent dimensions matter:

- The parent window uses native `md` (768px) to choose wide or compact hosting.
- The console frame uses 640px for tab density, and 1024px standalone.
  `Kit.COMPACT` and root `data-compact` keep scripts and CSS in sync before
  first paint. Zero-specificity `:where` gates preserve the standalone cascade.
- Components can still adapt to their available lane. The import planner
  stacks below 800px, and Files protects name space beside Details.

The compact page menu extends `Kit.menu` with groups, item icons, a trailing
check and footer links. Popovers remain nonmodal. Modal child layers tell the
bridge to dim and inert its wide navigation; the frame owns its own backdrop.
No second modal or duplicate scrim is introduced.

The bridge uses source-window and origin checks for messages, bounded
navigation/palette fields, allowlisted icon elements and attributes, and
`^/settings/[a-z0-9-]+$` for native-settings links. Host layout enums survive
unlock redirects, including a plain form POST without JavaScript. No CSP or
runtime-dependency expansion is needed.

On pinned T3 v0.1.5, `history.pushState` plus `popstate` opens native Settings
without a reload. A bounded fallback navigates normally if the native router
does not respond. Unrecognized Settings hooks or legacy metadata use the
standalone console rather than drawing an incomplete tab. Optional
session-storage failure does not prevent opening or leaving Setup.

### Font asset

`fonts/inter-latin-variable.woff2` is the unmodified 48,256-byte Latin variable
Inter asset from the official T3 0.1.4 ARM64 client archive
(`client/assets/inter-latin-wght-normal-Dx4kXJAl.woff2`). `fonts/OFL.txt` contains
the [Inter SIL Open Font License](https://github.com/rsms/inter/blob/v4.1/LICENSE.txt).
`page.mjs` inlines the font once with the styles, preserving the console's single
HTML response and offline operation. CSP permits `font-src data:` only. System
and non-Latin fallback stacks match native T3. No runtime font dependency or
external font service is needed.

### Verification when syncing

`tests/fixtures/native-appearance.json` records the measured reference version,
commit and light/dark roles. `tests/appearance.test.mjs` covers the transport,
validation, legacy fallback and self-contained font delivery.

`node scripts/appearance-ui-audit.js URL KEY` compares the real standalone
console with those roles in light/dark at 360px, 820px and 1440px. It checks
loaded fonts, focus, forced colors, header navigation and page containment.
`scripts/setup-bridge-audit.js` additionally checks live native role parity,
custom palette/contrast/font changes, draft and focus preservation, coalescing,
legacy fallback and message source guards through a real native T3 frame.
Run the existing shared geometry, row and feature audits from CONTRIBUTING as
well. Capture source and implementation at the same viewport, then inspect
combined comparisons. Include representative light, dark, phone and embedded
screenshots in the PR, with its scoped visual QA findings.

## Local fixes

Each of these is a bug in the handoff, not a restyle. Keep them when syncing.

1. **`--sidebar` meant two things.** The handoff's `tokens.css` declares
   `--sidebar` as the sidebar's colour in each theme block and again as the
   sidebar layout width in `:root`. With `data-theme` on `<html>` both selectors
   match the same element with equal specificity, so the width won and the
   sidebar lost its background in both themes. The width is now `--sidebar-w`, in
   `tokens.css` and in `.tc-app`'s grid in `components.css`. (The handoff's
   mockups set `data-theme` on an inner element, which hid the collision.)
2. **Copy did nothing over plain HTTP.** `navigator.clipboard` only exists in a
   secure context, and the console is usually opened at `http://host:3774`, so
   every Copy narrated "Press ⌘C". `ui.js` now falls back to a selected textarea
   and `execCommand('copy')` before narrating, and exposes the result as
   `T3C.copyText(text) -> Promise<boolean>`.
3. **"Press ⌘C" everywhere.** The narration names the keys of the platform it
   runs on (`⌘C` on Apple devices, `Ctrl C` elsewhere), as the Kbd guideline
   asks; `T3C.copyKeys` carries it.
4. **The empty state's back cards painted over its icon.** The handoff drew the
   two fanned cards as `.tc-empty-icon`'s own `::before`/`::after` at
   `z-index: -1` inside an `isolation: isolate` box, which paints them above
   that box's background, so their outlines crossed the icon's card. T3's
   EmptyMedia uses sibling elements. Here the cards belong to a wrapper,
   `<span class="tc-empty-media"><span class="tc-empty-icon">…</span></span>`,
   and the icon's card sits above them. They use T3's geometry: 2px out, not 6px. In
   the same component, `.tc-empty--compact` with an icon squeezed its title
   into a one-word column on a phone; it now stacks the title over its line
   beside the icon.
5. **Native select menus did not follow the page theme.** Controls declare
   their colour scheme and options use opaque theme surfaces and text colours.
   The dark input rule sets `background-color` so it preserves `.tc-select`'s
   chevron. In forced colours, selects use their native indicator and a system
   focus outline, since that mode removes gradients and shadows.
6. **The enabled switch thumb touched its track's right edge.** Its travel
   omitted the 2px end inset. Translating by `--_t - 4px` keeps the same 2px
   clearance above, below, and at the resting end in both states and sizes.
   `scripts/row-ui-audit.js` measures the rendered thumb in each variant.

## Local additions

Not in the handoff. Keep them when syncing.

- **Agent marks.** `T3C.agentMark(id)` draws an agent's own mark (Claude Code,
  Codex, OpenCode, Grok, Cursor, Muse Code, Antigravity) as T3 Code's provider settings
  draw it, from `AGENT_MARKS` in `ui.js`, and `.tc-tile--mark` sets it on a
  neutral tile in place of a monogram. One-colour marks fill with
  `currentColor` so they follow the theme; Claude keeps its orange, OpenCode's
  two tones are `--agentmark-ink` and `--agentmark-hole` in `tokens.css`, and
  Muse Code uses the Meta blue gradient SVG from T3 Code's Muse provider
  definition, with gradient IDs scoped per instance. Antigravity's gradient
  mark is a 64px image. The class is `tc-agentmark`
  rather than `tc-brand`, which is the sidebar's brand block.
- **Provider marks.** The same function draws the source control providers'
  marks (GitHub, GitLab, Forgejo, Azure DevOps) from `PROVIDER_MARKS`, as T3
  Code's Source Control settings draw them. T3 has none for Gitea, which it
  files under Forgejo; Gitea's is its repository's `assets/logo.svg`. A mark's
  gradient ids start `ID-`, which `agentMark` makes unique per drawing.
- **Toolchain marks.** And the toolchains' (Go, Rust, Bun, Deno, uv) from
  `TOOLCHAIN_MARKS`, each from its own project, since T3 Code draws none: Go's
  wordmark, Rust's logo from rust-artwork, Bun's and Deno's from their sites,
  uv's letter mark from its docs. Rust follows the theme in `currentColor`, and
  Deno's black and white are `--agentmark-ink` and `--agentmark-hole`, as
  OpenCode's are. Added tools keep their monogram.
- **Icons beyond the handoff's set.** Lucide's `pencil`, `book-open`,
  `hard-drive`, `folder`, `clock`, `sparkles` and `file-text`, added in `ui.js`
  beside the handoff's icons for pages it did not draw: editing, instructions,
  storage, volumes, schedules and skills. The skill-update handoff adds Lucide
  `arrow-up`, `git-branch`, `file-diff`, `file-plus`, `file-minus`,
  `sliders-horizontal`, `shield-alert`, `puzzle`, `wifi-off` and `hourglass`
  from its supplied SVG assets.
