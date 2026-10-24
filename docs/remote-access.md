# Reaching the server from a phone

## Pairing a device

The server's own startup banner prints a pairing URL built from the container's
network interface, such as `http://172.17.0.2:3773/pair#token=…`. Your phone
can't reach that address. Use `t3-pair` instead, which creates the same kind of
link for the address you serve on:

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

`t3-pair` uses the [public URL](#the-public-url). You can override it per command, for example
`t3-pair --base-url https://other.host --ttl 7d --label "my phone"`.

**Ignore the server's startup banner.** It shows the container's internal
address, and its token expires after five minutes, usually before your tunnel
is up. `t3-pair` fixes both.

## Pairing without a shell in the container

If your host panel makes `docker exec` awkward, set
`T3_PRINT_PAIRING_ON_START=1` once a public URL is set. Each start then
creates a 30-day link and writes it to the container log, where any log viewer
shows it:

```
[t3code] pairing link for this environment (use this one, not the banner):
Pairing URL: https://t3.example.com/pair#token=XZB9QYQQUXFB
Expires:     2026-10-09T07:36:14.314Z
```

`T3_PAIR_TTL` sets how long these links last. This puts a credential in your
logs, which is fine if only you can read them; otherwise create links on
demand.

You only pair **once per device**. The session is stored in `state.sqlite` on
the `/home/t3` volume, so it survives restarts and image upgrades.

## The public URL

A pairing link points at the address your phone or browser uses to reach the
server, so the setup page needs that address before it can pair anything. It
uses the first of these that is set:

1. `T3_PUBLIC_URL` in the container's settings. The setup page shows it as set
   there and doesn't offer to change it.
2. An address saved on the setup page. It's stored on the volume
   (`/home/t3/.t3/public-url`), takes effect at once, and survives a recreate.
3. The address a hosting platform gives the service: Railway
   (`RAILWAY_PUBLIC_DOMAIN`), Render (`RENDER_EXTERNAL_URL`), Koyeb
   (`KOYEB_PUBLIC_DOMAIN`), Zeabur, Coolify, or Fly (`<app>.fly.dev`).

If none is set, **Overview** asks for one. When you opened the setup page on
T3 Code's own address (through `T3_SINGLE_PORT`, or a proxy that routes
`/__setup` on the same hostname), it offers that address as a single button,
having checked that T3 Code answers there. Otherwise **Set address** takes
any address, such as `t3.example.com` or `http://192.168.1.20:3773`. Change it
later under **Access → How devices reach this server**.

Before saving an address you typed, the setup page asks it for T3 Code's
environment from inside the container. If a different T3 Code server answers,
it refuses, because links there would pair with that server. If nothing
answers, it saves the address anyway and says why: LAN and tailnet names often
can't be reached from inside a container, and only your devices need to reach
them.

`t3-pair`, `t3-doctor` and the startup log use the same address.

## Getting a public URL

Pick one:

**Caddy sidecar with automatic HTTPS.** Set `T3_DOMAIN` to a hostname that
points at this machine, make sure ports 80 and 443 are reachable, and run:

```bash
docker compose --profile tls up -d
```

The hosted web app at [app.t3.codes](https://app.t3.codes) needs this too: it
connects directly to your server, and only over HTTPS.

**T3 Connect.** T3's relay makes the server reachable, with no domain or
tunnel of your own. Devices then connect through your T3 account instead of a
pairing link, and Connect renews their credentials, so you don't re-pair every
30 days.

On the setup page, **Access → T3 Connect → Set up** shows a link and a code
to approve in any browser. T3 Code makes the link when it starts, so the page
then offers to restart it, and shows when the link is made. The container keeps
running throughout. **Turn off T3 Connect**, in its **⋯** menu, undoes it and
keeps your sign-in, so turning it on again asks for no new code.

Under the same Access section, **Publish agent activity** enables T3's mobile
notifications and Live Activities for agents running on this server. Sign in
to the same T3 account in the mobile app and allow notifications there. These
are agent activity notifications; they do not report container health or setup
updates. The setting uses T3's native API and takes effect without a restart.
Activity publishing also works with an existing notification-only T3 link;
it does not require routing your connections through a T3 Connect tunnel.

**Hold webhooks while offline** requires an active T3 Connect tunnel. When
enabled, T3 Connect stores incoming webhook requests outside this server for
up to 24 hours and delivers them when it returns. Turning it off does not
discard requests already held. The controls stay disabled until the server is
linked and its native settings can be read; update T3 Code if your version
does not support them.

From a shell, the same sign-in is:

```bash
docker compose exec -it t3code t3-login connect
```

The link then takes effect **on T3 Code's next start**: use **Restart** under
**Server → T3 Code**, or restart the container. Use `t3-login connect` rather
than `t3 connect` directly: `docker exec` runs as root, and Connect writes into
the state directory, where root-owned files would stop the server from
writing.

**Tailscale.** Run Tailscale on the host and set the public URL to the
machine's tailnet name. (`t3 serve --tailscale-serve` needs `tailscaled` inside
the container, which this image doesn't include.)

**Nothing.** On a trusted LAN, set `T3_BIND_ADDR=0.0.0.0` and the public URL
to `http://<server-lan-ip>:3773`. The pairing token is then sent
unencrypted, so only do this on a network you control.

## Exposing it through one hostname

Two ports normally mean two public hostnames. The simplest way to need only
one is `T3_SINGLE_PORT`. The container then also listens on that port and
serves both there: T3 Code at the root, and the setup page at `/__setup`.
Point your tunnel, reverse proxy or hosting platform at that port alone:

```yaml
    environment:
      T3_SINGLE_PORT: 8080
    ports:
      - "127.0.0.1:8080:8080"   # instead of the 3773 and 3774 lines
```

With Cloudflare Tunnel that is one public hostname entry, `t3.example.com` to
`http://127.0.0.1:8080`. The setup page is then at
`https://t3.example.com/__setup`, and T3 Code's Settings find it there without
any configuration. Opened there, the setup page also offers
`https://t3.example.com` as the [public URL](#the-public-url).

What to expect from it:

- WebSockets, streamed responses and large uploads pass straight through.
  Nothing is buffered or rewritten.
- While T3 Code starts or restarts, a browser gets a short page that says so
  and opens T3 Code once it answers. Anything else gets a `503` with
  `Retry-After`.
- It adds the visitor's address to `X-Forwarded-For`, and keeps the
  `X-Forwarded-Proto` and `X-Forwarded-Host` that a proxy in front of it set.
  The setup page counts wrong keys per visitor from that address.
- Ports 3773 and 3774 still answer inside the container, so `t3-pair`,
  `t3-expose` and anything else that talks to them keep working.
- The Docker healthcheck asks through the one port, so the container reports
  unhealthy if that port stops answering.
- A port it can't serve, such as T3 Code's own 3773, stops the container at
  start with a message saying what to change.

If you'd rather route by path in your own proxy, that works too. The setup page
works under any path prefix without configuration, because each request
carries the prefix. With Cloudflare Tunnel, add two public hostname entries for
the same domain:

| Hostname | Path | Service |
| --- | --- | --- |
| `t3.example.com` | `__setup*` | `http://127.0.0.1:3774` |
| `t3.example.com` | *(none)* | `http://127.0.0.1:3773` |

The more specific path rule must come first. `T3_SETUP_BASE_PATH` is only
needed to pin the prefix and reject every other path. With `T3_SINGLE_PORT`, it
also moves the setup page to that prefix on the one port. T3 Code's Settings
only look for it at `/__setup` and `/setup`.

A separate hostname works just as well. Keeping the setup page off the public
internet entirely, reachable only over your LAN or tailnet, is the safest
option.

**Treat the setup key like a password.** It can do everything a pairing link
can, and it can create new links. `compose.yaml` binds the port to loopback;
only publish it as far as you need to. If it leaks, replace it under
**Server → This console**, or change `T3_SETUP_KEY` if you set one. A browser already paired with T3 Code
doesn't need the key (see [Opening it from T3 Code](setup-page.md#opening-it-from-t3-code)).

## How long things last

There are three separate expiry times:

| | Lifetime | When it runs out |
| --- | --- | --- |
| The server's **startup banner** token | **5 minutes** | Ignore it; it also shows the container's internal address |
| A **pairing link** | `T3_PAIR_TTL`, 30 days by default | Create another. Links are single-use, so one per device anyway |
| A paired **client session** | **30 days** | The device pairs again |

The session is the one that matters, and using a device doesn't extend it, so
expect to re-pair each device about once a month. That takes a few seconds on
the setup page. T3 Connect avoids it by renewing client credentials instead of
letting them expire.

None of this affects your data. Threads, projects, provider sign-ins and history
are stored in T3 Code's SQLite databases on the `/home/t3` volume, and re-pairing brings
everything back.
