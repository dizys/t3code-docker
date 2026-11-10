# Services

**Setup → Services** manages optional background services and commands you
install yourself. **Access → SSH** and **Access → Connections** use the same
service registrations and operations. Nothing is installed or enabled simply
by opening these pages.

SSH, Tailscale and Cloudflare Tunnel payloads download only when you apply an
installation review. The image contains their exact architecture, source,
version and SHA-256 metadata, plus the small supervision infrastructure. It
continues to include the outbound SSH client used by Git and Vault.

## Storage and process ownership

The supplied Compose file mounts `t3-services:/var/lib/t3code/services`. This
root-owned volume holds verified system payloads, retained versions, SSH host
keys, tailnet state and system operation records. System services require this
mount and the normal root entrypoint. Do not share it between live containers.
Keep it with the home volume when recreating or restoring the container.

Custom registrations, operations and logs live under
`$T3CODE_HOME/setup/services/user`. Their tools remain in mise's normal home
storage. A named home volume or explicit bind mount preserves both. An anonymous
volume needs to be explicitly reattached when recreating the container. With
only `.t3` persisted, custom application files and tool installations elsewhere
in the home need their own persistent mounts.

User supervision writes launchers under `$T3_RUN_DIR`, which defaults to
`$T3CODE_HOME/run`. This directory must be writable by the container user and
allow execution. Docker tmpfs mounts default to `noexec`. If your home or state
storage uses `noexec`, set `T3_RUN_DIR` to a separate user-owned runtime mount
with `exec,nosuid,nodev`. Installed mise executables also need storage that
allows execution.

Tini remains PID 1. Independent s6 supervision domains manage system services
and user services. Custom commands start only after the worker drops its UID,
GID, supplementary groups, capabilities and ability to gain privileges through
setuid executables. They run as the container's user and share its filesystem
permissions, network and resource limits. They are not isolated from other
applications using that account. Their environment starts from a small explicit
base, without Setup keys or unrelated provider credentials.

## Set up SSH

1. Open **Access → SSH → Set up SSH**.
2. Paste one public key per line. Private keys and `authorized_keys` command
   options are rejected. Ed25519, ECDSA and RSA keys of at least 2048 bits are
   supported. Your existing Vault SSH credentials are for outbound connections;
   they do not authorize incoming login.
3. Choose the listener. **Container loopback** suits a managed connector inside
   this container. **Container interfaces** is required for Docker host port
   mappings and sidecars in another network namespace.
4. Review the download, port, authorized-key count and retained identity.
5. Add a connection and route, then test from your client. Compare the displayed
   host fingerprint before accepting it. Copy the SSH command or editor config
   from that route.

OpenSSH accepts public keys for `t3` only. Root, password, keyboard-interactive,
agent forwarding, X11 and tunnel-device access are disabled. TCP forwarding is
enabled for editor connections. Local readiness verifies the SSH listener. A
reported client test is explicitly labeled as user-reported evidence.

For an existing LAN or VPN, add an **Existing LAN, VPN or network** connection.
Publish the chosen port through your deployment, separately. For example, add
this entry to the `t3code` service's existing `ports` section and recreate it:

```yaml
ports:
  - "127.0.0.1:2222:2222"
```

This mapping is reachable only from the Docker host. Use the appropriate
private interface when reaching it over a trusted network, with matching
firewall rules. Select **Container interfaces** in SSH. Keep your existing
home and services volume mounts during recreation.

## Connections and tunnels

Connections identify who owns the network path. Host Tailscale, a Cloudflare
sidecar and an existing VPN remain externally managed. Registering one does
not adopt its process or change its configuration.

The managed Tailscale connector uses userspace networking without `/dev/net/tun`
or extra network capabilities. Install and enable it in Services, choose
**Start sign-in**, and authorize the device in Tailscale. Add a connection owned
by **Tailscale managed in Services**, then add a **Tailnet TCP route** for a
declared service endpoint. Applying that route explicitly configures TCP Serve
forwarding to container loopback. Tailnet policy still controls client access;
the SSH server separately checks the client's public key. Sign out invalidates
the route's previous client-test evidence. Route changes use durable operations
and reuse the same operation when a response is lost.

A managed Cloudflare connector uses a named tunnel token held in protected
system storage. Its hostname, `ssh://` origin and Access policy are configured
with Cloudflare. A Cloudflare SSH route provides the required client-side
`cloudflared access ssh` command. Clients need cloudflared and must complete
the Access policy. Keep that provider configuration aligned with the registered
route. The console does not claim to have applied provider policy.

T3 Connect and Ports' HTTP quick tunnels keep their existing owners and
lifecycle. They use an on-demand verified cloudflared adapter and do not carry
raw SSH. The adapter's version probe does not download anything. The first real
tunnel needs network access; subsequent uses verify and reuse its cached
payload. Managed named tunnels and native quick tunnels have separate identities
and process ownership.

For a migration, add and test the replacement route before removing the old
one. Removing one route does not stop a shared connector. Managed tailnet route
removal also removes its recorded TCP forwarding. A connector or service with
registered routes cannot be uninstalled until those dependencies are removed.

## Add a custom service

Choose **Add service → Custom service**. Use a foreground command in one of
three modes:

- **Executable**: an absolute executable path and one literal argument per
  field. Empty arguments, spaces, quotes and shell characters stay literal.
- **Installed mise tool**: select exact installed versions and a binary they
  provide. Install missing versions in Toolchains, then resume the saved draft.
  Service resolution ignores project/home mise configuration and hooks, and
  never silently installs a missing version or changes to `latest`.
- **Shell script**: explicitly choose a shell and enter its code. Shell
  expansion and pipelines apply in this mode.

Choose the working directory, startup behavior, restart policy and optional
local HTTP or TCP health check. Process-only health reports **Running**. An
HTTP/TCP check can establish **Locally ready**, which still does not establish
external reachability. Checks use a declared loopback endpoint, a bounded
timeout and no redirects.

Advanced settings provide environment rows, saved Vault Token references,
declared endpoints and shutdown grace. Secret values stay in Vault and are
resolved only for the child. Tools and credentials remain dependencies even
when a registration is disabled. Remove or edit the registration before
removing one of its pinned versions or Vault entries. A changed executable or
credential requires a fresh configuration review before the service restarts.

The Python preview recipe demonstrates a custom HTTP service. Serve a selected
folder on loopback, then use Ports or a deliberately configured connection to
make it reachable. Declaring an endpoint alone never publishes it.

## Lifecycle, recovery and diagnostics

| Action | Result |
| --- | --- |
| Stop for now | Stops the owned process tree and pauses restarts for this container run. An enabled service resumes on the next container start. |
| Disable at startup | Stops it and persists the off state across restarts. Configuration, verified artifacts and identity remain. |
| Restart | Starts a reviewed run with the same pinned configuration. |
| Remove registration | Removes a custom registration and its console logs. Installed tools, application files and Vault entries remain. |
| Uninstall service | Removes the system service's active payload reference and stops it. Verified cached artifacts, configuration and identity remain for recovery. |
| Sign out connector | Requests provider logout separately from stopping the daemon. Existing routes lose access until sign-in completes. |

Reviews expire after five minutes. Applying one commits an operation ID before
side effects begin. Closing the console does not cancel it. A lost submission
response keeps its operation key so **Check submission** reattaches to the same
work. Refresh the existing operation before creating another review.

Failed edits attempt to restore and check the previous configuration. A receipt
says whether recovery actually passed. Application data changes cannot be
rolled back with configuration. Keep another working access path when changing
an SSH listener or connector that you depend on.

Restarts back off and allow at most five retries within five minutes. Disable or
Stop for now overrides a queued restart. Supervision stops and collects the
owned process tree before a replacement starts. Set the container's stop grace
to at least 45 seconds when using the maximum 30-second service grace; the
supplied Compose file does this.

The inspector offers separate stdout/stderr, search, pause and bounded history.
Each stream retains at most two 256 KiB files. Cursor gaps are explicit. Known
Vault values and managed connector tokens are redacted before lines are
buffered or written. Arbitrary applications can print other sensitive data;
review output before sharing it.

The first implementation supports one managed instance per catalogue service.
It does not expose arbitrary root formulas, kernel Tailscale mode, cgroup hard
limits, encrypted identity export, or provider-policy editing. Rootless
containers can use custom services; system installs need the root entrypoint
and protected volume. Existing T3 runtime versions and Stable/Nightly selections
are independent of service operations.
