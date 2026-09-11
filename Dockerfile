# syntax=docker/dockerfile:1

# T3 Code, packaged as a headless server.
#
# Two targets:
#   slim  - T3 Code + the agent harnesses + git/python. Enough to drive a repo.
#   full  - slim + Go/Rust/C++/Bun/Deno toolchains, ffmpeg, and a headless
#           Chromium with browser-automation MCP servers. The default.
#
# Build:  docker build --target full -t t3code:full .
# See README.md for the runtime contract.

ARG NODE_IMAGE=node:24-trixie-slim

# ---------------------------------------------------------------------------
# base - OS packages, trust anchors, the unprivileged user
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Extra trust anchors. Drop PEM/CRT files into ca-certs/ to build behind a
# TLS-intercepting proxy; the directory ships empty and this is a no-op.
COPY ca-certs/ /usr/local/share/ca-certificates/extra/

# Debian's mirrors are reached over plain HTTP by default. Some proxies only
# relay CONNECT, so allow switching the sources to HTTPS at build time.
ARG APT_HTTPS=false

RUN set -eux; \
    find /usr/local/share/ca-certificates/extra -maxdepth 1 -type f \
         \( -name '*.crt' -o -name '*.pem' \) -exec cat {} + \
         > /usr/local/share/ca-certificates/extra-bundle.pem; \
    if [ -s /usr/local/share/ca-certificates/extra-bundle.pem ]; then \
      echo 'Acquire::https::CaInfo "/usr/local/share/ca-certificates/extra-bundle.pem";' \
          > /etc/apt/apt.conf.d/99-t3code-extra-ca; \
    else \
      rm -f /usr/local/share/ca-certificates/extra-bundle.pem; \
    fi; \
    if [ "$APT_HTTPS" = "true" ]; then \
      sed -i 's|http://deb.debian.org|https://deb.debian.org|g' \
          /etc/apt/sources.list.d/debian.sources; \
    fi

RUN set -eux; \
    apt-get -o Acquire::Retries=8 update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg \
        git git-lfs openssh-client \
        build-essential python3 python3-dev python3-venv pipx \
        tini gosu \
        jq ripgrep fd-find bat sqlite3 \
        unzip zip xz-utils \
        less nano vim-tiny \
        procps psmisc htop file tzdata \
        qrencode iproute2 iputils-ping dnsutils; \
    update-ca-certificates; \
    # Re-point apt at the merged store so later stages trust both the system
    # roots and any extra anchors, whatever the supplied bundle contained.
    if [ -f /etc/apt/apt.conf.d/99-t3code-extra-ca ]; then \
      echo 'Acquire::https::CaInfo "/etc/ssl/certs/ca-certificates.crt";' \
          > /etc/apt/apt.conf.d/99-t3code-extra-ca; \
    fi; \
    ln -sf "$(command -v fdfind)" /usr/local/bin/fd; \
    ln -sf "$(command -v batcat)" /usr/local/bin/bat; \
    git lfs install --system; \
    rm -rf /var/lib/apt/lists/*

# GitHub CLI from GitHub's own apt repository rather than Debian's. Debian
# trixie ships 2.46, and T3 Code refuses to read sign-in status from anything
# older than 2.81 - "GitHub CLI is too old to report sign-in status" - which
# makes the distro package useless for the one job it has here. This is the
# install method GitHub documents, and it carries both architectures.
#
# Deliberately unpinned: the repo keeps only the current version, so a pin
# would break the build the day it moves. The floor below is what actually
# matters, and it is asserted rather than assumed.
ARG GH_MIN_VERSION=2.81.0
RUN set -eux; \
    mkdir -p -m 755 /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list; \
    apt-get -o Acquire::Retries=8 update; \
    apt-get install -y --no-install-recommends gh; \
    rm -rf /var/lib/apt/lists/*; \
    installed="$(gh --version | head -1 | awk '{print $3}')"; \
    if [ "$(printf '%s\n%s\n' "$GH_MIN_VERSION" "$installed" | sort -V | head -1)" != "$GH_MIN_VERSION" ]; then \
      echo "gh $installed is below the $GH_MIN_VERSION T3 Code requires" >&2; exit 1; \
    fi; \
    echo "gh $installed"

# Cloudflare Tunnel. T3 Code has managed-tunnel support built in and fetches
# this binary at runtime when it is missing - which needs working egress at
# exactly the moment someone is trying to get connected, and writes into the
# state volume on first use. Ship it instead, pinned to the release T3 Code
# asks for, and point T3 Code at it so it never downloads its own. It is also
# what `t3-expose` and the setup page's Ports panel use to publish a dev server.
ARG CLOUDFLARED_VERSION=2026.5.2
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) cfarch=amd64 ;; \
      arm64) cfarch=arm64 ;; \
      *) echo "no cloudflared build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${cfarch}"; \
    chmod 0755 /usr/local/bin/cloudflared; \
    cloudflared --version
ENV T3CODE_CLOUDFLARED_PATH=/usr/local/bin/cloudflared

ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# The base image ships a `node` user on uid 1000. Reclaim it for `t3` so the
# common case (host uid 1000) needs no remapping at all.
ARG T3_UID=1000
ARG T3_GID=1000
RUN set -eux; \
    userdel -r node 2>/dev/null || true; \
    groupdel node 2>/dev/null || true; \
    groupadd -g "$T3_GID" t3; \
    useradd -m -u "$T3_UID" -g "$T3_GID" -s /bin/bash t3

# Global npm installs go somewhere the unprivileged user owns, so T3 Code's
# "update provider" button and plain `npm i -g` both work at runtime.
ENV NPM_CONFIG_PREFIX=/opt/npm-global
ENV PATH=/opt/npm-global/bin:$PATH
RUN mkdir -p /opt/npm-global && chown -R t3:t3 /opt/npm-global

# ---------------------------------------------------------------------------
# slim - T3 Code and the harnesses
# ---------------------------------------------------------------------------
FROM base AS slim

# Pinned so a rebuild is reproducible; `scripts/bump-versions.sh` refreshes them
# against the registries, and CI opens a PR when one falls behind. Any of these
# also accepts `latest` as a build arg when you want the newest at build time.
ARG T3_VERSION=0.0.40
ARG CLAUDE_CODE_VERSION=2.1.268
ARG CODEX_VERSION=0.154.0
ARG OPENCODE_VERSION=1.18.30
ARG GROK_VERSION=1.0.25

# node-pty has no Linux prebuilds and compiles here; build-essential and
# python3 (installed above) are what make that work.
RUN set -eux; \
    npm install -g --no-audit --no-fund \
        "t3@${T3_VERSION}" \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "@openai/codex@${CODEX_VERSION}" \
        "opencode-ai@${OPENCODE_VERSION}" \
        "@xai-official/grok@${GROK_VERSION}"; \
    npm cache clean --force; \
    # Source maps and other platforms' prebuilt binaries are dead weight here
    # (~140 MB); the harnesses only ever load the Linux ones.
    find /opt/npm-global -type f -name '*.map' -delete; \
    find /opt/npm-global -type d \( -name 'win32-*' -o -name 'darwin-*' \) \
         -prune -exec rm -rf {} +; \
    chown -R t3:t3 /opt/npm-global

# Cursor ships no npm package; its installer writes into $HOME/.local/bin, so
# give it a home of its own rather than letting it land in /root.
ARG INSTALL_CURSOR=true
ENV CURSOR_HOME=/opt/cursor
ENV PATH=/opt/cursor/.local/bin:$PATH
# Downloaded to a file rather than piped: `curl ... | bash` reports bash's exit
# status, so a failed download installs nothing and still succeeds. The test at
# the end is the real guard - every other toolchain here proves itself by
# running --version, and this one silently did not.
RUN set -eux; \
    if [ "$INSTALL_CURSOR" = "true" ]; then \
      mkdir -p "$CURSOR_HOME"; \
      curl -fsSL https://cursor.com/install -o /tmp/cursor-install.sh; \
      HOME="$CURSOR_HOME" bash /tmp/cursor-install.sh; \
      rm -f /tmp/cursor-install.sh; \
      test -x "$CURSOR_HOME/.local/bin/cursor-agent"; \
      chown -R t3:t3 "$CURSOR_HOME"; \
    fi

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/bin/ /usr/local/bin/
COPY docker/setup/ /opt/t3-setup/
COPY examples/ /opt/examples/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/t3-*

ENV T3CODE_HOME=/home/t3/.t3 \
    T3CODE_HOST=0.0.0.0 \
    T3CODE_PORT=3773 \
    T3_WORKSPACE=/workspace \
    T3_AUTO_ADD_PROJECTS=1 \
    T3_PRINT_PAIRING_ON_START=0 \
    T3_SETUP_ENABLED=1 \
    T3_SETUP_PORT=3774 \
    T3_SETUP_BASE_PATH= \
    PUID=1000 \
    PGID=1000

RUN mkdir -p /workspace /home/t3/.t3 && chown -R t3:t3 /workspace /home/t3

VOLUME ["/home/t3", "/workspace"]
WORKDIR /workspace
EXPOSE 3773 3774

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD curl -fsS --max-time 4 "http://127.0.0.1:${T3CODE_PORT}/.well-known/t3/environment" >/dev/null || exit 1

# Stamped last so a version change reuses every layer above it. IMAGE_VERSION is
# the release tag in CI and "dev" for a local build; the setup page shows both so
# you can tell at a glance which image is actually running.
ARG IMAGE_VERSION=dev
ARG IMAGE_VARIANT=slim
ENV T3_IMAGE_VERSION=${IMAGE_VERSION} \
    T3_IMAGE_VARIANT=${IMAGE_VARIANT}
LABEL org.opencontainers.image.version="${IMAGE_VERSION}"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["t3-serve"]

# ---------------------------------------------------------------------------
# full - language toolchains, media tools, and a headless browser
# ---------------------------------------------------------------------------
FROM slim AS full

USER root

RUN set -eux; \
    apt-get -o Acquire::Retries=8 update; \
    apt-get install -y --no-install-recommends \
        clang lld cmake pkg-config gdb \
        ffmpeg imagemagick \
        postgresql-client redis-tools \
        chromium \
        fonts-liberation fonts-dejavu-core fonts-noto-core \
        fonts-noto-color-emoji fonts-noto-cjk; \
    rm -rf /var/lib/apt/lists/*

# Go - Debian's golang-go trails upstream, so take the official tarball.
ARG GO_VERSION=1.27.1
ENV GOROOT=/usr/local/go
ENV GOPATH=/home/t3/go
ENV PATH=/usr/local/go/bin:/home/t3/go/bin:$PATH
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) goarch=amd64 ;; \
      arm64) goarch=arm64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${goarch}.tar.gz" -o /tmp/go.tgz; \
    tar -C /usr/local -xzf /tmp/go.tgz; \
    rm /tmp/go.tgz; \
    go version

# Rust
ARG RUST_VERSION=stable
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:$PATH
RUN set -eux; \
    curl -fsSL https://sh.rustup.rs | \
      sh -s -- -y --no-modify-path --profile minimal \
        --default-toolchain "$RUST_VERSION" \
        --component clippy --component rustfmt; \
    chmod -R a+w "$RUSTUP_HOME" "$CARGO_HOME"; \
    rustc --version

# Bun and Deno
ENV BUN_INSTALL=/usr/local/bun
ENV DENO_INSTALL=/usr/local/deno
ENV PATH=/usr/local/bun/bin:/usr/local/deno/bin:$PATH
RUN set -eux; \
    curl -fsSL https://bun.sh/install | bash; \
    curl -fsSL https://deno.land/install.sh | sh -s -- --yes; \
    bun --version; \
    deno --version

# uv, for Python projects that expect it
RUN set -eux; \
    curl -fsSL https://astral.sh/uv/install.sh | \
      env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh; \
    uv --version

# Browser automation over MCP. T3 Code's own preview tools are hosted by the
# web/desktop client, so a phone-only setup has no eyes without this.
ARG CHROME_DEVTOOLS_MCP_VERSION=1.9.0
ARG PLAYWRIGHT_MCP_VERSION=0.0.80
ENV CHROME_PATH=/usr/bin/chromium \
    CHROME_BIN=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
RUN set -eux; \
    npm install -g --no-audit --no-fund \
        "chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}" \
        "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}"; \
    npm cache clean --force; \
    chown -R t3:t3 /opt/npm-global

RUN mkdir -p /home/t3/go && chown -R t3:t3 /home/t3

# Stamped last so a version change reuses every layer above it. IMAGE_VERSION is
# the release tag in CI and "dev" for a local build; the setup page shows both so
# you can tell at a glance which image is actually running.
ARG IMAGE_VERSION=dev
ARG IMAGE_VARIANT=full
ENV T3_IMAGE_VERSION=${IMAGE_VERSION} \
    T3_IMAGE_VARIANT=${IMAGE_VARIANT}
LABEL org.opencontainers.image.version="${IMAGE_VERSION}"
