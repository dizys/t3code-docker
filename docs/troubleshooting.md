# Troubleshooting

**A pairing link doesn't work, or says "Invalid pairing token".** The likely
causes, most likely first: the token came from the server's startup banner,
which expires five minutes after startup (use `t3-pair`); the link uses a
`172.x` or `192.0.2.x` address, which means no public URL was set when it was made; or the
token was already used. Tokens are single-use, so create one per device.

**A provider is missing from Settings → Providers.** Each provider must be
turned on for the environment and signed in on the server; `t3-doctor` shows
both. Right after a first start, also check the setup page: the agent may still
be installing, or its install may have failed (for example, with no network at
startup). Press **Retry** on its row, or restart the container to try again.

**Terminals don't open.** T3 Code ships a prebuilt `node-pty` next to its binary
in `/opt/t3`. If terminals fail, check `t3-doctor` and the container log before
rebuilding anything.

**Files in my repository are owned by the wrong user.** Set `PUID` and `PGID` to
the output of `id -u` and `id -g` on the host, and recreate the container.

**`EACCES: permission denied, mkdir '/home/t3/.t3/userdata'`.** A volume is
mounted at the state directory and the container couldn't take ownership of
it. The container fixes ownership of such a mount at startup, but only when it
starts as root. If your platform forces a `user:` setting, it can't, and the
log says so. Either remove that setting and choose the user with
`PUID`/`PGID`, or `chown` the host directory to that user before mounting it.

**Chromium crashes.** Give it more shared memory with `shm_size: 1gb` (the
compose file already does) and keep `--no-sandbox`, which `t3-browser-mcp`
passes.

## An agent on a gateway

Open the gateway's card under **Setup → Gateways**. It says what's wrong and
offers the fix. If a thread fails with an authentication error after a key was
replaced, send the message again: the new key applies to the next turn. See
[Gateways](gateways.md#when-something-goes-wrong).
