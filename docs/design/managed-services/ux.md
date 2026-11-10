# Services and access: UI contract

This is a proposed product contract, grounded in the current console. The accompanying prototype uses simulated data. Requirements below are implementation acceptance criteria, not claims that a backend exists.

## 1. Intended experience

A person can open Access, enable SSH, use an existing network or add a connector, authorize their own public key, and leave with correct client instructions. They can distinguish a running server from a working route and an actual client sign-in. If anything fails, the page identifies the failed layer and offers the next useful action without losing the completed work.

An operator can manage the same installation through Services, inspect dependencies, update or roll back, and remove it without deleting an unrelated connection or identity. Adding a different background service should reuse this interaction model, rather than create another installer and settings page.

Primary language: service, connection, SSH key, install, enable, disable, check, sign in, update, retry. Formula, daemon, supervisor, PID, socket, ABI, and capability names appear only in diagnostics or a relevant deployment remedy.

## 2. Navigation and screen inventory

| Destination | Purpose | Primary action | Deep link |
| --- | --- | --- | --- |
| Access / Devices | Existing pairing links and paired-device revocation | Create pairing link | `#access` |
| Access / Connections | Public URL, T3 Connect, private networks, external connectors | Add connection | `#access/connections` |
| Access / SSH | Incoming login, selected route, client instructions, public keys | Set up SSH, then Copy command | `#access/ssh` |
| Services / Configured | Catalogue, custom and relevant externally owned instances | Add service | `#services` |
| Services / Needs attention | Actionable errors and stale observations | Per-row remedy | `#services?view=attention` |
| Services / Available | Curated compatible catalogue; unsupported items explain why | Set up | `#services?view=available` |
| Service inspector | State, ownership, version, consumers, recent operation, diagnostics | State-dependent action | `#services/<id>` |
| Updates | Exact service updates beside existing runtime/image updates | Review update | Existing Updates route |
| Storage | Payload, retained artifacts, cache, logs, protected identity | Review cleanup | Existing Storage route |

Access retains its existing Home/phone position. Services is a System item beside Updates, Storage, and Server. The phone More menu and command palette include it. Do not replace the existing phone navigation with two new tabs. The prototype's compact page selector exposes only its two modeled destinations.

Devices, Connections, and SSH use a single tablist with a selected indicator, ordinary sentence-case labels, and persistent location. The badge on Connections counts actionable connection issues, not all offline external devices. Updates to a count do not change layout or move focus. Existing `#access` bookmarks still land on Devices.

Global search understands “remote SSH,” “server keys,” “Tailscale,” and “services.” It opens the same destinations, with the same checked capability model. A disconnected browser returns to the same operation or draft after unlock. Secret fields are never saved to browser storage.

## 3. Visual and interaction recipes

- Use the existing Inter asset, `tc-section`, `tc-group`, `tc-row`, `tc-card-foot`, `tc-kv`, buttons, inputs, notices, badges, and Lucide icons. Respect the native semantic appearance bridge. No new brand marks, decorative network illustration, dashboard metrics, or separate service design system.
- Page title and concise lede introduce the task. Sections have a clear title, one action where useful, and quiet grouped rows. Keep the current 56rem content limit and spacing rhythm.
- A status has text plus an icon or other shape, with semantic colors. Normal Ready is restrained. Amber identifies a recoverable prerequisite, red a failed operation. Installed versions and ownership use neutral text.
- Prefer a precise inline explanation near the affected item. Toasts confirm small completed actions; they do not carry the only error, a sign-in URL, or critical recovery information.
- Each row exposes one likely next action. Less common operations live in a labeled overflow menu or inspector. Avoid a row of Restart, Update, Disable, Uninstall, and Forget buttons.
- Expand technical details on demand. Public fingerprints and commands remain selectable. Hostnames, error details, and labels wrap without pushing actions off screen.
- Mutating operations use verbs. A single shared desired-state control is authoritative. A shortcut in SSH opens the same operation; it does not create a second enable setting.

## 4. First setup journey

### Entry and prerequisites

SSH begins with a compact empty group: “Connect from your terminal or editor.” Supporting text: “Install SSH when you need it. Use your own public key and choose how this server is reached.” Action: **Set up SSH**. Explain payload changes during review, not in a marketing hero.

Opening setup performs read-only capability checks. Keep core T3 usable while checking. On failure, retain the entry and show a specific remedy. Do not silently choose a different privilege or networking mode.

| Failed prerequisite | Visible explanation | Action |
| --- | --- | --- |
| Protected persistent volume absent | “Persistent service storage is required. Add one volume to this deployment before installing SSH.” | Review deployment change; existing-network SSH still needs persistent host identity |
| Unsupported rootless SSH | “SSH server setup is not supported in this rootless deployment yet.” | View supported deployment options; other compatible services remain available |
| Missing kernel networking capability | “This Tailscale mode needs a deployment change.” | Review exact change, or choose an existing connection; userspace mode only if separately proven compatible |
| Insufficient space | Show available, required, temporary and retained storage figures if measured | Open Storage; recheck after cleanup |
| Controller or catalogue unavailable | Explain whether state is stale or installation metadata cannot be verified | Retry check; no unverified fallback download |
| Unsupported image/architecture | Show current image, architecture, and minimum supported integration | Open Updates or choose an existing externally managed connection |

The deployment review shows a minimal patch against observed Compose/configuration, what must be recreated, what persists, and how to return here. Copying it says **Copied**, never **Applied**. Unsupported deployment formats get truthful manual instructions, not an unsafe guessed patch. No container-Docker access is requested.

### Step 1: Choose a connection

Show usable existing connections first. An existing host/sidecar setup is a complete supported choice.

| Choice | Explanation | Additional requirements |
| --- | --- | --- |
| Existing network | “Use your LAN, VPN, reverse tunnel, or existing connector.” | Client-visible host, port and declared topology; verify mapping instructions |
| Existing Tailscale / Cloudflare connection | Name, ownership, account, current readiness, consumers | Protocol compatibility and route permission |
| Add Tailscale | “Connect privately through your tailnet.” | Optional payload; sign-in; proven networking mode |
| Add Cloudflare | “Use an SSH hostname through Cloudflare Access.” | Account, domain, named tunnel, Access policy; client helper when required |

An existing T3 Connect entry remains visible on Connections but is not selectable as an SSH route. Explain “For the T3 app” instead of leaving an apparently broken disabled option. Do not offer HTTP quick tunnels as raw SSH routes.

Selecting a new connector shows the extra download and account step. It is not preselected just because it is marketed as simpler. Direct network mode requests only information required for that topology. Distinguish container listener, host mapping and advertised client endpoint. Preview the route diagram in text: **Your device → existing network → host:port → SSH**.

### Step 2: Authorize a public key

Fields: **Key label**, **Public key**. A key label should help identify the device; support duplicate labels with unique internal IDs. Public-key input is multiline, monospace, and has a privacy-safe paste action only when permission allows it.

Helper copy: “Paste the public key from your device, usually a file ending in .pub. Your private key stays on your device.” Optional “Find your public key” opens platform-specific local instructions. Do not ask the user to upload or generate a private key on the server.

Validate parseability, algorithm support, length, options, duplicates and conflicting changes. A private-key block gets “This is a private key. Paste only its public key.” Clear the sensitive value without including it in logs, analytics, activity, or error echoes. In production, clear any sensitive rejected value from transient buffers where practical. Duplicate public key selects the existing entry rather than adding another authorization.

After validation, show the actual fingerprint and type before commit. The prototype only illustrates this field flow; cryptographic parsing and fingerprinting are backend gates. Initial setup requires at least one valid incoming authorization. Vault's outbound SSH credentials are never automatically imported.

### Step 3: Review changes

Review the actual plan, not a generic confirmation:

- Exact OpenSSH and any connector artifact versions, verified source and architecture.
- Download/disk values if available. Unknown values read “Size unavailable”; installation still requires a conservative backend disk policy.
- Account `t3`, selected listener, client endpoint, connection, and public-key fingerprint.
- What will be installed and started, retained data, and which existing services will change.
- Exposure and dependency implications, including whether Docker ports need changing.
- No restart, service restart, or container recreate, as actually required. “No container restart needed” is a measured capability, not universal copy.

Show an inline recheck if the plan is stale. Preserve the choices while recomputing. **Install and enable** applies the server-issued plan once. If a new connection needs external approval, make the post-install sign-in step clear before the click.

### Installation and connector sign-in

A single operation view names the current step. The view can close with **Continue in background** and reopen from SSH, Services, or the operation indicator. Reopening and reconnecting attach to its durable ID.

Downloading may have measured byte progress. Verification/startup use indeterminate progress with elapsed time. Never animate progress to a fictional 99%. **Cancel install** is shown only when the current backend phase has a defined safe cancellation path. Closing is not cancellation.

Provider approval is a distinct wait state: “Sign in to Tailscale to finish this connection.” Button **Open sign-in** opens a provider-issued HTTPS address only from a deliberate click. Keep the page available with an explicit **Check sign-in** fallback. On popup blocking, offer a selectable link in the active authenticated sheet. On expiry, request a new link only after the old request is reconciled. Do not save token-bearing URLs in permanent history, operation logs, or notifications.

If installation succeeds but account approval fails, keep the verified installation and key; show **Finish sign-in**. Retrying resumes that phase. If account approval succeeds but SSH fails, do not log out the shared account or redownload its payload.

### Completion

“Ready to connect” means service handshake and connection checks passed. Show:

1. A copyable command for the selected route.
2. Server fingerprint and a safe known_hosts/configuration action.
3. A short step for Terminal, SSH config or VS Code Remote-SSH.
4. “No device sign-in observed yet” with the limit of server-local checks.

A provider-local route check cannot change this to “Device verified.” A successful ordinary login can display “SSH sign-in observed, just now.” A route-specific challenge is required to claim that exact route is verified. Explain where a connection failure occurred and offer the relevant check.

## 5. Everyday SSH screen

Order: Connection, Connect, Authorized keys. Show detailed service health behind **View service**, not another installation panel.

Connection group shows SSH runtime, route name/provider/ownership, address, and time of last check. Primary **Copy command** lives in the Connect section. **Check readiness** updates only check evidence; it never starts or changes a service. Use a visible last-checked time with stale state when the control channel is down.

Connect has **Terminal**, **SSH config**, and **VS Code** tabs. They derive from the same selected route. A Cloudflare route includes its real client requirement and valid ProxyCommand guidance. A local terminal command stays a copyable command, with no automatic remote execution. VS Code instructions distinguish installing Remote-SSH on the user's device from installing a server dependency. Only open a supported editor URI after an explicit user action and offer a copy fallback.

Public fingerprint uses a safe wrapping field. A copy button has a specific accessible label. Never instruct the user to disable host-key verification. On host-key mismatch, replace the success instruction with an explanation, previous/current fingerprints and a recovery decision.

Authorized keys shows label, key type/fingerprint, last observed sign-in where known, and a menu with Remove. Private material is not part of this model. Add key uses the same validator as onboarding. Remove explains that existing sessions may remain; session termination is a separate supported action. Removing the last key must account for the active access path and provide an explicit impact review.

## 6. Connections

Separate **Application access** (Public URL, T3 Connect) from **Network connections** (Tailscale, Cloudflare, existing network). Rows show account/host as appropriate, local versus external owner, readiness, and consumers. Avoid presenting all links as interchangeable tunnels.

Connection detail includes supported protocols, routes, sign-in state, last provider/local check, and account actions. **Disconnect account** and **Disable connection** are separate. A disconnect may need external revocation. If provider logout fails, say “Stopped locally; provider revocation pending” and retain a resumable cleanup record. Do not claim access was revoked because a local process stopped.

For externally owned connections, show **Managed on host** or **Managed in Compose**, configuration guidance, checks and observed state. No local restart/uninstall button. Missing access to external provider status is **Unknown**, not **Offline**.

Multiple routes to a service are supported. The default connection is a client-instructions choice, not an instruction to destroy the others. Replacement flow creates a candidate, checks it, asks the device to verify it, then reviews removal of the previous route. No timer or server-local check authorizes the final removal.

## 7. Services and reusable inspector

Configured rows contain service name, exact tool/payload version where known, state, source/ownership and consumer context. Custom services use a neutral Custom label; their details state Runs as t3. Search filters names, commands, tools and consumers without modifying state. Empty filter results offer Clear filters. The Available view contains the reviewed catalogue; Add service also offers custom commands without requiring catalogue membership. Capability reasons apply to the selected source and execution profile, not a blanket privileged-storage gate on user services.

Inspector sections:

1. Summary: desired state, actual runtime, last observation/freshness, lifecycle owner.
2. Used by: routes and consumers, each linked to its task page.
3. Version and storage: exact current/retained artifact, verification and protected state.
4. Recent operation: stage, result, useful cause and resumable receipt.
5. Diagnostics: redacted logs, check results, copyable operation/error ID.
6. Actions: review update, restart, temporary stop, disable, uninstall.

Custom sections fit this shell through the definition contract. They do not add arbitrary root commands or scripts. A future non-SSH service must work without changing the navigation or controller's lifecycle semantics.

### Add a custom service

**Add service** opens a simple choice between **From catalogue** and **Custom service**. Both reuse the same inspector and operation UI. Installed mise tools are selectable without a second installation; missing tools link to the existing Add a tool flow and preserve the service draft.

The custom form has three steps:

1. **Command:** service name, Installed tool / Executable / Shell script source, exact installed tool version, executable, arguments and working directory. Direct commands pass literal arguments. Shell script mode is explicitly labeled. Browse/paste helpers must not run a command or trust project hooks during inspection.
2. **Behavior:** Enable after adding, restart policy, optional health check and selected environment/Vault references. Enabling starts it now and on container startup. Default health is Process only. Advanced settings expose shutdown grace, log policy and additional tool dependencies.
3. **Review:** real command/argv, directory, Runs as t3, pinned versions, startup/restart/health behavior, secret reference names and any declared network exposure. The primary action is Add and enable, or Add service for a disabled registration.

Use the existing sheet and form spacing. Arguments use a token editor; the prototype uses one literal argument per line and labels that limitation. The review does not display resolved secrets. A command preview is not proof it starts, and local HTTP readiness does not publish a port. Show the transition to Starting, Running or a precise failure after submission.

Default row copy for a running custom service is **Running · No health check configured**, not Healthy. Missing pinned tools show **Tool unavailable** with Choose version / Open Toolchains. A process that exits successfully shows Exited (0). Health failure, crash-budget failure and stale status have separate reasons. The inspector offers configuration, logs, owned stop/restart, disable and Remove service. Removing the registration leaves tool installations, application files and Vault entries in place.

Stop for now states that an enabled service returns at the next container startup. Disable persists off. Edit preserves the existing revision until a reviewed candidate is accepted; a name-only edit does not imply a restart. Removal reviews attached routes and consumers before unregistering. Follow the [custom-service contract](custom-services.md) for mise trust, tool references and rollback limits.

| Observed condition | Row label | Primary next action | Preserve |
| --- | --- | --- | --- |
| Absent | Not installed | Set up | Existing unrelated network |
| Installing | Installing | View progress | Operation ID and form choices |
| Waiting for account | Sign-in required | Finish sign-in | Installed payload and identity |
| Enabled, locally healthy | Running | View details | Distinction from external readiness |
| Local healthy, route healthy | Ready to connect on SSH page | Copy command | Client-evidence limit |
| Account expired | Sign-in expired | Sign in again | SSH keys, host identity, unrelated routes |
| Backoff active | Restarting | View details | Retry budget and last cause |
| Crash budget exhausted | Failed | View error / Retry | Active/previous artifact, cause |
| Stale/control loss | Status unavailable | Retry check | Last-known value and timestamp |
| Disabled | Disabled | Enable | Identity, configuration and artifacts |
| Update failure, rollback passed | Running previous version | View update result | Exact previous version and evidence |
| Required consumer exists | In use | View dependencies | Shared service until dependencies resolve |

## 8. Changes that can interrupt access

### Update and rollback

Review shows current/target version and source, consumers, interruption and recovery. State any unmeasurable session count. The primary action is **Update service**, not generic Apply. Candidate validation and rollback phases are visible in the same operation.

Readiness failure triggers the predefined recovery path. If restoration succeeds, show amber “Update rolled back” plus “Previous version is running.” Do not use a green “Update complete.” If restoration fails, show Failed, retained recovery artifacts, and a path through browser or host access. Explicitly warn of any next destructive repair in its own impact plan.

Never update the T3 runtime or change Stable/Nightly to perform a same-version service integration. Image/controller and payload compatibility use independent version fields. Update all must review active access dependencies before including them.

### Disable, uninstall and identity

Disable is durable and retains identity. Temporary stop is secondary and states exactly when it will resume. Restart briefly interrupts a service and its dependent routes. Uninstall removes the selected installation when no consumers need it; retain configuration/identity by default. A later reinstall can reuse them without changing the SSH fingerprint or creating a duplicate tailnet node.

Disabling Tailscale while SSH and a workspace preview use it shows both consumers. Offer **Manage routes**; do not silently cascade. A cascade is available only as a separately reviewed explicit plan with all affected items, expected disconnections, and fallback. The prototype demonstrates the blocked plan, not an invented successful cascade.

Forget identity is a separate destructive operation, behind explicit review with exact retained/deleted items. Require any necessary provider revocation to be reconciled before reporting cleanup complete. Never put identity deletion inside a cache cleanup checkbox.

### Recovery and concurrency

If another tab changes state, preserve draft text, say what changed and refresh the plan. Do not override newer configuration. A disabled action explains why and links to the remedy. A network timeout after submit means “Checking operation status,” not “Try install again.” Ambiguous external effects remain pending until reconciled.

## 9. Layer behavior, keyboard and accessibility

Use existing Kit side sheets, menus and dialogs in production. Wide inspectors are approximately 28rem. Compact sheets use the existing bounded/full-height recipe. Use one modal layer; a destructive review replaces the current sheet content or uses the established Kit flow, never stacks unrelated backdrops.

- Open: move focus to the heading for an informational inspector, or first relevant field for a simple form. Name every dialog and its description.
- Close/Escape: restore focus to the triggering control, or a stable destination heading if the trigger disappeared. Escape closes a draft only after the existing discard policy. It never cancels an operation.
- Trap focus only while modal. Background nav is inert through the existing host bridge. Inactive tab panels are hidden and not focusable.
- Tabs support Left/Right, Home/End and roving tabindex. A wizard is a sequential form, not a tablist masquerading as steps.
- Enter submits only a valid relevant form. Space operates buttons/checkboxes. Public-key textarea Enter inserts a newline.
- Show validation after a meaningful attempt or blur. Associate help/error with `aria-describedby`; focus the first invalid field. Keep errors inline and summarize multiple errors at the top.
- Operation milestones announce politely; do not announce every byte or poll. A failure requiring attention uses a restrained alert once, with a persistent inline state. Focus stays where the user left it during polling/theme changes.
- All icon-only buttons have specific names, all status uses words, links are discernible, and a focus ring survives custom/forced-color palettes. A disabled control's explanation is reachable without hover.
- Keep at least 44px effective touch targets for interactive rows and controls. Dense desktop visuals can use the established expanded hit area without overlap.
- Copy first uses the shared clipboard helper. On failure, select the full text and show platform-appropriate copy keys; never show “Copied” for a rejected write.
- Respect reduced motion. Avoid continuously pulsing status dots and auto-scrolling logs. Logs and code panes scroll independently only when useful; headings and action controls remain reachable at 200% zoom.

## 10. Responsive and native-host behavior

| Available space | Behavior |
| --- | --- |
| Wide standalone | Existing sidebar and 56rem content lane; inspector follows Kit's wide recipe |
| Compact standalone | Existing phone navigation and More; no duplicate sidebar; Access tabs stay visible |
| Wide native Settings | Existing parent navigation; iframe contributes page content only; appearance inherited |
| Compact native Settings | Existing host page switcher; content density responds to frame width independently |
| Narrow or large text | Rows wrap title/meta; secondary action moves to next line; code wraps or has an explicit local scroller |

Respect the current independent 1024px standalone, 768px host, and 640px frame-density decisions. Do not infer host mode only from frame width. Sheet headers/actions remain available with a virtual keyboard. Use safe-area insets for lower actions. At 360px, every primary task must work without page-level horizontal scrolling. At native 20px interface size, no title or action is clipped. Preserve scroll, selection and unsaved text when the appearance changes.

## 11. Migration and rollout UX

No automatic SSH server install just because PR #119's enable flag or an existing SSH client is present. Explicitly discover legacy opt-in configuration and offer an adoption plan with its current keys, identity, listener and owner. Do not run two sshd owners. If legacy storage is user-writable, import only validated public configuration/keys through the trusted boundary and plan protected host-identity migration with provenance. Never execute its existing mutable binary as root.

Existing managed HTTP tunnels and bundled cloudflared retain their behavior until a compatible lazy-resolution adapter passes tests. Do not remove cloudflared first and break Ports or CLI paths. Existing Tailscale-on-host deployments remain external connections. The SSH wizard must never create a second tailnet node without the user's explicit choice.

Support version skew: old images ignore new optional navigation metadata safely; new Setup reports incompatible controller versions with a remedy. A failed protected-store migration blocks only optional services and preserves readable recovery evidence. Rollout metrics, if enabled by existing product policy, use state/error codes and operation timings, never key text, account tokens, IPs, auth URLs, raw command output or host identities.

## 12. Prototype coverage and production gates

The reference prototype demonstrates Ready, Fresh, Installing, Expired sign-in, Service failure, Storage required, Update rolled back, Stale and Custom service scenarios. It includes Access navigation, SSH setup/recovery, service filtering, plus custom creation/review, commands, pinned tools, health policy, logs, edit, stop/start, disable and removal. All operations are simulations.

The simulation is deliberately labeled. Its local field checks are not OpenSSH parsing, its clipboard feedback depends on the browser, and it creates no real account, tunnel or daemon. Provider authentication, deployment patch generation, native embedding and screen-reader behavior require production testing. Every unimplemented guarantee stays open in [acceptance.csv](acceptance.csv).
