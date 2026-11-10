# Optional services prototype QA

This report covers the design-stage prototype. See
[implementation.md](implementation.md) for the integrated implementation and
its current evidence.

Final result: passed

This result applies to the reference prototype's visual consistency and demonstrated interactions, including the custom-service extension. Production readiness is not established; all 122 backend/product acceptance gates remain open.

## Source and comparison scope

- Source visual truth: [current Access](evidence/baseline-access.png) and [current Add a tool](evidence/baseline-add-tool.png).
- Implementation: [proposed SSH](evidence/prototype-desktop-dark.png), [SSH key sheet](evidence/prototype-wizard-desktop-dark.png), and [phone view](evidence/prototype-mobile-light.png).
- Combined full-view and focused evidence: [comparison.png](evidence/comparison.png), generated from [comparison.html](evidence/comparison.html) through T3 HTML preview and inspected as one input.
- Source viewport: 1280 × 800 CSS pixels, PNG 2560 × 1600 at scale 2. Source images display at 1280 CSS pixels before comparison scaling.
- Proposal viewport: 1280 CSS pixels, PNG 1280 × 1146 for SSH and 1280 × 813 for key setup at scale 1. The full comparison clips to the first 800 CSS pixels. Focused sheet regions use original 1:1 CSS scale.
- Comparison artifact: 1600 × 1531 pixels. Its full-view columns use equal display widths and scaling; focused lanes use 448 CSS pixels.

State differences are intentional: source Access / Devices versus proposed Access / SSH; source tool installation versus proposed SSH authorization. This is a component-language comparison for a new feature, not a claim of pixel-identical page content. The source's registry endpoint is absent in the fixture; that error is not attributed to production.

## Findings and required fidelity surfaces

No actionable P0/P1/P2 differences remain within the proposed prototype scope.

| Surface | Review result |
| --- | --- |
| Fonts and typography | Actual existing Inter variable font loads. The 16px rem base matches standalone geometry; title, labels, metadata and monospace instructions preserve the current hierarchy. Wrapping at 12px and 20px was also inspected. |
| Spacing and layout | Existing 15rem sidebar, content lane, grouped rows, button/input recipes and 28rem sheet lane are retained. New Access tabs separate tasks. The prototype omits unrelated nav entries. |
| Colors and tokens | Existing semantic recipes are embedded; Match appearance maps host semantic roles. Transparent artifact framing inherits the chat background, so its full canvas differs from the standalone black reference. This is an intentional host/context difference. Production uses the existing appearance bridge. |
| Assets and icons | Actual console Lucide SVG strings and existing font asset are embedded. No fabricated brand imagery or new icon language. |
| Copy and content | Service running, connection readiness, client observation, dependency impact, unknown state and rollback outcomes use distinct copy. Simulation controls are clearly labeled and must not ship into product flows. |

The focused sheet comparison makes font, focus-ring, input, radius and action geometry readable. New bounded dialog positioning is an intentional demonstration difference; production must reuse Kit's sheet and native host behavior.

## Refinement and comparison history

1. Before formal combined comparison, phone review found a detached fingerprint copy action and an evidence icon wrapping above its message. [Earlier capture](evidence/prototype-mobile-light-before-refinement.png).
2. Replaced those regions with a stable fingerprint row and a compact evidence layout. [Revised capture](evidence/prototype-mobile-light.png).
3. Bounded the sheet's flex layout to the actual available viewport and verified the action footer at 360px / 20px interface size. [Revised large-text sheet](evidence/prototype-wizard-360-20px.png).
4. The formal source/proposal combined comparison found no remaining P0/P1/P2 component-language mismatch. No further visual edits were made in response.

## Interactions, diagnostics and limits

The latest browser-rendered T3 HTML preview executes 63 simulated DOM/model assertions at 360px / dark / 20px; all pass, including original SSH flows and custom creation/edit/logs/lifecycle/removal. [Custom preview results](evidence/custom-preview-results.json) and [earlier SSH evidence](evidence/preview-results.json) record no runtime console errors, loaded Inter, no page overflow and bounded dialog actions in tested inputs.

Keyboard tests programmatically exercise tablist behavior and focus outcomes. They do not substitute for physical keyboard, screen-reader, native-host inert handling, forced-colors, virtual-keyboard or real clipboard permission tests. Production backend, network and fault recovery remain unimplemented.

## Implementation checklist

1. Resolve the four phase-zero proofs in the architecture specification.
2. Implement the shared controller and protected store before adding ad hoc service startup paths.
3. Use existing Kit, routes, copy helper, appearance bridge and phone navigation.
4. Execute the production acceptance matrix and repeat visual review against actual integrated screens.

## Custom-service extension comparison

Source visual truth: [Toolchains](evidence/baseline-toolchains.png) and the existing Add a tool capture. Implementation: [Services](evidence/custom-services-desktop-dark.png) and [command form](evidence/custom-command-desktop-dark.png). The [combined comparison](evidence/custom-comparison.png), at 1600 × 1513, was inspected as one input. Its 1280 × 800 CSS full-view regions and 448px focused lanes use the same 2× source / 1× proposal normalization. New page/task content differs intentionally.

All five fidelity surfaces were reviewed again: existing Inter and hierarchy, row/form geometry, semantic token roles, actual icon/font assets, and precise command/lifecycle/health copy. No new decorative language or asset substitution. The source registry error remains a fixture limitation.

Pre-comparison mobile refinement: 20px interface text in a two-column review split labels and working paths awkwardly. Stack definition rows below 420px. [Before](evidence/custom-review-360-before.png) and [after](evidence/custom-review-360-20px.png) retain bounded actions while allowing the body to scroll. The formal combined comparison finds no remaining actionable P0/P1/P2 mismatch within this extension's scope. No visual edits followed that comparison.

Custom inventory is simulated. Actual rootless startup, privilege dropping, mise/project trust, exact tool retention, logs/backpressure, environment/secret handling and owned process shutdown remain backend gates. The custom argv editor demonstrates one argument per line; production must support the complete token/empty-argument model. This visual QA pass does not close those implementation gates.

## Follow-up polish

P3: provider-specific Cloudflare forms and custom-native-palette behavior need review when integrated with real backend state. They are outside the reference prototype's demonstrated configuration depth and remain explicit implementation gates.
