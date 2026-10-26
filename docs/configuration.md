# Configuration

Environment variables (all optional except where noted):

| Variable | Default | Meaning |
| --- | --- | --- |
| `T3_PUBLIC_URL` | — | The address pairing links point at. Optional: without it, the one saved on the setup page or the hosting platform's is used. Setting it here fixes it. See [The public URL](remote-access.md#the-public-url). |
| `T3CODE_PORT` | `3773` | Server port inside the container |
| `T3CODE_HOST` | `0.0.0.0` | Bind interface inside the container |
| `T3CODE_HOME` | `/home/t3/.t3` | State directory (`userdata/state.sqlite`) |
| `T3_WORKSPACE` | `/workspace` | Absolute workspace directory, scanned for projects and used for New project, browsing and repository cloning defaults |
| `T3CODE_PROJECTS_DIR` | `T3_WORKSPACE` | Override the native New project directory independently of the workspace |
| `T3_AUTO_ADD_PROJECTS` | `1` | Register each git checkout under the workspace |
| `T3_PRINT_PAIRING_ON_START` | `0` | Create a pairing link at startup and print it to the log |
| `T3_PREINSTALL` | `default` | What the first start installs onto the volume: `default` (Claude Code, Codex, OpenCode and the toolchains), `all` (every agent and toolchain), `agents`, `toolchains`, `source-control` (glab, fj, tea, az), ids like `claude,go,glab`, or `none`. They combine (`default,source-control`); one on its own replaces the default |
| `T3_PAIR_TTL` | `30d` | How long links from `t3-pair` can be used |
| `T3_SETUP_ENABLED` | `1` | Run the setup page |
| `T3_SETUP_KEY` | *(generated)* | Password for the setup page. Without it, the first start generates one and keeps it on the volume, and the setup page can show and replace it. |
| `T3_SETUP_PORT` | `3774` | Setup page port inside the container |
| `T3_SETUP_BASE_PATH` | — | Serve the setup page under a path, such as `/__setup` |
| `T3_SINGLE_PORT` | — | Also serve T3 Code and the setup page together on this port, the setup page under `/__setup`, for a tunnel, proxy or hosting platform that routes one port. See [Exposing it through one hostname](remote-access.md#exposing-it-through-one-hostname). |
| `T3_SETUP_ACCEPT_T3_SESSIONS` | `1` | Let a browser signed in to T3 Code with terminal access open the setup page without the key. `0` always asks for the key. |
| `T3_ALLOW_SUDO` | `0` | Give agents passwordless sudo in the container |
| `DEEPSEEK_API_KEY` | — | Used by the DeepSeek-through-OpenCode example |
| `PUID` / `PGID` | `1000` | Owner of files in the workspace bind mount |

Volumes:

- `/home/t3`: state, agent credentials, installed agents and toolchains, and
  shell history. Back this up.
- `/workspace`: your repositories.

The first start seeds T3's native project-folder preference from `T3_WORKSPACE`.
A folder you already chose in T3 is kept. Later changes, including clearing the
preference, are kept across restarts. Changing `T3_WORKSPACE` updates the default
only while it is still managed by the image. Explicit clone destinations always
take precedence.

**New project** creates repositories directly in `T3_WORKSPACE`, unless
`T3CODE_PROJECTS_DIR` is explicitly set. Existing projects keep their paths;
T3 state, credentials and scratch folders continue to use `T3CODE_HOME`.

The image maintains its own small T3 source patch for this behavior. Stable and
Nightly updates use verified builds of that patch. An existing selected upstream
runtime remains usable after an image upgrade; **Setup → Updates** offers the
integration update, including when its native version stays the same. See
[T3 Code updates](t3code-updates.md).

Installed agents and toolchains live under `/home/t3/.local/share/mise`, so they
persist when the whole home directory is mounted. With only the state directory
mounted (`/home/t3/.t3`), credentials and threads persist, and the next start
reinstalls the tools.

Agent CLIs normally store their sign-ins in `~/.claude`, `~/.codex`,
`~/.cursor`, `~/.grok`, OpenCode's XDG directories, Muse's `~/.config/muse`
and `~/.local/share/muse`, and the source control
CLIs in `~/.config/gh`, `~/.config/glab-cli`, `~/.config/tea`,
`~/.local/share/forgejo-cli` and `~/.azure`, and git its settings in
`~/.gitconfig` (who you commit as, and the credential helpers `gh` and `tea`
set up), which only persist when the whole home directory is mounted. The
container keeps them under `$T3CODE_HOME/agents` instead and links them back,
so a sign-in survives even when only the state directory is mounted. A directory you mount yourself, such
as the host's `~/.config/gh` to share its gh sign-in, is left where it is. Set
`T3_PERSIST_AGENT_CREDENTIALS=0` to leave them all where the CLIs put them.

**Watch out for anonymous volumes.** Because the image declares `VOLUME`,
running without `-v` still creates a volume, and it looks persistent from
inside. But recreating the container creates a new, empty one, and every
sign-in, thread and project stays behind in the old one. The container detects
this at startup and warns you:

```
[t3code] WARNING: /home/t3 is an anonymous volume. It survives a restart, but
[t3code]          recreating this container creates a new one and every agent
[t3code]          sign-in, thread and project is lost.
```

With a named volume or a host directory, the log says what it found instead.
The setup page says so too: **Server** marks the folder and lists the commands
below with the volume's own name filled in.

### Moving an anonymous volume to a named one

Copy it into a named volume while the container is stopped, then recreate the
container with that volume mounted. Nothing is lost, and the old volume stays
where it is until you remove it.

```bash
# 1. The anonymous volume behind /home/t3 (a 64-character hash)
docker inspect t3code --format '{{range .Mounts}}{{if eq .Destination "/home/t3"}}{{.Name}}{{end}}{{end}}'

# 2. Stop the container, and copy that volume into a new named one
docker stop t3code
docker volume create t3-home
docker run --rm --entrypoint sh -v <hash>:/from -v t3-home:/to \
  dizys/t3code-docker -c 'cp -a /from/. /to/'
```

3. Recreate the container with `-v t3-home:/home/t3`, or in Compose,
   `- t3-home:/home/t3` under `volumes:` with `t3-home:` declared at the end of
   the file, as in the [Compose example](../README.md#with-docker-compose).
4. Once the setup page shows **Home** as durable, remove the old volume with
   `docker volume rm <hash>`.

The copy runs in the image you already have, so it pulls nothing, and `cp -a`
keeps every file's owner and permissions. A state directory mounted on a volume
of its own (`/home/t3/.t3`) is not part of the copy; keep mounting it as before.

Helper commands in the container: `t3-pair`, `t3-login`, `t3-doctor`, `t3-storage`,
`t3-harness`, `t3-expose` and `t3-browser-mcp`. They all switch from root to the
`t3` user on their own, so plain `docker compose exec` is safe.

## Building

```bash
scripts/build.sh                                 # t3code:browser
scripts/build.sh --target core
scripts/build.sh --platform linux/amd64,linux/arm64 --push --tag ghcr.io/you/t3code
scripts/smoke-test.sh t3code:browser             # starts it and checks that it works
```

`--variant` tells the test scripts which image they are testing. It is never
guessed from whether Chromium is present, so a digest reference needs it
(`--variant core t3code@sha256:…`).

Behind a TLS-intercepting proxy, put the CA certificate (PEM) in `ca-certs/` and
build with `--build-arg APT_HTTPS=true`.

Releases are mirrored from GHCR to Docker Hub at `dizys/t3code-docker`. See
[Docker Hub publishing](dockerhub-publishing.md) for account setup, verified
release copying, and retries without rebuilding.

## Moving off `full` and `slim`

New releases are published only as `latest`/`browser` and `core`. The `full`
and `slim` tags, their versioned forms such as `0.18.0-full`, and the `full`
and `slim` build targets are retired. Tags already published under those names
still pull the release they were pushed with, but they no longer move.

| Was | Use |
| --- | --- |
| `:full`, `:X.Y.Z-full` | `:latest` (or `:browser`), `:X.Y.Z` |
| `:slim`, `:X.Y.Z-slim` | `:core`, `:X.Y.Z-core` |
| `T3_BUILD_TARGET=full` | `T3_BUILD_TARGET=browser` |
| `T3_BUILD_TARGET=slim` | `T3_BUILD_TARGET=core` |

Change the image tag, then `docker compose pull && docker compose up -d`. Keep
the same volumes: state, sign-ins, threads and projects carry over.

Images up to v0.4 had the agents and runtimes built in. Coming from one of
those, the first start of a current image installs the default agents and
toolchains onto your volume in the background; install Grok, Cursor or Muse
from the Agents page, or set `T3_PREINSTALL=all`. Once the install finishes
the agents are signed in again. The `v0.4.x` tags still have the old images if
you need to roll back.
