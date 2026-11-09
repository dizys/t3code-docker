#!/bin/bash
set -euo pipefail

log() { printf '[t3code] %s\n' "$*" >&2; }

if [ "${T3_SSH_ENABLED:-0}" != "1" ]; then
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  log 'ERROR: the SSH server must be started by the root entrypoint'
  exit 1
fi

: "${T3_SSH_PORT:=2222}"
: "${PUID:=1000}"

if [[ ! "$T3_SSH_PORT" =~ ^[0-9]{1,5}$ ]] ||
  [ "$((10#$T3_SSH_PORT))" -lt 1 ] || [ "$((10#$T3_SSH_PORT))" -gt 65535 ]; then
  log "ERROR: T3_SSH_PORT must be between 1 and 65535 (got '${T3_SSH_PORT}')"
  exit 1
fi

if [[ "$PUID" =~ ^0+$ ]]; then
  log 'ERROR: SSH access is disabled when PUID=0 because t3 would be root'
  exit 1
fi

HOST_KEYS_DIR=/var/lib/t3code/ssh-host-keys
AUTHORIZED_KEYS_FILE=/run/secrets/t3-ssh-authorized-keys
if [ -L "$HOST_KEYS_DIR" ]; then
  log "ERROR: SSH host-key directory must not be a symlink (${HOST_KEYS_DIR})"
  exit 1
fi
mkdir -p "$HOST_KEYS_DIR"
chown root:root "$HOST_KEYS_DIR"
chmod 0700 "$HOST_KEYS_DIR"

if [ ! -f "$AUTHORIZED_KEYS_FILE" ] || [ -L "$AUTHORIZED_KEYS_FILE" ] ||
  [ ! -s "$AUTHORIZED_KEYS_FILE" ]; then
  log "ERROR: mount a non-empty authorized_keys file at ${AUTHORIZED_KEYS_FILE}"
  exit 1
fi
keys_owner="$(stat -c '%u' "$AUTHORIZED_KEYS_FILE")"
keys_mode="$(stat -c '%a' "$AUTHORIZED_KEYS_FILE")"
if { [ "$keys_owner" != "0" ] && [ "$keys_owner" != "$PUID" ]; } ||
  (( (8#$keys_mode & 022) != 0 )); then
  log 'ERROR: authorized_keys must be owned by root or PUID and not writable by group/other'
  exit 1
fi

host_key="${HOST_KEYS_DIR}/ssh_host_ed25519_key"
for host_file in "$host_key" "${host_key}.pub" "${HOST_KEYS_DIR}/sshd_config"; do
  if [ -L "$host_file" ]; then
    log "ERROR: SSH host files must not be symlinks (${host_file})"
    exit 1
  fi
done
if [ ! -s "$host_key" ]; then
  ssh-keygen -q -t ed25519 -N '' -f "$host_key"
fi
chown root:root "$host_key" "${host_key}.pub"
chmod 0600 "$host_key"
chmod 0644 "${host_key}.pub"

config="${HOST_KEYS_DIR}/sshd_config"
umask 077
cat > "$config" <<EOF_CONFIG
Port ${T3_SSH_PORT}
AddressFamily any
ListenAddress 0.0.0.0
ListenAddress ::
HostKey ${host_key}
PidFile ${HOST_KEYS_DIR}/sshd.pid
AuthorizedKeysFile ${AUTHORIZED_KEYS_FILE}
StrictModes yes
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers t3
AllowTcpForwarding yes
GatewayPorts no
PermitTTY yes
X11Forwarding no
AllowAgentForwarding no
PermitTunnel no
UsePAM no
PrintMotd no
Subsystem sftp internal-sftp
LogLevel VERBOSE
EOF_CONFIG
chmod 0600 "$config"

install -d -m 0755 /run/sshd
sshd -t -f "$config"
sshd -E /dev/stderr -f "$config"
log "SSH server started on port ${T3_SSH_PORT} for user t3 (public-key authentication only)"
