# Gateways

A gateway is a service that speaks the agents' APIs and forwards requests
wherever you've configured it to: [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI),
[LiteLLM](https://docs.litellm.ai/docs/simple_proxy),
[OpenRouter](https://openrouter.ai/), or anything compatible.

**Setup → Gateways** connects one to your agents. You enter an address and a key
once, and each agent you choose gets a new entry in T3 Code's model picker, such
as **Claude · CLIProxy**, beside your direct sign-in. You choose per thread.

Nothing about your direct sign-ins changes. A gateway's entries are separate
provider instances that share the agent's install and home, so your threads,
skills, MCP servers and instructions all work the same on both.

## Add a gateway

1. Choose **Add gateway…** and pick a type. **Other** fits any compatible API.
2. Enter the address and key. You can leave `/v1` off, or paste it and it's removed.
3. **Test and continue** checks it from inside this container, because that's
   where agents reach it from. A test sends empty requests, so it can't use tokens.
4. Choose the agents, then **Connect**. They start, and the sheet shows when each
   is ready.

Then pick the new entry in the model picker of any thread.

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

A test shows which of these your gateway offers, and an agent it can't serve
can't be turned on.

The others can't be connected from here, because a gateway couldn't be limited to
one instance. Pi and Grok Build read endpoints from a file every instance shares,
so your direct sign-in would use the gateway too. Cursor only talks to its own
service, and Muse Code and Antigravity have no custom endpoint setting.

## Models

The page reads the gateway's model list and gives each agent the ones it can run:
`claude` models for Claude Code, GPT and Codex models for Codex, and every chat
model for OpenCode. Models that can't hold a conversation, such as image and
embedding models, are left out. Built-in models the gateway doesn't serve are hidden
from that entry's picker, so it only shows what will work. To show every model the
gateway offers, a gateway that translates between formats can use **All** in the
gateway's details.

Some gateways, CLIProxyAPI among them, also offer Claude Code other vendors' models
under `claude-` names. T3 Code's picker uses the real names, which work just the same.

A health check notices new models but doesn't apply them, because that can restart
agents. The card says when there are some; **Refresh** in the details applies them.
If a gateway doesn't list models, add their IDs there by hand.

Custom models can have fewer effort and thinking options in T3 Code than built-in
ones. Usage limits come from a direct sign-in, so a gateway's entries don't show them.

## Keys

A key you enter is saved in the [Vault](vault.md), as an API token you can see and
use by name. T3 Code can't read the Vault, so each entry holds a copy: in T3 Code's
secret store for Claude Code and Codex, and in an owner-only file in
`<T3 state>/setup/gateways/agents` for OpenCode.

To change a key, use **Edit** on the gateway. If you replace it on the Vault page
instead, the card says so, and **Update** copies it to each agent.

An agent's own process holds the key, because that's how it signs in. Commands Codex
runs don't get it, so it never lands in Codex's shell snapshots on disk.

## What restarts

T3 Code keeps an agent's process running after its settings change, so a new key
or address wouldn't reach it. The page ends that process when one of these
changes, and the next turn starts a new one with the new settings. **A turn running
on that gateway stops.** The page says so before you save.

- Changing the address or key, or updating a key from the Vault
- **Restore** on an agent changed in T3 Code
- Turning an agent off, or removing the gateway
- New models for OpenCode, which reads them when it starts

Your threads aren't affected: they continue on the next message. Only that
gateway's agents restart, never a direct sign-in, and never anything an agent
started, such as a dev server. A new name, or new models for Claude Code and Codex,
restarts nothing.

## When something goes wrong

The card says what's wrong, and a failed test says what to do. The ones worth
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

**T3 Code isn't answering.** You can still read your gateways, but changing them
waits until it's back, so nothing is left half done.

## Removing a gateway

**Remove…** takes its entries out of T3 Code and leaves your direct sign-ins alone.
Threads that used it stay readable and can continue on another agent. Its key stays
in the Vault for you to delete.

## Reference

| What | Where |
| --- | --- |
| Saved gateways | `<T3 state>/setup/gateways/gateways.json` (no keys) |
| Keys | The Vault |
| OpenCode's config and key | `<T3 state>/setup/gateways/agents/` |
| Provider instances | `claudeAgent_gw_<id>`, `codex_gw_<id>`, `opencode_gw_<id>` |
