# t3code-docker

Run [T3 Code](https://github.com/pingdotgg/t3code) as a headless server in a
container, with the agent harnesses and language toolchains already installed.

T3 Code is a control surface for coding agents: the **server** runs the agents,
git, and your terminals, while the desktop, web, and phone apps are thin clients
over a single WebSocket. That split is what makes this work — put the server on
a box somewhere, and a phone is enough to drive it. No laptop in the loop.

> T3 Code is alpha software and moves fast. So does this image.

## What's in the box

| | `slim` | `full` (default) |
| --- | :---: | :---: |
| T3 Code server + web app | ✅ | ✅ |
| Claude Code, Codex, OpenCode, Grok, Cursor CLIs | ✅ | ✅ |
| git, git-lfs, gh, ssh, Node, Python | ✅ | ✅ |
| Go, Rust, clang/cmake, Bun, Deno, uv | — | ✅ |
| ffmpeg, ImageMagick, psql, redis-cli | — | ✅ |
| Headless Chromium + browser MCP servers | — | ✅ |
| Size on disk (pulled) | ~2.7 GB (~1.1 GB) | ~4.9 GB (~2.0 GB) |

Neither image contains credentials or model access. You bring harnesses you have
already paid for and sign them in yourself.

## Quickstart

```bash
git clone https://github.com/dizys/t3code-docker
cd t3code-docker
cp .env.example .env      # then edit T3_PUBLIC_URL, PUID/PGID, T3_WORKSPACE_HOST
docker compose up -d --build
```

Prebuilt images are published to `ghcr.io/dizys/t3code-docker` — `:latest` and
`:full` for the full image, `:slim` for the smaller one. They are multi-arch
manifests covering `linux/amd64` and `linux/arm64`, with each architecture built
*and* smoke-tested on its own native runner, so `docker pull` resolves to the
right one on an ARM server. (`v0.1.0` predates this and is amd64-only.) To run a
published image instead of building, set `T3_IMAGE` in `.env` and drop
`--build`.

Then open the setup UI on port **3774**, enter your `T3_SETUP_KEY`, and press
**Create pairing link**. Scan the QR with the T3 Code app, or open the link in a
browser.

From there you are inside T3 Code, and its own setup flow takes over: it checks
which agents are installed and signed in, and for each one **opens a terminal on
this machine with the right command ready to run**. Sign in there. Then enable
the provider under **Settings → Providers**.

That is the whole path — no shell in the container at any point. `docker exec`
is a fallback, not the route:

```bash
docker compose exec t3code t3-doctor        # what's installed, signed in, healthy
docker compose exec -it t3code t3-login claude   # if you prefer a shell to the UI
```

## First run: the setup UI

The container runs a small setup page on port **3774**, next to T3 Code itself
on 3773. It exists for exactly one job — minting a pairing link — because that
is the only step that cannot happen inside T3 Code, since it is what gets you
*to* T3 Code. Adding a device needs neither a shell in the container nor a
restart.

Set a password for it when you create the container:

```
T3_SETUP_KEY=<something long>
T3_PUBLIC_URL=https://t3.example.com
```

Leave `T3_SETUP_KEY` empty and one is generated at boot and printed to the log;
setting it yourself keeps it stable when the container is recreated. Then open
port 3774, enter the key, and press **Create pairing link** — you get a URL and
a QR code built against your public address, valid for as long as you choose.
The page also shows whether the server is healthy, whether `T3_PUBLIC_URL` is
set, and which agents are signed in.

Beyond pairing it is a small management surface: connected clients with a
**Revoke** button each, outstanding unredeemed links with the same, the
environment status, and an **Agents** card that signs your coding agents in.

### Signing agents in from the page

Each agent gets the actions it actually supports, established by running the
CLIs rather than reading about them:

| Agent | Sign in | API key |
| --- | --- | --- |
| Claude Code | `setup-token` — shows a URL, takes the code back | — |
| Codex | browser flow | stored via `login --with-api-key` |
| OpenCode | — | written to its `auth.json`, per provider |
| Cursor | browser flow | — |
| Grok Build | device code — URL plus a code to confirm | — |

**Sign in** shows the URL as a link and a QR code, so you can approve it on the
phone in your hand; where the CLI wants the code pasted back, a field appears
for it. Nothing is typed into a terminal, and the page never becomes one — it
runs the CLI and reads what it prints.

You can still use T3 Code's own setup flow instead, which opens a terminal on
this machine with the command ready to run. Both write to the same place. Revoking a client's session drops that device; it does
not touch your threads, projects or provider logins.

`T3_SETUP_ENABLED=0` turns it off once you are set up.

### Exposing it through one hostname

Two ports normally means two public hostnames. To avoid that, route by path —
the setup UI works under any prefix without being told about it, since the
request carries the prefix already. With Cloudflare Tunnel, two public hostname
entries on the same domain:

| Hostname | Path | Service |
| --- | --- | --- |
| `t3.example.com` | `__setup*` | `http://127.0.0.1:3774` |
| `t3.example.com` | *(none)* | `http://127.0.0.1:3773` |

Order matters: the more specific path rule has to come first. The setup UI is
then at `https://t3.example.com/__setup`, and T3 Code keeps the root. No
container configuration is needed for this; `T3_SETUP_BASE_PATH` exists only to
pin the prefix explicitly if you want to reject every other path.

Leaving it on a second hostname works just as well, and keeping it off the
public internet entirely — reachable only over your LAN or tailnet — is the
safest option of the three.

**Treat the key like a password.** Anything it can do, a pairing link can do —
the difference is that it can issue them repeatedly. The port is loopback-only
in `compose.yaml`; publish it only as far as you need.

Everything after pairing belongs to T3 Code's own setup flow, which checks your
agents and **opens a terminal on this machine with the right sign-in command
ready to run**. You do not need `docker exec` for that.

## Connecting a phone

The server's own startup banner prints a pairing URL built from the container's
network interface — something like `http://172.17.0.2:3773/pair#token=…`. Your
phone cannot reach that. Use `t3-pair` instead, which mints the same kind of
link against the address you actually serve on:

```bash
docker compose exec t3code t3-pair
```

```
Pairing URL: https://t3.example.com/pair#token=A2VYN48RS2CG
Expires:     2026-10-08T19:40:13.911Z
Revoke with: t3 auth pairing revoke bb46fa34-…

█▀▀▀▀▀█ ▀█ ▄ ▄▀▄▀▀▄▀▄▀ ▀▀ █▀▀▀▀▀█
… QR code …
```

Scan it with the T3 Code app
([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824),
[Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), or
paste the URL into **Add environment**.

`t3-pair` reads `T3_PUBLIC_URL`; override per invocation with
`t3-pair --base-url https://other.host --ttl 7d --label "my phone"`.

**Ignore the server's own startup banner.** It advertises the container's bridge
address, and its token is issued with a five-minute TTL, so it has almost always
expired by the time you have a tunnel up. `t3-pair` replaces both.

### Pairing without a shell in the container

If your host panel makes `docker exec` awkward, set `T3_PRINT_PAIRING_ON_START=1`
alongside `T3_PUBLIC_URL`. Every start then mints a fresh 30-day link and writes
it to the container log, where any panel's log viewer will show it:

```
[t3code] pairing link for this environment (use this one, not the banner):
Pairing URL: https://t3.example.com/pair#token=XZB9QYQQUXFB
Expires:     2026-10-09T07:36:14.314Z
```

Set `T3_PAIR_TTL` to change how long those links last. Note that this puts a
credential in your logs — fine if only you can read them, otherwise pair on
demand instead.

Pairing is per device and one-time, but you only do it **once per device**: the
resulting session lives in `state.sqlite` on the `/home/t3` volume, so it
survives restarts and image upgrades.

### Getting a public URL

Pick one:

**Caddy sidecar (automatic HTTPS).** Set `T3_DOMAIN` to a hostname pointed at
this machine, make sure ports 80 and 443 are reachable, and:

```bash
docker compose --profile tls up -d
```

This is also what the hosted web app at [app.t3.codes](https://app.t3.codes)
needs — it connects straight to your server, over HTTPS only.

**T3 Connect.** Sign the machine in and let T3's relay handle reachability.
Devices then attach by account rather than by redeeming a pairing token, and
Connect renews their credentials, so you are not re-pairing every 30 days:

```bash
docker compose exec -it t3code t3-login connect
```

This authorizes the environment; it does not start or disturb the running
server, and the link takes effect **on the next start** — so restart the
container afterwards. Use `t3-login connect` rather than `t3 connect` directly:
`docker exec` lands as root, and Connect writes into the state directory, where
root-owned files would leave the server unable to write.

**Tailscale.** Run Tailscale on the host and set `T3_PUBLIC_URL` to the tailnet
name. (`t3 serve --tailscale-serve` wants `tailscaled` inside the container;
this image does not ship it.)

**Nothing at all.** On a trusted LAN you can set `T3_BIND_ADDR=0.0.0.0` and
`T3_PUBLIC_URL=http://<server-lan-ip>:3773`. The pairing token travels in the
clear, so do not do this on a network you do not control.

## Giving agents eyes

T3 Code ships browser tools (`preview_open`, `preview_snapshot`,
`preview_click`, …), but the **server only brokers them** — a web or desktop
client hosts the actual browser. Drive the server from a phone alone and there
is no host, so the agent is blind.

The `full` image fixes that with a browser of its own:

```bash
docker compose exec t3code t3-browser-mcp              # playwright, all harnesses
docker compose exec t3code t3-browser-mcp --server chrome-devtools --harness claude
docker compose exec t3code t3-browser-mcp --remove
```

That registers a headless Chromium as an MCP server with Claude Code, Codex, and
OpenCode, so the agent can navigate, screenshot, click, and read the console
whatever client you are on. Start a new thread afterwards — providers read their
MCP configuration at session start.

Playwright is the default: `chrome-devtools-mcp` officially supports Google
Chrome rather than Debian's Chromium. It does work here — `t3-browser-mcp`
passes it the sandbox flags it needs — but it is the less tested path.

## Harnesses

Sign these in from T3 Code's setup flow, which opens a terminal on this machine
with the command ready to run. The `t3-login` column is the equivalent if you
would rather use a shell — it exists because `docker exec` lands as root, and a
harness signed in as root writes its credentials somewhere the server never
looks.

| Harness | Provider in T3 Code | Shell equivalent |
| --- | --- | --- |
| Claude Code | Claude | `t3-login claude` |
| Codex | Codex | `t3-login codex` |
| OpenCode | OpenCode | `t3-login opencode` |
| Cursor | Cursor (executable `cursor-agent`) | `t3-login cursor` |
| Grok Build | Grok Build | `t3-login grok` |

Antigravity is not installed: it signs in through Google inside the desktop app
and manages its own runtime.

**DeepSeek** has no T3 Code driver. Reach it through OpenCode — see
[`examples/opencode/`](examples/opencode/) — or by pointing a provider instance's
environment variables at a compatible endpoint.

## How long things last

Three different clocks, which is one more than is comfortable:

| | Lifetime | When it runs out |
| --- | --- | --- |
| The server's **startup banner** token | **5 minutes** | Ignore it entirely; it also names the container's own address |
| A **pairing link** | `T3_PAIR_TTL`, default 30 days | Mint another. Single-use, so one per device anyway |
| A paired **client session** | **30 days** | The device re-pairs |

The session clock is the one that matters, and nothing in the server slides it
forward on use. So expect to re-pair each device about monthly — a few seconds
in the setup UI. To avoid it entirely, use **T3 Connect**, which renews client
credentials rather than expiring them.

None of this touches your data: threads, projects, provider logins and history
live in `state.sqlite` on the `/home/t3` volume. Re-pairing drops you straight
back into everything.

## Configuration

Environment variables (all optional except where noted):

| Variable | Default | Meaning |
| --- | --- | --- |
| `T3_PUBLIC_URL` | — | Public base URL for pairing links. Set this. |
| `T3CODE_PORT` | `3773` | Server port inside the container |
| `T3CODE_HOST` | `0.0.0.0` | Bind interface inside the container |
| `T3CODE_HOME` | `/home/t3/.t3` | State directory (`userdata/state.sqlite`) |
| `T3_WORKSPACE` | `/workspace` | Scanned for projects |
| `T3_AUTO_ADD_PROJECTS` | `1` | Register each git checkout under the workspace |
| `T3_PRINT_PAIRING_ON_START` | `0` | Mint and log a pairing link on boot |
| `T3_PAIR_TTL` | `30d` | How long links from `t3-pair` stay redeemable |
| `T3_SETUP_ENABLED` | `1` | Run the setup UI |
| `T3_SETUP_KEY` | *(generated)* | Password for the setup UI. Set it to keep it stable. |
| `T3_SETUP_PORT` | `3774` | Setup UI port inside the container |
| `T3_SETUP_BASE_PATH` | — | Mount the setup UI under a path, e.g. `/__setup` |
| `T3_ALLOW_SUDO` | `0` | Give agents passwordless sudo in the container |
| `DEEPSEEK_API_KEY` | — | Used by the DeepSeek-through-OpenCode example |
| `PUID` / `PGID` | `1000` | Own the workspace bind mount correctly |

Volumes:

- `/home/t3` — state, agent credentials, shell history. Back this up.
- `/workspace` — your repositories.

Agent sign-ins normally land in `~/.claude`, `~/.codex`, `~/.cursor`, `~/.grok`
and OpenCode's XDG directories, which only persist if the whole home is mounted.
The container anchors them under `$T3CODE_HOME/agents` and links them back, so
signing in once holds even for a deployment that mounted only the state
directory. Set `T3_PERSIST_AGENT_CREDENTIALS=0` to leave them where the CLIs put
them.

**Watch for anonymous volumes.** Because the image declares `VOLUME`, running
with no `-v` still gives you a mount, and it still looks persistent from inside
— but recreating the container makes a fresh one and every sign-in, thread and
project goes with the old one. The container detects this and says so at boot:

```
[t3code] WARNING: /home/t3 is an anonymous volume. It survives a restart, but
[t3code]          recreating this container creates a new one and every agent
[t3code]          sign-in, thread and project is lost.
```

A named volume or a host directory reports the opposite, naming what it found.

Helper commands inside the container: `t3-pair`, `t3-login`, `t3-doctor`,
`t3-browser-mcp`. All of them step down from root automatically, so plain
`docker compose exec` is safe.

## Building

```bash
scripts/build.sh                                 # t3code:full
scripts/build.sh --target slim
scripts/build.sh --platform linux/amd64,linux/arm64 --push --tag ghcr.io/you/t3code
scripts/smoke-test.sh t3code:full                # boots it and checks the basics
```

Behind a TLS-intercepting proxy, drop the CA PEM into `ca-certs/` and build with
`--build-arg APT_HTTPS=true`.

## Security

An agent with a shell in this container can run anything, and the container is
the only boundary. Some consequences worth being deliberate about:

- **Pairing links are credentials.** They carry a bearer token in the URL
  fragment. Serve over HTTPS, keep `--ttl` short, and revoke with
  `t3 auth pairing revoke <id>` / `t3 auth session revoke <id>`.
- **Do not publish port 3773 to the internet.** The compose file binds it to
  loopback for that reason. Put TLS in front, or use a tunnel.
- **Provider credentials live on the `t3-home` volume** in plaintext-ish form,
  the same as they would in your home directory. Treat that volume accordingly.
- **`T3_ALLOW_SUDO=1` gives the agent root in the container.** Convenient for
  `apt install` mid-task, and a much shorter path to the host if something else
  is misconfigured. Off by default.
- T3 Code's own [permission modes](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md)
  still apply. Start supervised.

## Troubleshooting

**The pairing link does not work, or "Invalid pairing token".** Three causes,
in order of likelihood. The token came from the server's startup banner, which
expires five minutes after boot — use `t3-pair`. Or the link uses `172.x` /
`192.0.2.x`, meaning `T3_PUBLIC_URL` is unset. Or the token was already
redeemed: they are one-time, so mint a fresh one per device.

**A provider is missing in Settings → Providers.** It has to be enabled per
environment, and signed in on the server. `t3-doctor` shows both.

**Terminals do not open.** `node-pty` builds from source at image build time; a
build that skipped `build-essential`/`python3` produces this. Rebuild.

**Files in my repo are owned by the wrong user.** Set `PUID`/`PGID` to `id -u` /
`id -g` on the host and recreate the container.

**`EACCES: permission denied, mkdir '/home/t3/.t3/userdata'`.** A volume is
mounted at the state directory and the container could not take ownership of it.
The container adopts such a mount on startup, but only when it starts as root —
if your platform forces a `user:` setting, it has no way to, and it will say so
in the log. Either drop that setting and select the user with `PUID`/`PGID`, or
`chown` the host directory to that uid before mounting it.

**Chromium crashes.** Give it shared memory: `shm_size: 1gb` (compose already
does) and keep `--no-sandbox`, which `t3-browser-mcp` passes.

## Design notes

[`PLAN.md`](PLAN.md) records the research this is built on: what was verified
against the upstream source, what the container has to work around, and why the
pieces are shaped the way they are.

## License

MIT — see [LICENSE](LICENSE). T3 Code and the harness CLIs are covered by their
own licenses; this repository packages them, it does not relicense them.
