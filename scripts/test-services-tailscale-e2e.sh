#!/usr/bin/env bash
# Disposable real tailnet. No production container, tailnet or credential is used.
set -euo pipefail
IMAGE="${1:?Usage: scripts/test-services-tailscale-e2e.sh IMAGE}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NAME="t3-tail-e2e-$$"
SCRATCH="$(mktemp -d)"
CONTROL_IMAGE="headscale/headscale:0.29.7@sha256:11f81665e842809db9fe3006a38c56a66e968baa5abd4bac498e86445572b970"
cleanup() {
  docker rm -f "${NAME}-client" "${NAME}-peer" "${NAME}-control" >/dev/null 2>&1 || true
  docker volume rm "${NAME}-client-home" "${NAME}-client-system" "${NAME}-peer-home" "${NAME}-peer-system" "${NAME}-control" >/dev/null 2>&1 || true
  docker network rm "$NAME" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
if [ ! -c /dev/net/tun ]; then sudo modprobe tun; fi
docker network create "$NAME" >/dev/null
cat > "$SCRATCH/headscale.yaml" <<'YAML'
server_url: http://control:8080
listen_addr: 0.0.0.0:8080
metrics_listen_addr: 127.0.0.1:9090
grpc_listen_addr: 127.0.0.1:50443
noise:
  private_key_path: /var/lib/headscale/noise_private.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
derp:
  server:
    enabled: false
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  auto_update_enabled: false
database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
disable_check_updates: true
policy:
  mode: file
  path: ""
dns:
  magic_dns: true
  base_domain: fixture.tailnet.test
  override_local_dns: false
  nameservers:
    global: []
log:
  level: warn
YAML
docker run -d --name "${NAME}-control" --network "$NAME" --network-alias control --user 0:0 \
  -v "$SCRATCH/headscale.yaml:/etc/headscale/config.yaml:ro" -v "${NAME}-control:/var/lib/headscale" \
  "$CONTROL_IMAGE" serve >/dev/null
control_ready=false
for _ in $(seq 1 90); do
  if docker exec "${NAME}-control" headscale users list --output json > "$SCRATCH/users.json" 2>/dev/null; then control_ready=true; break; fi
  sleep 1
done
[ "$control_ready" = true ] || { echo 'Disposable tailnet controller did not start' >&2; exit 1; }
docker exec "${NAME}-control" headscale users create fixture --output json > "$SCRATCH/user.json"
USER_ID="$(jq -r '.id' "$SCRATCH/user.json")"
docker exec "${NAME}-control" headscale preauthkeys create --user "$USER_ID" --reusable --expiration 1h --output json > "$SCRATCH/key.json"
jq -er '.key' "$SCRATCH/key.json" > "$SCRATCH/authkey"
chmod 600 "$SCRATCH/authkey" "$SCRATCH/key.json"
start() {
  local role="$1"
  docker run -d --name "${NAME}-${role}" --network "$NAME" --network-alias "$role" \
    --cap-add NET_ADMIN --device /dev/net/tun:/dev/net/tun \
    -e T3_TAILSCALE_NETWORKING=1 -e T3_PREINSTALL=none -e T3_SETUP_KEY=tailscale-fixture-only \
    -v "${NAME}-${role}-home:/home/t3" -v "${NAME}-${role}-system:/var/lib/t3code/services" "$IMAGE" >/dev/null
  docker cp "$SCRIPT_DIR/services-tailscale-smoke.mjs" "${NAME}-${role}:/tmp/services-tailscale-smoke.mjs"
  docker cp "$SCRATCH/authkey" "${NAME}-${role}:/run/tailscale-fixture-authkey"
}
run() { local role="$1"; shift; docker exec -u 0 "${NAME}-${role}" /usr/local/bin/node /tmp/services-tailscale-smoke.mjs "$@"; }
start peer
run peer install-peer
docker exec -d -u 0 "${NAME}-peer" /usr/local/bin/node /tmp/services-tailscale-smoke.mjs peer
run peer wait-peer
docker cp "${NAME}-peer:/tmp/tailscale-fixture-peer.json" "$SCRATCH/peer.json"
docker cp "${NAME}-peer:/tmp/tailscale-fixture-peer.crt" "$SCRATCH/peer.crt"
start client
docker cp "$SCRATCH/peer.json" "${NAME}-client:/tmp/tailscale-fixture-peer.json"
docker cp "$SCRATCH/peer.crt" "${NAME}-client:/tmp/tailscale-fixture-peer.crt"
run client install-client
run client connect
run client capture
docker cp "${NAME}-client:/tmp/tailscale-fixture-client.json" "$SCRATCH/client.json"
docker cp "$SCRATCH/client.json" "${NAME}-peer:/tmp/tailscale-fixture-client.json"
docker exec -u t3 "${NAME}-client" /usr/local/bin/node /tmp/services-tailscale-smoke.mjs exercise
run client publish
run peer incoming
run client stop
docker exec -u t3 "${NAME}-client" /usr/local/bin/node /tmp/services-tailscale-smoke.mjs ordinary
docker restart "${NAME}-client" >/dev/null
run client capture
docker exec -u t3 "${NAME}-client" /usr/local/bin/node /tmp/services-tailscale-smoke.mjs exercise
run peer incoming
run client crash
run client capture
docker exec -u t3 "${NAME}-client" /usr/local/bin/node /tmp/services-tailscale-smoke.mjs exercise
docker rm -f "${NAME}-client" >/dev/null
start client
docker cp "$SCRATCH/peer.json" "${NAME}-client:/tmp/tailscale-fixture-peer.json"
docker cp "$SCRATCH/peer.crt" "${NAME}-client:/tmp/tailscale-fixture-peer.crt"
run client capture
docker exec -u t3 "${NAME}-client" /usr/local/bin/node /tmp/services-tailscale-smoke.mjs exercise
run peer incoming
run client disable
docker restart "${NAME}-client" >/dev/null
run client disabled
docker exec -u t3 "${NAME}-client" /usr/local/bin/node /tmp/services-tailscale-smoke.mjs ordinary
printf '%s\n' 'Tailscale full-networking acceptance passed: real peers, TCP/UDP/HTTP/HTTPS, MagicDNS, Docker/public DNS, explicit inbound Serve, crash/restart/recreation, persistent identity, disable cleanup.'
