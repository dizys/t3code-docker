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
: "${T3_SETUP_ENABLED:=1}"
: "${T3_SETUP_PORT:=3774}"
export T3CODE_HOME T3CODE_HOST T3CODE_PORT T3_WORKSPACE T3_SETUP_PORT

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

  # A freshly created volume comes up root-owned; so does ~ after a remap.
  # Test each directory the server writes rather than inferring from the home
  # directory's uid: a volume mounted directly at the state dir arrives
  # root-owned while its parent still looks perfectly correct, and the server
  # then dies on `mkdir userdata` with nothing but an EACCES stack trace.
  for dir in "$T3_HOME" "$T3CODE_HOME"; do
    mkdir -p "$dir"
    if [ "$remapped" -eq 1 ] || ! gosu "$T3_USER" test -w "$dir"; then
      log "taking ownership of ${dir}"
      chown -R "$PUID:$PGID" "$dir"
    fi
  done

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
# Reached either by the step-down above, or directly because the container was
# started with a `user:` setting. In the latter case nothing can fix ownership,
# so say what is wrong instead of letting the server fail on its first write.
if ! mkdir -p "$T3CODE_HOME" 2>/dev/null || [ ! -w "$T3CODE_HOME" ]; then
  log "ERROR: ${T3CODE_HOME} is not writable by uid $(id -u):$(id -g)."
  log "       A volume is probably mounted there owned by another user."
  log "       Fix it either way:"
  log "         - let the container start as root so it can adopt the volume"
  log "           itself, and select the user with PUID/PGID; or"
  log "         - chown the host directory to uid ${PUID} before mounting it."
  exit 1
fi

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

# The setup service exists for one job: minting a pairing link on demand,
# without a shell in the container and without a restart. Everything after
# pairing belongs to T3 Code's own UI, which does it better.
start_setup_service() {
  [ "$T3_SETUP_ENABLED" = "1" ] || return 0
  [ -f /opt/t3-setup/server.mjs ] || return 0

  if [ -z "${T3_SETUP_KEY:-}" ]; then
    T3_SETUP_KEY="$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
    log "T3_SETUP_KEY was not set; generated one for this container:"
    log "    ${T3_SETUP_KEY}"
    log "    Set T3_SETUP_KEY yourself to keep it stable across recreates."
  fi
  export T3_SETUP_KEY

  (
    while :; do
      node /opt/t3-setup/server.mjs || log "setup service exited; restarting in 5s"
      sleep 5
    done
  ) &

  log "setup UI on port ${T3_SETUP_PORT} - publish it to pair a device from a browser"
}

start_setup_service

if [ "$T3_PRINT_PAIRING_ON_START" = "1" ]; then
  # The server has to be up before a token is worth anything; mint it just
  # after the listener opens.
  (
    for _ in $(seq 1 60); do
      # --max-time is load-bearing: the server accepts connections before it
      # answers, so a probe fired during startup hangs indefinitely and this
      # loop never reaches a second iteration.
      if curl -fsS --max-time 3 \
           "http://127.0.0.1:${T3CODE_PORT}/.well-known/t3/environment" \
           >/dev/null 2>&1; then
        log "pairing link for this environment (use this one, not the banner):"
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
# The server's own banner follows, advertising its bridge address and a token
# that lives five minutes. Both are useless from outside the container.
log "note: the token in the server banner below expires in 5 minutes and is"
log "      addressed to this container - use t3-pair for a link that lasts"

exec t3 serve \
  --host "$T3CODE_HOST" \
  --port "$T3CODE_PORT" \
  "$@" \
  "$T3_WORKSPACE"
