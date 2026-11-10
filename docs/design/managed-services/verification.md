# Design verification

This document records the design-stage prototype evidence. Current backend,
integrated-console evidence and remaining gates are tracked in
[implementation.md](implementation.md).

Design-stage result: the proposed design and its interactive reference include custom user-account services and are complete for review. Backend implementation had not begun at that stage. [implementation.md](implementation.md) tracks the subsequent implementation and evidence against the 122 gates in [acceptance.csv](acceptance.csv).

## Artifact and source

- Source console: `844d8504021f7c534851d78e3eabadf7cae5dd26`.
- Design branch: `design/managed-services`, in its isolated worktree.
- Prototype: [prototype.html](prototype.html), self-contained CSS, Inter font, actual console icons, JavaScript and mock data. It performs no network requests or backend writes. Copy actions copy only the displayed example text.
- Rebuild: `node docs/design/managed-services/build-prototype.mjs` from the design worktree.
- Prepare QA inputs: `node docs/design/managed-services/prepare-verification.mjs`. These are self-contained temporary HTML inputs for T3 `html_preview`, not a browser automation dependency or a running server.

## Interaction evidence

The latest T3 HTML preview run executed **63 assertions, all passed**, at 360px width, dark appearance and 20px interface size. This includes the earlier SSH flows and the added custom-service flows. Aggregate/layout output and new visual captures are saved in [custom-preview-results.json](evidence/custom-preview-results.json). The earlier SSH-only run's 41-assertion evidence remains in [preview-results.json](evidence/preview-results.json). The harness source contains the assertion names and exact interactions.

[Final interaction evidence](evidence/custom-final-interactions.json) ties the repeated 63/63 result and containment measurements to the final generated prototype hash after the narrow-review refinement.

Covered: Access tab keyboard behavior and focus, client instruction variants, local-versus-client evidence, named setup dialog, invalid/absent/private/duplicate public keys, draft preservation across wizard Back, review, installation simulation, operation ID on background/reopen, key label preservation, literal HTML-like user labels, shared dependency blocking, update rollback, sign-in repair, useful port-conflict recovery, deployment gate and return, hostname error focus, Cloudflare's separate route-configuration step and client helper, stale status, service search/focus/no results, Services tab keyboard behavior, eight scenario layouts, unique IDs, visible control names, and presence of reduced-motion/forced-color CSS recipes.

Added custom checks cover catalogue/custom entry points; inline validation; draft retention on close; pinned version/account/Vault-reference review; literal argument previews; duplicate UI submission; name-only edits without a new run; escaped inspector headings; temporary stop versus disable; start/restart; log filtering/pause; registration removal with retained tools/data; disabled shell-mode creation; and missing-tool attention/remedies. Nine scenarios are checked for page containment.

These assertions exercise the simulated model and DOM. They do not establish actual durable storage, OpenSSH parsing, mise resolution, privilege dropping, process shutdown, Vault secret delivery, native keyboard focus trapping, clipboard permission behavior, screen-reader output, or real provider sign-in.

## Visual and layout evidence

| Capture | CSS width | Appearance / interface size | Observed result |
| --- | --- | --- | --- |
| [Ready, desktop](evidence/prototype-desktop-dark.png) | 1280 | Dark / 16px | Shared groups, rows and instructions; existing sidebar geometry |
| [Ready, inline](evidence/prototype-inline-dark.png) | 728 | Dark / 16px | Compact destination selector; no console messages |
| [Ready, phone](evidence/prototype-mobile-light.png) | 390 | Light / 16px | No page overflow; fingerprint copy stays aligned; evidence note wraps |
| [Services](evidence/prototype-services-light.png) | 820 | Light / 16px | Filters, search and rows fit without page overflow |
| [Key setup, phone](evidence/prototype-wizard-mobile-light.png) | 390 | Light / 16px | Labeled fields, focus and action area visible |
| [Key setup, desktop](evidence/prototype-wizard-desktop-dark.png) | 1280 | Dark / 16px | 448px sheet lane; focused public-key input |
| [Key setup, large text](evidence/prototype-wizard-360-20px.png) | 360 | Dark / 20px | No page overflow; dialog action area remains within bounds; content scrolls |
| [Ready, large text](evidence/prototype-360-20px.png) | 360 | Dark / 20px | Final interaction run; no page overflow; status and controls wrap |
| [Ready, smaller text](evidence/prototype-12px-light.png) | 728 | Light / 12px | No page overflow; geometry follows interface size |
| [Rollback](evidence/prototype-rollback-dark.png) | 728 | Dark / 16px | Failed candidate and restored previous version remain explicit |
| [Storage remedy](evidence/prototype-storage-light.png) | 728 | Light / 16px | Illustrative deployment fragment is never labeled applied |

Screenshots were visually inspected. Metadata records no runtime console errors, loaded Inter, no out-of-viewport elements for the instrumented captures, and visible dialog footers where opened. The tool's full-page screenshot may extend below its initial 800px viewport; a native dialog's backdrop belongs to that viewport. Do not mistake the undimmed area below it in a full-page capture for a production modal defect.

Visual refinement before formal comparison: the initial phone capture placed the fingerprint copy action on another line and separated the evidence icon from its text. [Before](evidence/prototype-mobile-light-before-refinement.png) and [after](evidence/prototype-mobile-light.png) show the change to a stable fingerprint row and a compact evidence layout. Large-text review also prompted an explicit pixel-bounded flex sheet so the action area remains visible.

The [combined comparison](evidence/comparison.png) presents actual current-console and proposal screenshots together, including 1:1 sheet regions. [design-qa.md](design-qa.md) records scope, normalization, findings and limits.

## Deliberate prototype limits

- The top scenario/appearance controls and two-destination navigation are demonstration controls. Production retains its full navigation and existing native-host bridge.
- Provider/account configuration beyond the shared flow is specified, not fully simulated. The Cloudflare route completion action is explicitly a simulation.
- Public-key format checks are illustrative. Production cryptographic validation, fingerprint derivation and option policy require OpenSSH-backed tests.
- Exact example payload versions, hostnames, fingerprints and operation IDs are sample data. They are not approval of a release or observed production evidence.
- The native dialog demonstrates the flow. Production uses Kit with the existing modal/inert host coordination.
- Light/dark and 12/16/20px layouts were rendered. Custom native palettes, actual native Settings embedding, real touch/virtual-keyboard behavior, forced colors, reduced-motion preference, 200% zoom, screen readers and physical keyboard traversal still require implementation testing. Having the CSS or DOM roles is not proof those environments passed.
- Clipboard success/fallback paths are present; real browser permission and plain-HTTP behavior have not been established by this design run.

## Custom-service visual review

New captures: [Services](evidence/custom-services-desktop-dark.png), [command entry on phone](evidence/custom-command-mobile-light.png), [behavior](evidence/custom-behavior-light.png), [review at 360px / 20px](evidence/custom-review-360-20px.png), and [inspector](evidence/custom-inspector-dark.png). The installed-tool inventory, tool versions, log messages and Vault reference labels are fixtures. No executable is launched, path checked or secret resolved.

The [combined custom comparison](evidence/custom-comparison.png) pairs current Toolchains and Add a tool with new Services and custom command fields. Normalization matches the original comparison: source 2× images at CSS size, proposal 1×, shared 1280px full-view regions and 448px focused sheet lanes. Narrow large-text review prompted stacked definition rows; [before](evidence/custom-review-360-before.png) and [after](evidence/custom-review-360-20px.png) show intact labels and paths, with the action footer visible and body scrollable. No runtime errors or page overflow were observed in the captured custom inputs.

## Engineering gates still open

Five phase-zero proofs are mandatory: select init/s6 integration with exit/signal evidence; prove complete user-worker privilege dropping and isolated mise resolution; prove the trusted OpenSSH artifact/account/session path; prove incoming Tailscale userspace routing rather than only outbound SOCKS; and map management authorization to the currently supported native-session model. The remaining foundation, failure-injection, remote-client and UX gates follow in their phases.

No SSH login, daemon restart, container recreation, provider authorization, artifact installation, image-size saving, or network route is claimed tested by this prototype.

## Integrity and cleanup

Both standalone entry points rebuild byte-for-byte. SHA-256: `prototype.html` is `b66dbc73df952d178c3cbbbc0cdb7147a03a4a0bb1d94ff2e462f9f24ed99a10`; `custom-services.html` is `d6c7530b04f0293bbc04cba87daea2962e7fcc7f12d4d0aee82ba03eb96174ee`. All local document links resolve, all four JavaScript/build helpers pass Node syntax checks, and authored design text contains no em dashes.

The original gateway worktree's binary diff still hashes to `eef3b34f4211221678d6ca5d05476e363a976fcdf7f448be44b6621678d3892b`, matching the value recorded before the isolated design work. The in-memory fixture preview process was stopped and this task's owned reference-browser tab was closed. The standalone interactive artifact needs no server.
