# Gateways

A gateway is a service that speaks the agents' APIs and forwards requests
wherever you've configured it to: [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI),
[LiteLLM](https://docs.litellm.ai/docs/simple_proxy),
[OpenRouter](https://openrouter.ai/), or anything compatible.

**Setup → Gateways** connects one to your agents. You enter an address and a key
once, and each agent you choose gets a new entry in T3 Code's model picker, such
as **Claude · CLIProxy**, beside your direct sign-in. You choose per thread.

Nothing about your direct sign-ins changes. A gateway's entries are separate
provider instances that share the agent's install and user resources. Grok Build
uses a private home for gateway config and sessions, with user behavior copied
and resource directories linked from its normal home. Direct credentials and
sessions are never copied into it.

## Add a gateway

1. Choose **Add gateway…** and pick a type. **Other** fits any compatible API.
2. Enter the address and key. You can leave `/v1` off, or paste it and it's removed.
   Once both are in, the page tests them from inside this container, because that's
   where agents reach it from. A test sends empty requests, so it can't use tokens.
   CLIProxyAPI says what it is, so choosing **Other** still finds its Limits option.
3. Under **Use in**, each agent shows how many models it would get. Clear any you
   don't want, then choose **Add to … agents**.

The new row follows each agent as it starts. Then pick the new entry in the model
picker of any thread.

## Reaching a gateway from the container

An address is read from inside the container, so `127.0.0.1` means the container
itself, not your machine.

| Your gateway runs | Address |
| --- | --- |
| On the Docker host | `http://host.docker.internal:8317` |
| In another container on a shared network | `http://cliproxy:8317` |
| Somewhere else | Its usual address |

`compose.yaml` maps `host.docker.internal` for you. With `docker run`, add
`--add-host host.docker.internal:host-gateway`, and on 1Panel or similar, add the
same `extra_hosts` entry to your service. A gateway on the Docker host also has to
listen on `0.0.0.0`, not only on `127.0.0.1`.

## Which agents

| Agent | Needs | How it's connected |
| --- | --- | --- |
| Claude Code | Anthropic Messages (`/v1/messages`) | Environment variables on its own instance |
| Codex | OpenAI Responses (`/v1/responses`) | Launch arguments and a key variable |
| OpenCode | OpenAI Chat Completions (`/v1/chat/completions`) | A config file layered over your own |
| Pi | OpenAI Chat Completions (`/v1/chat/completions`) | A per-instance provider extension, without changing its home |
| Grok Build | OpenAI Responses (`/v1/responses`) | A private home with explicit model routes |

A test shows which of these your gateway offers, and an agent it can't serve
can't be turned on. Each agent has a column on the page: select a cell to turn that
agent on or off, or to choose its models.

Cursor only talks to its own service. Muse Code still needs a scoped settings
and model-catalog adapter, and the Antigravity runtime used by T3 Code has no
verified gateway adapter. They cannot be connected from here yet.

Grok's private home preserves allowlisted user behavior, including MCP, skills,
hooks and permission settings. Resource directories are linked, but auth, caches
and sessions stay separate. Reapply picks up changes to the normal user config;
invalid TOML leaves the Grok connection unapplied rather than discarding it.

## Models

The page reads the gateway's model list and gives each agent the ones it can run:
`claude` models for Claude Code, GPT and Codex models for Codex, `grok` models for
Grok Build, and every chat model for OpenCode and Pi. Models that can't hold a conversation, such as image and
embedding models, are left out. Built-in models the gateway doesn't serve are hidden
from that entry's picker, so it only shows what will work. To show every model the
gateway offers, a gateway that translates between formats can use **All** in the
gateway's details.

Some gateways, CLIProxyAPI among them, also offer Claude Code other vendors' models
under `claude-` names. T3 Code's picker uses the real names, which work just the same.

A health check notices new models but doesn't apply them, because that can restart
agents. The page says when there are some, and **Apply** brings them in. If a gateway
doesn't list models, add their IDs in its details by hand.

After identifying CLIProxyAPI, Setup also reads its Codex-client catalog at
`/v1/models?client_version=0.144.0`. This discovery is shared by all five agents,
not limited to Codex models. The ordinary model list stays authoritative, and
explicit capability facts there win. An unavailable or invalid optional catalog
does not break ordinary discovery. No inference is used to test effort support.

Reasoning controls come only from advertised effort lists, never model-name
guesses. CLIProxyAPI may advertise inherited template defaults, so its catalog
is not proof of route-specific inference support. OpenCode receives the config
spelling for its installed major. Pi and Grok expose only levels their native
clients can represent, omitting `ultra`; Pi uses provider-qualified model IDs.
Unknown models receive no generated effort controls. Pi requires fallback text
input limits (128,000 context, 8,192 output) and zero placeholder prices to register
custom models; these are not discovered limits or billing data.

On the maintained runtime, Claude Code and Codex receive explicit per-instance
model capabilities, including empty controls for unknown models. These override
built-in capabilities for matching IDs in both the picker and runtime. Selected
efforts are forwarded unchanged, without bundled effort remapping or model-name
defaults. Claude exposes only `low`, `medium`, `high`, `xhigh`, and `max`; its native
effort control cannot represent the other advertised levels. Codex's turn schema
accepts the advertised effort strings, though forwarding is not proof that a
gateway route implements them. No default effort is invented.

Setup requires an explicit runtime capability advertisement before sending these
entries. Older runtimes keep plain custom model IDs and their native T3 Code
controls, which can differ from discovered facts. Pi and Grok still need native
client changes to represent `ultra`. CLIProxyAPI needs catalog provenance to
distinguish explicit route facts from inherited templates; Setup cannot infer
that distinction from a successful request.

## Usage

**Tokens and cost** need no setup. T3 Code's **Usage** page reads each agent's own
history, so turns through a gateway count like any others. The cost is what those
tokens would cost at public API prices, not what your gateway charges, and turns
through a gateway are added to the same agent and model as direct ones.

**Limits** come from CLIProxyAPI's management API. Add its management key, and the
quota of its Claude, Codex, Antigravity, Muse/Meta and supported plugin accounts
(including OpenCode Go) appears under **Usage → Limits** in
T3 Code. Use the key you chose as `secret-key`, not the API key. CLIProxyAPI hashes
that value on startup, so what its config file shows now won't work. It also needs
`allow-remote` on unless the gateway runs in this container.

Antigravity reports each model group's quota windows. Muse needs an OAuth account
with its DCA token saved in CLIProxyAPI; an inference API key alone cannot read its
subscription quota. Plugin accounts use CLIProxyAPI's normalized quota interface,
so their quota plugin must be installed and enabled there. These readers ship in
this image's patched Stable and Nightly T3 runtime.

Meta can return an active subscription and plan without its `subs_usage` windows.
In that case the account stays visible with its plan and an explicit unknown-quota
message. Muse's SDK only exposes previously observed usage, so it cannot supply a
fresh quota reading for each account behind a gateway.

Gateway details show remaining percentages and reset times for each account.
Missing quota is shown as unavailable, with an account-specific explanation;
zero remaining is shown only when the provider reports exhaustion. One account's
failure leaves the others visible, and native Limits includes failure notices.
Request counts and success rates are never used to estimate remaining quota.

You can add it when you add the gateway, or later with **Set up…** in its details.
The page checks the key once, and only when you ask, because CLIProxyAPI locks an
address out for 30 minutes after five failures, and T3 Code never gets a key that
failed. It's kept in T3 Code's secret store rather than the Vault, because it can
administer the whole gateway and agents have no reason to ask for it by name.

A hub already added under T3 Code's **Settings → Providers → Usage providers** shows
on the gateway at that address too. It stays T3 Code's: the page won't change it, and
it stays if you remove the gateway.

Changing a gateway's address stops its Limits unless you enter the key again. The key
was only checked at the old address, and T3 Code would send it to the new one at once.

**Usage → Limits** can also say a gateway's Codex entry couldn't read its usage. That's
harmless: T3 Code looks for a subscription, and that entry doesn't have one.

## Keys

A key you enter is saved in the [Vault](vault.md), as an API token you can see and
use by name. T3 Code can't read the Vault, so each entry holds a copy: in T3 Code's
secret store for Claude Code, Codex, Pi and Grok Build, and in an owner-only file in
`<T3 state>/setup/gateways/agents` for OpenCode.

To change a key, use **Edit** on the gateway. If you replace it on the Vault page
instead, the page says so, and **Update** copies it to each agent.

An agent's own process holds the key, because that's how it signs in. Commands Codex
runs don't get it, so it never lands in Codex's shell snapshots on disk. Grok's
gateway `XAI_API_KEY` is also excluded from tool shells. Pi's extension references
the instance key variable, not a literal key in its generated source.

## What restarts

T3 Code keeps an agent's process running after its settings change, so a new key
or address wouldn't reach it. The page ends that process when one of these
changes, and the next turn starts a new one with the new settings. **A turn running
on that gateway stops.** The page says so before you save.

- Changing the address or key, or updating a key from the Vault
- **Restore** on an agent changed in T3 Code
- Turning an agent off, or removing the gateway
- New models or reasoning metadata for OpenCode, Pi and Grok, which read generated files when they start

Your threads aren't affected: they continue on the next message. Only that
gateway's agents restart, never a direct sign-in, and never anything an agent
started, such as a dev server. A new name, or new models for Claude Code and Codex,
restarts nothing.

## When something goes wrong

The page says what's wrong, and a failed test says what to do. The ones worth
knowing:

**Claude Code's settings file overrides gateways.** Gateway guides often suggest
putting `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`, and Claude Code lets that
file win over everything else. Every Claude instance would then use that address,
including your direct sign-in. **Review…** removes the settings involved and
nothing else. A project's own `.claude/settings.json` can do the same in that
project, and that's yours to change.

**Changed in T3 Code.** A setting the gateway depends on was edited under Settings
→ Providers. **Restore** puts it back and keeps anything you added, such as another
environment variable. Renaming an entry there is fine, and sticks.

**Key missing.** The Vault credential was deleted. Agents keep working on their
copies until you replace it.

**The gateway has locked this server out.** Five wrong management keys, from any
tool on this address, block its management API for 30 minutes. Agents aren't
affected. Wait it out, then enter the right key.

**T3 Code isn't answering.** You can still read your gateways, but changing them
waits until it's back, so nothing is left half done.

## Removing a gateway

**Remove…** takes its entries out of T3 Code and leaves your direct sign-ins alone.
Threads that used it stay readable and can continue on another agent. Its key stays
in the Vault for you to delete. If you set up Limits here, they go too, and T3 Code
forgets the management key.

## Reference

| What | Where |
| --- | --- |
| Saved gateways | `<T3 state>/setup/gateways/gateways.json` (no keys) |
| Keys | The Vault |
| OpenCode's config and key | `<T3 state>/setup/gateways/agents/` |
| Pi's extension | `<T3 state>/setup/gateways/agents/<id>.pi.mjs` |
| Grok's private home | `<T3 state>/setup/gateways/agents/<id>.grok/` (session history retained on removal) |
| Management key | T3 Code's secret store |
| Provider instances | `claudeAgent_gw_<id>`, `codex_gw_<id>`, `opencode_gw_<id>`, `pi_gw_<id>`, `grok_gw_<id>` |
