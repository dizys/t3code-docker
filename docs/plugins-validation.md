# Plugins catalog validation

Verified on 2026-11-09 using real public source snapshots, Codex 0.167.0, Claude Code 2.1.321 and OpenCode 2.2.6. Native mutations used disposable homes. No production plugin was installed; no prompts, model calls, Claude plugin commands, or MCP servers were started. OpenCode activation checks used a private authenticated loopback service with no sessions. Pi checks verify personal package declarations, not runtime behavior.

## Real source coverage

Platform detection was driven by manifests and entrypoint metadata, without manually supplying platform names. The live Setup UI was checked for all eight sources: badges matched the detected integrations, supported agent checkboxes were enabled, native-management-only targets stayed disabled, and no apply request was sent.

| Plugin | Detected integrations | Verification | Pinned source commit |
| --- | --- | --- | --- |
| [tokeneconomizer](https://github.com/microsoft/TokenEconomizer) | Codex, Claude, OpenCode, Cursor, Grok, Pi, Antigravity | Codex/Claude/OpenCode lifecycle; Pi registration (earlier verification, same pinned source) | `264e7a7f32f0112a06aa83a97b9c2c4681563968` |
| [superpowers](https://github.com/obra/superpowers) | Codex, Claude, OpenCode, Cursor, Grok, Pi, Antigravity | Codex lifecycle; OpenCode native active/absent; Pi registration lifecycle | `22f0b463e7a5e579904dd6211a520321035526f7` |
| [@mohak34/opencode-notifier](https://github.com/mohak34/opencode-notifier) | OpenCode | Detected; native package management required | `460bae5dbe1cd5e59f7123a16ec423c9bf67bbba` |
| [commit-commands](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/commit-commands) | Claude, Grok | Native Claude install/list/disable/enable/remove; coexistence | `0412be76f50ab4f4f8abff3753efa9269fbbca5b` |
| [code-review](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-review) | Claude, Grok | Native Claude install/list/disable/enable/remove; coexistence | `0412be76f50ab4f4f8abff3753efa9269fbbca5b` |
| [build-web-apps](https://github.com/openai/plugins/tree/main/plugins/build-web-apps) | Codex | Native Codex install/list/disable/enable/update-disabled/remove | `d420d13051bffe4543ed39e30fa46b87148e47dd` |
| [cloudflare](https://github.com/openai/plugins/tree/main/plugins/cloudflare) | Codex | Native Codex install/list/disable/enable/update-disabled/remove; MCP not started | `d420d13051bffe4543ed39e30fa46b87148e47dd` |
| [@franlol/opencode-md-table-formatter](https://github.com/franlol/opencode-md-table-formatter) | OpenCode | Legacy main entry detected after fix; native management required | `1c6d9ec3ecaf45f5ecc3afa71fc16c2625a60d4c` |

Grok entries indicate the shared Claude-compatible package format; Grok runtime feature support was not verified. Cursor, Grok and Antigravity require native setup. SDK npm plugins such as Notifier and Markdown Table Formatter are recognized as OpenCode integrations but are not installed by Setup's single-module adapter. Dependencies, build/install scripts and unknown execution fields remain gated.

## Fixes found by these tests

- Legacy OpenCode packages can identify their entrypoint with `main` rather than `exports`. Markdown Table Formatter was missed before this correction. Detection still requires an OpenCode SDK dependency/peer dependency; ordinary npm modules are rejected. This does not enable npm installation.
- A Pi package can carry standard `main` metadata for another host. Superpowers' valid Pi resources were blocked by this field. The field is now accepted alongside `exports`, while explicit Pi resource paths, dependency and script checks remain enforced. Superpowers then passed Pi install, disable/enable, disabled update and removal.

Regression coverage: `tests/plugin-formats.test.mjs`; the combined plugin/page suite passed **59/59**. The official Claude catalog checks are reproducible with:

```sh
T3_PLUGIN_CLAUDE_BINARY=/absolute/path/to/claude node scripts/plugins-claude-catalog-smoke.mjs
```

Existing Codex and OpenCode smoke commands are documented in [Plugins in Setup](plugins.md). Native lifecycle success does not verify a plugin's model-driven features, remote service authentication, every upstream version, or automatic upstream updates. Controlled disposable source changes tested update mechanics without following moving upstream code.
