#!/usr/bin/env bash
# Container entrypoint: normalise ownership, drop privileges, start T3 Code.
set -euo pipefail

log() { printf '[t3code] %s\n' "$*" >&2; }

T3_USER=t3
T3_HOME=/home/t3

: "${PUID:=1000}"
: "${PGID:=1000}"
: "${T3CODE_HOME:=${T3_HOME}/.t3}"
: "${T3CODE_HOST:=0.0.0.0}"
: "${T3CODE_PORT:=3773}"
: "${T3_WORKSPACE:=/workspace}"
: "${T3_AUTO_ADD_PROJECTS:=1}"
: "${T3_PRINT_PAIRING_ON_START:=0}"
: "${T3_ALLOW_SUDO:=0}"
export T3CODE_HOME T3CODE_HOST T3CODE_PORT T3_WORKSPACE

# --- privileged half: fix uids, then re-exec as the unprivileged user --------
if [ "$(id -u)" -eq 0 ]; then
  current_uid="$(id -u "$T3_USER")"
  current_gid="$(id -g "$T3_USER")"
  remapped=0

  if [ "$PGID" != "$current_gid" ]; then
    log "remapping group ${T3_USER}: ${current_gid} -> ${PGID}"
    groupmod -o -g "$PGID" "$T3_USER"
    remapped=1
  fi
  if [ "$PUID" != "$current_uid" ]; then
    log "remapping user ${T3_USER}: ${current_uid} -> ${PUID}"
    usermod -o -u "$PUID" "$T3_USER"
    remapped=1
  fi

  mkdir -p "$T3CODE_HOME" "$T3_WORKSPACE"

  # A freshly created named volume comes up root-owned; so does ~ after a
  # remap. Re-owning the home is cheap relative to how confusing a
  # permission-denied SQLite open is.
  if [ "$remapped" -eq 1 ] || [ "$(stat -c %u "$T3_HOME")" != "$PUID" ]; then
    log "taking ownership of ${T3_HOME}"
    chown -R "$PUID:$PGID" "$T3_HOME"
  fi

  # /workspace is the user's own tree. Only adopt it when it is empty or
  # already root-owned; never rewrite ownership across somebody's repos.
  if [ "$(stat -c %u "$T3_WORKSPACE")" = "0" ]; then
    chown "$PUID:$PGID" "$T3_WORKSPACE"
  fi
  if ! gosu "$T3_USER" test -w "$T3_WORKSPACE"; then
    log "WARNING: ${T3_WORKSPACE} is not writable by uid ${PUID}."
    log "         Set PUID/PGID to match the owner of your bind mount."
  fi

  if [ "$T3_ALLOW_SUDO" = "1" ]; then
    if command -v sudo >/dev/null 2>&1; then
      printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$T3_USER" > /etc/sudoers.d/t3code
      chmod 0440 /etc/sudoers.d/t3code
      log "passwordless sudo enabled for ${T3_USER} (T3_ALLOW_SUDO=1)"
    else
      log "T3_ALLOW_SUDO=1 but sudo is not installed in this image"
    fi
  else
    rm -f /etc/sudoers.d/t3code
  fi

  exec gosu "$T3_USER" "$0" "$@"
fi

# --- unprivileged half -------------------------------------------------------
mkdir -p "$T3CODE_HOME"

if [ "${1:-}" != "t3-serve" ]; then
  exec "$@"
fi
shift || true

register_projects() {
  [ "$T3_AUTO_ADD_PROJECTS" = "1" ] || return 0
  [ -d "$T3_WORKSPACE" ] || return 0

  local dir
  if [ -e "${T3_WORKSPACE}/.git" ]; then
    t3 project add "$T3_WORKSPACE" >/dev/null 2>&1 \
      && log "registered project ${T3_WORKSPACE}" || true
    return 0
  fi

  for dir in "$T3_WORKSPACE"/*/; do
    [ -d "$dir" ] || continue
    [ -e "${dir}.git" ] || continue
    dir="${dir%/}"
    t3 project add "$dir" >/dev/null 2>&1 \
      && log "registered project ${dir}" || true
  done
}

register_projects

if [ "$T3_PRINT_PAIRING_ON_START" = "1" ]; then
  # The server has to be up before a token is worth anything; mint it just
  # after the listener opens.
  (
    for _ in $(seq 1 60); do
      if curl -fsS "http://127.0.0.1:${T3CODE_PORT}/.well-known/t3/environment" \
           >/dev/null 2>&1; then
        t3-pair || log "could not mint a startup pairing link"
        exit 0
      fi
      sleep 2
    done
    log "server did not become healthy in time; skipping startup pairing link"
  ) &
fi

log "starting T3 Code ${T3CODE_HOST}:${T3CODE_PORT} (state: ${T3CODE_HOME})"
if [ -n "${T3_PUBLIC_URL:-}" ]; then
  log "public URL: ${T3_PUBLIC_URL} - pair a device with: t3-pair"
else
  log "T3_PUBLIC_URL is unset; run 't3-pair --base-url https://your.host' to pair"
fi

exec t3 serve \
  --host "$T3CODE_HOST" \
  --port "$T3CODE_PORT" \
  "$@" \
  "$T3_WORKSPACE"
