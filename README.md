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

Sign a harness in (needs a TTY, and must not run as root — `t3-login` handles
the second part for you):

```bash
docker compose exec -it t3code t3-login claude
```

Check the state of the world:

```bash
docker compose exec t3code t3-doctor
```

Then open T3 Code, go to **Settings → Providers**, and enable the provider you
signed in.

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

### Getting a public URL

Pick one:

**Caddy sidecar (automatic HTTPS).** Set `T3_DOMAIN` to a hostname pointed at
this machine, make sure ports 80 and 443 are reachable, and:

```bash
docker compose --profile tls up -d
```

This is also what the hosted web app at [app.t3.codes](https://app.t3.codes)
needs — it connects straight to your server, over HTTPS only.

**T3 Connect.** Sign the machine in and let T3's relay handle reachability:

```bash
docker compose exec -it t3code t3 connect
```

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

| Harness | Sign in | T3 Code provider |
| --- | --- | --- |
| Claude Code | `t3-login claude` | Claude |
| Codex | `t3-login codex` | Codex |
| OpenCode | `t3-login opencode` | OpenCode |
| Cursor | `t3-login cursor` | Cursor (executable `cursor-agent`) |
| Grok Build | `t3-login grok` | Grok Build |

Antigravity is not installed: it signs in through Google inside the desktop app
and manages its own runtime.

**DeepSeek** has no T3 Code driver. Reach it through OpenCode — see
[`examples/opencode/`](examples/opencode/) — or by pointing a provider instance's
environment variables at a compatible endpoint.

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
| `T3_ALLOW_SUDO` | `0` | Give agents passwordless sudo in the container |
| `PUID` / `PGID` | `1000` | Own the workspace bind mount correctly |

Volumes:

- `/home/t3` — state, provider credentials, shell history. Back this up.
- `/workspace` — your repositories.

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

**The pairing link does not work.** Check that it uses your public address and
not `172.x`/`192.0.2.x` — if it does, `T3_PUBLIC_URL` is unset. Links are
one-time; mint a fresh one per device.

**A provider is missing in Settings → Providers.** It has to be enabled per
environment, and signed in on the server. `t3-doctor` shows both.

**Terminals do not open.** `node-pty` builds from source at image build time; a
build that skipped `build-essential`/`python3` produces this. Rebuild.

**Files in my repo are owned by the wrong user.** Set `PUID`/`PGID` to `id -u` /
`id -g` on the host and recreate the container.

**Chromium crashes.** Give it shared memory: `shm_size: 1gb` (compose already
does) and keep `--no-sandbox`, which `t3-browser-mcp` passes.

## Design notes

[`PLAN.md`](PLAN.md) records the research this is built on: what was verified
against the upstream source, what the container has to work around, and why the
pieces are shaped the way they are.

## License

MIT. T3 Code and the harness CLIs are covered by their own licenses.
