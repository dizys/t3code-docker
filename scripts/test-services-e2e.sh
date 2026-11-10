#!/usr/bin/env bash
# Disposable real-image service acceptance. No live container or credential is
# used. Run for every native architecture and both image variants.
set -euo pipefail
IMAGE="${1:?Usage: scripts/test-services-e2e.sh IMAGE}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NAME="t3-services-e2e-$$"
HOME_VOLUME="${NAME}-home"
SYSTEM_VOLUME="${NAME}-system"
cleanup() {
  docker rm -f "$NAME" "${NAME}-rootless" >/dev/null 2>&1 || true
  docker volume rm "$HOME_VOLUME" "$SYSTEM_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
start() {
  docker run -d --name "$NAME" -e T3_PREINSTALL=none -e T3_SETUP_KEY=services-test-only \
    -v "$HOME_VOLUME:/home/t3" -v "$SYSTEM_VOLUME:/var/lib/t3code/services" "$@" "$IMAGE" >/dev/null
  docker cp "$SCRIPT_DIR/services-system-smoke.mjs" "$NAME:/tmp/services-system-smoke.mjs"
}
start
docker cp "$SCRIPT_DIR/services-native-smoke.mjs" "$NAME:/tmp/services-native-smoke.mjs"
docker exec -u t3 "$NAME" node /tmp/services-native-smoke.mjs
docker exec -u 0 "$NAME" node /tmp/services-system-smoke.mjs prepare
docker restart "$NAME" >/dev/null
docker exec -u 0 "$NAME" node /tmp/services-system-smoke.mjs restart
docker rm -f "$NAME" >/dev/null
start --network none -e PUID=1201 -e PGID=1202
docker exec -u 0 "$NAME" node /tmp/services-system-smoke.mjs recreate
# Rootless core gets its own home; it must not need the protected volume.
docker run -d --name "${NAME}-rootless" --user 1000:1000 -e T3_PREINSTALL=none -e T3_SETUP_KEY=services-test-only \
  --tmpfs /home/t3:uid=1000,gid=1000,mode=0700 "$IMAGE" >/dev/null
docker cp "$SCRIPT_DIR/services-system-smoke.mjs" "${NAME}-rootless:/tmp/services-system-smoke.mjs"
docker exec -u 0 "${NAME}-rootless" node /tmp/services-system-smoke.mjs rootless
