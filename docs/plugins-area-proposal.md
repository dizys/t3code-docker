# Proposal: Plugins alongside Skills in Setup

**Status:** Draft for product and implementation review; no product changes.
**Research date:** 2026-11-09. Repository baseline: `14ce0e5`, including the working tree as inspected.
**Recommendation:** Add **Plugins** as the third tab in Setup's existing Instructions & skills area. Reuse the Skills browsing and review patterns, but manage complete packages through separate, version-aware provider adapters. Start with inventory and Codex/Claude lifecycle support where safe review can be enforced.

## 1. User problem and intended outcome

Today someone can import a repository's skills and reasonably believe they installed its plugin. They may have omitted its tools, agents, dependencies, and hooks. Conversely, plugin-owned skills appear in Skills without a first-class place to inspect or remove their parent package.

Plugins should answer: **What did I install, which agent uses it, what can it execute, how do I update it, and how do I remove it?** Skills continues to manage individual instruction folders. Plugins manages the provider's installation unit. Installing a plugin must never mean silently extracting its skills or converting its format.

Example: a user pastes a repository containing a plugin with three skills and two hooks. Setup identifies the package and compatible agents, shows all five components and any tools/dependencies, and asks for a specific agent and scope. After installation the package appears in Plugins; its skills appear in Skills with **From plugin → View plugin**. Plugin-owned skills are read-only for file editing, removal and standalone updates; independently supported native component-availability controls may remain available and must explain their scope. Hook trust, tool authorization, service authentication, and installed/enabled state remain distinct.

**Non-goals:** a new universal marketplace, automatic format translation, publishing plugins, executing arbitrary installer strings from a pasted page, or promising isolation of plugins from the rest of the container.

## 2. Repository findings and reuse boundaries

Inspected before editing: Skills UI/import/update/inspector/model code, service and provider adapters, source/provenance/file/policy helpers, native discovery, Codex hook review, Setup routing/API registration, harness catalogue, MCP service, container startup and Compose. Existing edits in `docker/setup/app.js`, `docs/agents.md`, and `docs/t3code-updates.md` were preserved.

| Existing surface | Finding | Proposed use |
| --- | --- | --- |
| [Setup tabs](../docker/setup/app.js), [page asset assembly](../docker/setup/page.mjs) | `CONTEXT_TABS` contains Instructions and Skills; Skills lives at `#instructions/skills`. | Add `#instructions/plugins`; preserve old addresses and embedded/mobile behavior. Consider renaming the navigation label to **Instructions & extensions**, without changing the route. |
| [Skills library](../docker/setup/client/skills.js), [model](../docker/setup/client/skill-model.js), [inspector](../docker/setup/client/skill-inspector.js) | Provider inventories, unified views, filtering, status explanations, sheets, and refresh/error states already exist. | Reuse visual patterns and Kit controls. Plugin identity must include provider, source, and scope; do not merge installations just because names match. |
| [Importer](../docker/setup/skills/imports.mjs), [source reader](../docker/setup/skills/sources.mjs), [import UI](../docker/setup/client/skill-import.js) | Bounded source snapshots, ten-minute previews, destination plans, stale-state checks, staging, partial results, and retries. Source resolution selects skills, not complete plugins. Git reads disable Git hooks, reject unsafe paths, and skip symlinks/submodules with warnings. | Reuse the preview → review → apply contract and audited low-level primitives. Build a plugin resolver that retains hidden manifests and the whole package. Do not pass plugins through skill extraction. Audit network and package-manager behavior separately. |
| [Updates](../docker/setup/skills/update-review.mjs), [provenance](../docker/setup/skills/origins.mjs), [update UI](../docker/setup/client/skill-update.js) | Tracks `.t3-skill-source.json`, fingerprints file contents/modes, detects local edits and affected readers. Idle auto-updates require opt-in and no local changes. | Reuse diff presentation, conflict vocabulary, and revision checks. Plugin dependency/configuration changes require their own plans; never insert skill provenance into provider-owned plugin caches. |
| [Provider adapters](../docker/setup/skills/adapters.mjs), [policies](../docker/setup/skills/policies.mjs), [reach](../docker/setup/skills/reach.mjs) | Folder detection is advisory; native coverage and availability differ by provider. Shared paths may affect several readers. | Separate capability discovery from folder presence. Keep unknown effective state explicit and compute cross-agent impact before writes. Skill availability controls are not plugin lifecycle controls. |
| [Skills service](../docker/setup/skills.mjs), [Codex bridge](../docker/setup/skills/codex.mjs) | Codex native skills include `pluginId` and source `Plugin`. Source/edit/update restrictions preserve plugin ownership. This is not a complete plugin inventory: packages with no skills are missing. | Join skills to parent packages. Inventory tools-only and hooks-only packages independently. |
| [Hook service](../docker/setup/skills/hooks.mjs), [hook sheet](../docker/setup/client/skill-hooks.js) | Only Codex plugin hooks are writable here. Native hashes, config versions and re-reads bind decisions; trust does not enable. Managed and non-command handlers are read-only. | Reuse this sheet from Plugins. Preserve `/context/skills/hooks` compatibility initially. Never infer full plugin trust from a trusted hook. |
| [Native readers](../docker/setup/skills/native.mjs) | Claude initialization suppresses hooks/MCP. OpenCode v1 uses pure debug commands; v2 starts a metadata server and waits for built-in plugins. | Do not assume starting a provider is a passive inventory operation. Review startup side effects before reusing it for plugin discovery. |
| [API](../docker/setup/server.mjs), [MCP service](../docker/setup/mcp.mjs) | Skills endpoints are under `/context/skills`; lifecycle jobs, Setup authentication, event logging, and MCP management already exist. | Add sibling plugin APIs and reuse job/auth infrastructure. Link plugin-owned MCP entries to their owner rather than duplicate or separately delete them. |

The [provider mapping](../docker/provider-integration/providers.mjs) includes Claude, Codex, OpenCode, Grok, Cursor, Muse, and Pi. [Antigravity](agents.md) is a separate T3-managed runtime, not a mise CLI. Skills' seven-provider table includes Antigravity but omits Pi: **do not derive plugin coverage solely from that table**. The [harness catalogue](../docker/harness/catalogue.mjs) supports OpenCode 1.x and an explicit 2.x alternative; both need separate contracts.

## 3. Official capability research

These are provider capabilities, not a claim that this checkout implements them. Documentation is newer than some installed releases. Each adapter must record the executable/version it actually checked, tested schema family, and reasons an action is unavailable. No live third-party plugins were installed for this research.

### Provider capability matrix

**Native** means documented upstream behavior. **Gated** means proposed Setup action only after version and safety checks. **External** means show instructions/link, no simulated local lifecycle.

| Provider | Native package/source and components | Install / update / removal | Proposed Setup support |
| --- | --- | --- | --- |
| Codex | Portable root manifest or Codex overlay; marketplaces; skills, MCP/apps and hooks. | CLI add/list/remove; marketplace upgrade; enabled config. See qualification below. | Gated CLI lifecycle; existing native hook review; no production plugin RPC. |
| Claude Code | `.claude-plugin/plugin.json`, marketplace repositories/catalogs; skills, commands, agents, hooks, MCP/LSP and additional executable components. | Native install/list/update/enable/disable/uninstall, scoped settings. | Gated lifecycle; executable sources and unsupported components blocked initially. |
| OpenCode 1.x | JS/TS modules and npm packages; `plugin` config; programmatic hooks/tools. | Automatic dependency installation at startup; no equivalent full lifecycle family established from v1 docs. | Static inventory first; reviewed config/package operations experimental. |
| OpenCode 2.x | `package.json` exports, npm/Git/local packages; `plugins` config; server/TUI/GUI/RPC parts. | Native plugin add/list/check/update/remove; ordered enable/disable selectors. | Separate experimental v2 adapter; activate mutations after pinned-artifact tests. |
| Cursor | Portable or `.cursor-plugin/plugin.json`; skills/MCP, plus native rules/agents/commands/hooks. | Desktop marketplace installs and local development; CLI `--plugin-dir`. | Inventory and external management first; CLI loading is not a persistent install API. |
| Pi | npm/Git/local packages, `package.json` `pi` resources or conventional directories; extensions/skills/prompts/themes. | Native install/list/remove and version-dependent update commands; resource configuration. | Inventory, then gated package adapter; not covered by Skills' current adapter list. |
| Grok Build | Native and Claude-compatible plugins/marketplaces; skills/agents/hooks/MCP/LSP. | Documented interactive marketplace management; shell lifecycle contract not established here. | Static inventory and external management; experimental mutations only after verification. |
| Muse Code | Official docs mention plugin-contributed skills but do not establish a complete plugin manifest/lifecycle contract. | Skills/MCP/hooks documented; full plugin install/update/remove unverified. | Unsupported plugin mutation; explain uncertainty, retain Skills and MCP links. |
| Antigravity | Root or `.antigravity-plugin/plugin.json`; skills/MCP/agents/rules/hooks; marketplace/Git/local. | Public `agy plugin` commands exist; T3 uses a separately pinned runtime. | Runtime inventory research only; CLI instructions must not be presented as supported T3-runtime actions. |

### Codex: prefer a verified CLI, avoid unstable plugin RPC

Current packaging docs describe portable `plugin.json` and compatibility `.codex-plugin/plugin.json`, local `.agents/plugins/marketplace.json`, Git and npm sources, cached copies, and layered enablement. Repo config requires project trust. Npm downloads do not run lifecycle scripts. Marketplace refresh may refresh configured plugins even when disabled. These are different operations from reviewing a skill update. [Official packaging documentation](https://developers.openai.com/plugins/build/plugins).

The inspected [upstream CLI at commit `8703d32`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/cli/src/plugin_cmd.rs) defines `codex plugin add <name>@<marketplace> --json`, `list --json` (optionally `--available`), and `remove ... --json`. It defines no top-level plugin-update subcommand. Use qualified identity; capability-probe installed releases. Do not invent `codex plugin update` or assume `add` is an update operation.

**Experimental/unsupported for production:** official app-server documentation explicitly labels `plugin/list`, `plugin/read`, `plugin/install`, and `plugin/uninstall` under development and says not to call them from production clients. CLI and documented config operations are the proposed path; hook RPC already used in this repo remains separately version-gated. [App-server method reference](https://learn.chatgpt.com/docs/app-server).

**Open questions:** exact targeted update behavior and immutable install selection for each supported CLI release; remote catalog/account availability; dependency resolution beyond documented packaging. Disable reviewed-update actions if the adapter cannot apply the exact inspected artifact. Service connections may require provider-hosted authentication; a local file installation does not prove account-level connectivity. [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins).

### Claude Code: complete lifecycle with broader execution risk

Official CLI supports marketplace add/list/update/remove and plugin install/list/update/enable/disable/uninstall. Scope is user/project/local; updates also accept managed scope. Newer releases expose JSON and command-hash acceptance. Never pass blanket `--yes`; version-probe flags and fail closed on prompts. Last-scope uninstall can delete stored options/secrets and data; `--keep-data` preserves the data directory, not necessarily every saved setting. [CLI reference](https://code.claude.com/docs/en/plugins/cli-reference).

The manifest can declare component paths, inline configuration and `userConfig`, including sensitive fields. Preserve provider schemas, plugin-root containment, namespacing, and settings storage rather than translating them into generic fields. [Manifest reference](https://code.claude.com/docs/en/plugins-reference).

Dependencies can name other plugins, including cross-marketplace references, and constrain versions. The provider resolves and prunes them. Setup must show the resolved dependency graph, source/policy decisions, and reverse dependencies; never implement a competing solver. [Dependency documentation](https://code.claude.com/docs/en/plugin-dependencies).

Installation normally enables a plugin. Hooks, monitors, mods, and MCP/LSP processes can execute with user privileges outside the agent tool sandbox; tool-call permission rules do not contain that code. Automatic marketplace updates can change previously reviewed files. First release should reject command installers, download helpers and unrecognized executable components rather than approve them implicitly. [Security and trust](https://code.claude.com/docs/en/plugins/security).

### OpenCode: maintain two adapters

V1 uses `plugin` entries and auto-loads local `.opencode/plugins/` and global `~/.config/opencode/plugins/`. Bun installs npm dependencies at startup into its cache; config-directory `package.json` can introduce further dependencies. It exposes hooks and tools through JavaScript functions, not a declarative skill bundle. There is no equivalent Codex hook-hash gate established by this source. Treat module loading as executing code. [V1 documentation](https://docs.dev.opencode.ai/docs/plugins/).

V2 uses `plugins`, native `opencode plugin add/list/check/update/remove`, npm/Git/local directories and ordered disabling selectors. Package checks/updates skip exact versions/revisions and local sources; watched configuration may reload automatically. That makes a “new sessions only” promise unsafe without testing. [Current management documentation](https://opencode.ai/docs/plugins/).

V2 `package.json` exports distinguish server, TUI, RPC, and `gui-experimental` parts. The GUI export is explicitly experimental; a container/headless installation cannot promise desktop UI support. Compatibility includes the plugin API version as well as npm dependencies. [Build reference](https://opencode.ai/docs/build/plugins).

### Cursor: distinguish desktop from the installed CLI

Cursor supports portable Agent Plugins and its native format. Desktop Customize manages marketplace installations with scope; local testing uses `~/.cursor/plugins/local` and reload. Enterprise policy can block local imports. Portable MCP variable behavior differs from the standard. Do not copy a Claude manifest into Cursor and claim compatibility. [Plugins documentation](https://cursor.com/docs/plugins).

CLI documentation exposes repeatable `--plugin-dir`, but the command table does not establish persistent marketplace install/update/uninstall operations. This repo uses `cursor-agent`, not the vendor's generic `agent` alias. **Assumption requiring integration tests:** compatible CLI builds can load a staged local package when T3 passes the flag. This requires T3 provider launch wiring, so is outside a Setup-only MVP. No desktop cache/config reverse engineering for writes. [CLI parameters](https://cursor.com/docs/cli/reference/parameters).

### Other supported agents

**Pi:** `pi install`, `list`, `remove`, npm/Git/local sources, personal `~/.pi/agent/settings.json` and project `.pi/settings.json` are documented. Current docs use `pi update --extensions`; project loading requires trust. Packages include runtime dependencies and executable extensions. Resource filters and `pi config` control what loads. Treat old `pi update` examples as version-specific. [Official packages guide](https://pi.dev/docs/latest/packages); [upstream snapshot `2cac4f1`](https://github.com/badlogic/pi-mono/blob/2cac4f1a934cdc4a80b05a7d8ff2543cf5ee623c/packages/coding-agent/docs/packages.md). Verify against T3's installed package/version before mutation.

**Grok:** docs describe `.grok/plugins`, marketplace registrations, `--plugin-dir`, a marketplace TUI, and automatic reading of Claude marketplaces/plugins/hooks. A Claude installation may therefore affect Grok. Inventory must expose that possible reader, not assume provider isolation. Full automated lifecycle and exact manifest/approval semantics remain unverified. [Official skills/plugins/marketplaces guide](https://docs.x.ai/build/features/skills-plugins-marketplaces).

**Muse:** official extension docs mention plugin skills but give no complete plugin lifecycle. User hooks lack a separate hook-trust step; project hooks depend on workspace trust. Never reuse Codex trust semantics or synthesize a `muse plugins` command. [Official extension guide](https://dev.meta.ai/docs/muse-code/extending). No reliable plugin package format established in this research: unsupported until documented or pinned upstream implementation is reviewed.

**Antigravity:** official docs describe `agy plugin install/list --json/enable/disable/uninstall/validate`, manifests, and filesystem scopes; no explicit update command was established. Public CLI support does not establish parity with T3's downloaded runtime. **Experimental integration:** inspect its supported control interface before offering actions; do not install a second CLI to mutate runtime-owned state. [Official plugin guide](https://antigravity.google/docs/plugins).

## 4. Product design and user flows

### Navigation and inventory

Keep Instructions, Skills, and Plugins together. Plugins has **Installed**, **Updates**, and **Sources**, plus **Add plugin**. Use provider and scope filters, search, count badges, accessible table/cards, and the same responsive inspector pattern as Skills. Do not show a global multi-provider availability switch: installation, policy and effective state are provider-specific.

Rows show package name, agent, scope/project, source/publisher, installed version or commit, component counts, and a meaningful status: **Enabled**, **Disabled**, **Needs hook review**, **Needs sign-in**, **Update available**, **Managed**, **Found on disk**, **Unsupported version**, **Partially installed**, or **State unknown**. Several statuses may coexist. Found files are not evidence that a provider loaded them. Failure to read a source is not an empty inventory.

The inspector has Overview, Components, Permissions & execution, Source & updates, and Activity. Show declared versus discovered components, exact hook commands where available, MCP endpoints/launch arguments with secrets redacted, dependency edges, install locations, configuration ownership, and supported actions. Unknown executable behavior is a visible warning, not a zero component count.

### Add a plugin

1. Choose an agent (or paste a repository, marketplace source, package specifier or container folder first). Detection explains compatible formats and lists packages in a multi-plugin repository. No execution occurs during inspection.
2. Choose **Personal — this container** for MVP. Later offer an explicit project selector and explain shared project declarations versus local overrides. A browser's machine and the container are different targets.
3. Review source owner/URL, marketplace identity, manifest path, exact revision/integrity, component list, dependency closure, affected agents, files/configuration to change, and automatic activation/update behavior.
4. If dependencies cannot be safely resolved without executing code, or native install cannot consume the reviewed revision, show **Manage in agent** with a specific reason. Don't silently loosen the contract.
5. One explicit **Install for Claude Code** (for example) approves the reviewed package operation. Separate approval is required for any displayed executable installer; block those in MVP. No blanket tool authorization, project trust, sudo, hook trust or service login is implied.
6. Run a bounded job. Report per-step outcomes and re-read native state. Success distinguishes installed from usable: **Installed; review 2 hooks**, **Installed; connect service**, or **Installed; start a new session**. Never report verified enablement from exit code alone.

If the agent installs and enables atomically, the review must say **Will enable immediately** before confirmation. Prefer install-disabled only where natively supported. If immediate activation cannot safely be avoided or reviewed, withhold installation rather than briefly enabling then disabling it.

### Review, updates and sources

**Review hooks** opens the existing Codex sheet filtered by plugin. Other providers show their actual review mechanism or **Review in agent**. Do not offer a fake universal “Trust all hooks”. Trusting the current command remains separate from enabling it.

**Check for updates** fetches metadata without activating code. **Review update** shows installed → resolved version/commit, all file changes (including hidden manifests, binaries and modes), dependencies, source changes, hooks, MCP endpoints and execution changes. Locally edited packages require an explicit decision or external management; never overwrite them in an idle job. Expired plans require a new review.

**Sources** lists configured marketplaces and repositories with origin, last refresh, scope and managed policy. Adding a source is distinct from installing a package. Refresh may have provider-specific installation side effects: label it **Refresh marketplace and configured plugins** where appropriate, and require the corresponding review. Removing a source previews every dependent install and never recursively deletes an arbitrary checkout.

**Automatic checks** can be opt-in. **Automatic plugin installation/update is off in the first release.** Surface provider-native auto-update separately: Setup's switch cannot promise to stop updates the provider performs itself. If Setup cannot enforce review between versions, label the installation **Updated by agent** rather than **Updates reviewed by Setup**.

### Disable and remove

Disable explains scope precedence, dependencies, cross-agent effects, and whether running sessions/processes retain code. Prefer new-session boundaries; never terminate active threads without a separate user action.

Remove previews the exact registration/files, remaining scopes, reverse dependencies, data and credential consequences, and whether a source remains available to reinstall it. Default to preserving user data where the provider can honor that; otherwise state the destructive native behavior before confirmation or require external management. Uninstall does not revoke remote OAuth grants. Offer an independent connection-revocation link, never delete unrelated credentials.

After a lost response, show **Checking current state**; reconcile before retrying. Provide **Retry remaining steps**, **Disable**, or **Manage in agent** for partial installs. Do not hide residual dependencies or a successful install behind a single failed authentication step.

## 5. Safety and persistence model

This is package execution management, not just Markdown editing.

- **Read before execution:** inspect manifests/archives as data in a non-discovered staging directory. No module import, lifecycle scripts, hooks, MCP startup, dynamic installer, submodule checkout or LFS filter during preview. Never start a regular provider session to populate the Plugins tab. Metadata commands must be tested for initialization side effects and run in a safe context; otherwise use static inventory with reduced coverage.
- **Artifact binding:** hash the complete install tree including hidden manifests, modes, dependency locks and resolved transitive artifacts. Display omitted binary/large diff portions. Bind consent to provider executable version, config revision, source identity, artifact/dependency hashes, scope and effective readers. A tag/version label alone is insufficient. Revalidate before apply and after native mutation. If the upstream installer re-resolves a moving target and cannot accept a pin, reviewed installation stays unavailable.
- **Fetching boundary:** validate protocols/hosts and redirects; block embedded credentials, URL options, traversal, special files, escaping links, archive bombs and excessive depth/size. Restrict public URL fetching from loopback/private/link-local/metadata endpoints, including DNS rebinding; intentional local/private sources need an explicit authenticated source policy. Reuse source-reader defenses only after auditing these guarantees. Set process, byte, entry, dependency and network time limits.
- **Execution approval:** review package code and dependency scripts separately from agent tool approvals. Default-deny package lifecycle scripts and external build steps; unavailable script suppression means unsupported automated install. Use argv-based execution, managed binary paths, fixed verbs, minimal environment, no inherited provider-instance secrets and no shell interpolation. Private Git/registry access uses existing credential mechanisms, never credentials in URLs/logs.
- **Trust:** retain provider-native checks and enterprise allowlists. Codex hook decisions use its current exact hashes, including content binding when supported. Do not write generic “trusted=true” into native settings. No changes to managed sources, no forced project trust, `--yolo`, `--approve-mcps` or equivalent bypass. Dynamic MCP tool lists are discovered only after separate activation consent; a manifest cannot prove all runtime capabilities.
- **Container exposure:** [Compose](../compose.yaml) persists all of `/home/t3` and bind-mounts `/workspace`; [startup](../docker/entrypoint.sh) runs the service as the unprivileged user after setup. Code under that user can still read accessible home credentials, change projects, contact networks and persist into later recreations. `T3_ALLOW_SUDO` is configurable. The container is not a boundary between mutually untrusted plugins. Warn concretely at installation; high-risk plugins should use a separate container/home with restricted mounts/egress. Do not grant Docker socket, host mounts, root or sudo for a plugin.
- **Recovery:** serialize by actual provider config/install root, coordinate with harness/runtime lifecycle jobs, and use expected revisions for writes. Native state is authoritative. Record durable operation intent/outcome so restarts reconcile rather than blindly replay. Back up touched configuration and owned artifacts; rollback is conditional, cannot undo code execution or remote side effects, and must not overwrite concurrent native edits.
- **Persistence:** provider configurations/caches/data remain in native persistent homes. New Setup metadata belongs under the existing Setup state directory (`STATE_DIR/plugins/...`, schema-versioned, owner-only). Project declarations live only in explicitly selected projects; do not commit them automatically. Recreating the container retains installations; uninstalling an agent should not implicitly erase plugin data. Purge is a separate explicit operation.

## 6. API and data model (proposed)

Use a sibling `createPluginsService` and `docker/setup/plugins/` modules. Start with concrete provider adapters; no generalized package framework or new database is needed. Extract shared file/diff/source helpers only where both call sites require the same contract. Keep native plugin and skill IDs distinct.

```text
GET  /context/plugins/capabilities       provider/version/action support + reasons
GET  /context/plugins                    inventories, coverage, warnings, revisions
GET  /context/plugins/read?id=...        safe metadata/components; no execution
GET  /context/plugins/sources            native marketplace/source registrations
POST /context/plugins/check-update       discovered installation IDs; per-install results, no activation
POST /context/plugins/preview            source or discovered ID + operation + scope
POST /context/plugins/apply              planId + expectedRevision + consentIds + idempotencyKey
GET  /context/plugins/jobs?id=...         progress, result, recovery state
POST /context/plugins/cancel             jobId; best-effort cancellation
POST /context/plugins/discard            planId
```

`operation` is an allowlisted install/update/enable/disable/remove/source-add/source-refresh/source-remove value. Inventory IDs and project IDs are resolved server-side; clients cannot supply arbitrary config paths, executables, command strings or deletion targets. Plans are bound to the authenticated Setup session that requested them. Apply can only perform the operation in its plan. Hook trust continues through the existing endpoint and native token mechanism. Sign-in/configuration gets a separate provider-supported flow; no secret values in plan records.

```typescript
// Conceptual wire shapes, not implementation code.
type PluginInstallation = {
  id: string; provider: string; nativeId: string;
  scope: 'user' | 'project' | 'local' | 'managed' | 'session'; projectId?: string;
  source: { kind: 'marketplace' | 'git' | 'npm' | 'local' | 'remote';
            identity: string; marketplaceId?: string; subpath?: string;
            requestedRef?: string; resolvedRevision?: string; integrity?: string };
  version?: string; manifestFormat: string; manifestVersion?: string;
  installed: boolean | null; enabled: boolean | null;
  effectiveState: string; ownership: 'setup' | 'native' | 'managed' | 'unknown';
  components: ComponentSummary[]; dependencies: DependencyEdge[];
  execution: { declared: string[]; unknown: boolean; installExecutesCode: boolean | null };
  coverage: 'native' | 'filesystem' | 'partial' | 'unavailable';
  revision: string; capabilities: Record<string, { supported: boolean; reason?: string }>;
};
type PluginPlan = {
  id: string; expiresAt: number; operation: string; installationId?: string;
  providerVersion: string; configRevisions: Record<string, string>;
  artifactDigests: string[]; dependencyChanges: DependencyEdge[];
  effects: string[]; affectedReaders: string[]; destructiveEffects: string[];
  requiredConsents: string[]; activation: 'immediate' | 'new-session' | 'manual' | 'unknown';
};
```

A component records type, native identifier, safe relative path, digest, declaration/discovery origin, management owner and coverage; raw executable content is text, never HTML. Dependencies distinguish plugin packages, runtime libraries/binaries and remote service prerequisites, with requested/resolved versions, integrity and reverse edges. A source record retains canonical origin, native name, scope, policy, revision and last check/error. Display names cannot authorize ownership or deletion.

Capabilities are per operation and scope, not a single `supported` boolean. A missing adapter is different from a missing executable or denied policy. Cache inventory, invalidate after jobs and native changes, and refresh lazily when the tab opens; no plugin network work in `/status` polling. Existing Skills/MCP consumers get only optional owner links at first.

Use the existing authenticated Setup request boundary, mutation protection, body limits, job conventions and sanitized audit events. Expected errors: `invalid`, `unsupported`, `policy_denied`, `conflict` (409), `busy`, `auth_required`, `unavailable`, `too_large`, `partial`. Return operation effects/results without secrets. An ambiguous job result requires reconciliation; idempotency keys prevent a double-click or retry from starting duplicate installs.

## 7. Phased implementation and release gates

| Phase | Deliverable | Gate to ship |
| --- | --- | --- |
| 0 — Contract validation | Pinned provider fixtures, version/help probes, static parsers, documented execution/update behavior. | Establish which metadata calls are passive; prove pinning, script suppression and native ownership. Unsupported releases stay read-only. |
| 1 — First-class inventory | Plugins tab, provider/scope filters, independent inventory, component inspector, source visibility, Skills/MCP owner links, Codex hook entry point. | Tools-only/plugins-without-skills visible; no untrusted code executed on browsing; unavailable inventory never shown as empty. |
| 2 — Reviewed personal lifecycle | Claude and verified Codex CLI install/enable/disable/remove subsets, safe source registration, jobs and recovery. No blanket cross-agent install or auto-update. | Review/apply binds immutable artifacts and dependencies; activation/removal effects visible. Withhold each operation that fails the gate, including targeted Codex update if unresolved. |
| 3 — Reviewed updates and additional agents | Full package/dependency diffs; tested OpenCode v1/v2 and Pi adapters; native-update ownership reporting. | Version-specific side-effect tests, cold-home installs, no local-edit loss, no execution on checks. Experimental badge until these pass. |
| 4 — Project/team scope and optional automation | Project trust-aware scope selection, policy reporting, guarded auto-update where enforceable; Cursor launch integration and Antigravity runtime integration only with proven contracts. | Integration with actual T3 launch paths, project precedence and active-session behavior; no assumed desktop/CLI parity. |

**MVP acceptance:** a user can find an existing package, understand its source and execution surface, reach its skills and supported hook review, and distinguish installed from usable. Supported lifecycle actions work without a terminal; unsupported ones explain the exact limitation. Inventory is useful even if no mutation adapter passes phase 0.

## 8. Tests and risks

Extend existing test conventions; this proposal adds no executable code or tests. Future implementation should cover:

- **Parser/adapter fixtures:** each supported version family; hidden/root/overlay manifests; malformed/duplicate fields; multi-plugin marketplaces; npm scoped names, refs and subdirectories; same name from two sources; zero-skill packages; policy-managed and session-only installs. Test OpenCode `plugin` versus `plugins` explicitly and Pi's absence from the current Skills table.
- **Safety fixtures:** malicious lifecycle scripts, modules/hooks/MCP launchers that create sentinel files; preview/list/check must not create them or make unexpected network requests. Test package dependencies too, not only the top-level manifest. Exercise traversal, links, special files, oversized/deep archives, credential-bearing URLs, private-address redirects and command injection.
- **Plan integrity:** changed ref/artifact/dependency/config/binary/version/readers after preview; expired token, replay, cross-user token, forged path or changed operation; local edits and conflicting native changes must refuse apply. Verify Codex trust-without-enable, modified hook hash and managed/non-command read-only behavior.
- **Lifecycle/recovery:** success and verification failures, one dependency failing, native prompt refusal, already-in-goal-state, timeout/process-tree cleanup, cancel mid-install, lost HTTP reply, server/container restart, disk-full and rollback conflicts. Assert final on-disk/native state and durable results, not just command arguments.
- **Removal/persistence:** two scopes share a package/data, reverse dependencies, external/unowned checkout, symlinked home/config, retained versus deleted options/secrets, remote grants not revoked, source removal effects. Recreate using the same home volume; removal must not reappear from a surviving project declaration without explanation.
- **UI/API:** standalone and embedded routes, back/forward/deep links, mobile sheet, keyboard/focus/ARIA, escaped source content, partial inventory, offline/stale statuses, disabled actions with reasons, confirmation effects, protected mutations, double-click idempotency and audit redaction. Verify Skills and MCP regressions remain green.
- **Real integration:** disposable home/container, fixed provider versions and fixture repositories, no production credentials. Test actual T3 launches and whether changes affect a running session; never infer agent behavior from Setup config alone.

| Risk | Product/engineering response |
| --- | --- |
| Fast-changing native formats/API | Version/schema capability gates, pinned upstream fixtures, fail closed; no undocumented production plugin RPC. |
| Source/dependency changes between review and install | Immutable snapshots and exact resolved closure; withhold automation where the native installer cannot honor it. |
| Provider-native updates bypass Setup review | Display who updates it; don't promise enforcement or rollback that Setup cannot provide. |
| Code executes at startup outside tool sandbox | Pre-install execution disclosure, script suppression, no automatic trust; separate restricted container for stronger isolation. |
| Cross-agent compatibility expands reach | Explain known and possible readers; verify affected native state instead of assuming per-agent folders isolate behavior. |
| Removal loses saved data or breaks dependents | Effect preview, native dependency checks, verified preservation options; no default recursive deletion. |
| Desktop/account support differs from T3 runtime | External management and experimental labels until launch/runtime integration is proven. |

**Assumptions to resolve before mutations:** Setup authentication authorizes container-wide personal plugin management; existing job infrastructure can coordinate provider config writes; selected native releases expose passive inventory and sufficiently exact install behavior. These are proposed acceptance gates, not established facts. No runtime smoke test, security certification, cross-provider conversion support, or account entitlements are claimed by this draft.
