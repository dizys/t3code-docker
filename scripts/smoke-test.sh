#!/usr/bin/env bash
# Boot the image and assert the things a user would notice if they broke.
#
#   scripts/smoke-test.sh [image]      (default: t3code:full)
set -euo pipefail

IMAGE="${1:-t3code:full}"
NAME="t3code-smoke-$$"
PORT="${SMOKE_PORT:-13773}"
PUBLIC_URL="https://smoke.example.test"
SETUP_KEY="smoke-setup-key"

pass=0
fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
no()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else no "$1"; fi; }

STATE_MOUNT=""
cleanup() {
  docker rm -f "$NAME" "${NAME}-mount" "${NAME}-boot" >/dev/null 2>&1 || true
  if [ -n "$STATE_MOUNT" ]; then
    sudo rm -rf "$STATE_MOUNT" 2>/dev/null || rm -rf "$STATE_MOUNT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

printf '\nSmoke-testing %s\n\n' "$IMAGE"

docker run -d --name "$NAME" \
  -p "127.0.0.1:${PORT}:3773" \
  -e "T3_PUBLIC_URL=${PUBLIC_URL}" \
  -e "T3_SETUP_KEY=${SETUP_KEY}" \
  "$IMAGE" >/dev/null

printf 'Waiting for the server to answer...\n'
health_url="http://127.0.0.1:${PORT}/.well-known/t3/environment"
for i in $(seq 1 60); do
  if curl -fsS --noproxy '*' --max-time 5 "$health_url" >/dev/null 2>&1; then break; fi
  if [ "$i" = 60 ]; then
    no "server never became healthy"
    docker logs "$NAME" 2>&1 | tail -30
    exit 1
  fi
  sleep 2
done

printf '\nServer\n'
version="$(curl -fsS --noproxy '*' "$health_url" | jq -r .serverVersion)"
[ -n "$version" ] && ok "health endpoint (serverVersion=$version)" || no "health endpoint"
# The healthcheck has a start period, so the first probe lands after the
# server is already answering. Give it room rather than racing it.
health_status=""
for _ in $(seq 1 60); do
  health_status="$(docker inspect --format '{{.State.Health.Status}}' "$NAME" 2>/dev/null || true)"
  [ "$health_status" = healthy ] && break
  [ "$health_status" = unhealthy ] && break
  sleep 5
done
[ "$health_status" = healthy ] \
  && ok "docker healthcheck reports healthy" \
  || no "docker healthcheck reports $health_status"

printf '\nHarnesses\n'
for bin in t3 claude codex opencode grok cursor-agent; do
  check "$bin runs" "docker exec $NAME $bin --version"
done

printf '\nPairing\n'
pair_out="$(docker exec "$NAME" t3-pair --no-qr 2>/dev/null || true)"
case "$pair_out" in
  *"Pairing URL: ${PUBLIC_URL}/pair#token="*)
    ok "t3-pair uses the public URL" ;;
  *) no "t3-pair did not produce a public pairing URL"
     printf '%s\n' "$pair_out" ;;
esac
check "minted token is registered server-side" \
  "docker exec $NAME t3 auth pairing list --json 2>/dev/null | grep -q orchestration:operate"

have() { docker exec "$NAME" sh -c "command -v $1" >/dev/null 2>&1; }

printf '\nRuntimes\n'
for bin in node python3 git gh; do
  check "$bin present" "have $bin"
done

if have chromium; then
  printf '\nToolchains and browser (full image)\n'
  for bin in go rustc cargo bun deno uv ffmpeg cmake clang; do
    check "$bin present" "have $bin"
  done

  # about:blank would pass even with a broken renderer; render real markup and
  # look for it in the DOM, then prove the raster path produces a real image.
  docker exec "$NAME" sh -c \
    'printf "<h1 id=marker>t3code-smoke-ok</h1>" > /tmp/smoke.html'
  check "chromium renders a page" \
    "docker exec $NAME sh -c 'chromium --headless --no-sandbox --disable-gpu \
       --dump-dom file:///tmp/smoke.html 2>/dev/null | grep -q t3code-smoke-ok'"
  check "chromium screenshots a page" \
    "docker exec $NAME sh -c 'chromium --headless --no-sandbox --disable-gpu \
       --window-size=800,600 --screenshot=/tmp/smoke.png file:///tmp/smoke.html \
       >/dev/null 2>&1 && [ \"\$(stat -c %s /tmp/smoke.png)\" -gt 1000 ]'"

  check "playwright-mcp present" "have playwright-mcp"
  check "chrome-devtools-mcp present" "have chrome-devtools-mcp"

  # "installed" and "an agent can see a page" are different claims.
  docker cp "$(dirname "$0")/browser-probe.py" "$NAME:/tmp/browser-probe.py" >/dev/null
  check "browser MCP drives a real page (playwright)" \
    "docker exec -u t3 $NAME python3 /tmp/browser-probe.py"
  check "browser MCP drives a real page (chrome-devtools)" \
    "docker exec -u t3 $NAME python3 /tmp/browser-probe.py \
       \$(docker exec $NAME t3-browser-mcp --server chrome-devtools --print)"
  check "t3-browser-mcp registers with opencode" \
    "docker exec $NAME t3-browser-mcp --harness opencode"
  check "opencode config records the mcp server" \
    "docker exec -u t3 $NAME jq -e '.mcp.playwright.enabled' /home/t3/.config/opencode/opencode.json"
fi

printf '\nOwnership\n'
check "state dir is owned by the t3 user" \
  "[ \"\$(docker exec $NAME stat -c %U /home/t3/.t3)\" = t3 ]"
check "root exec does not leave root-owned state" \
  "! docker exec $NAME find /home/t3/.t3 -user root -print -quit | grep -q ."

# A volume mounted directly at the state dir arrives root-owned while its
# parent still looks correct. The entrypoint has to notice and adopt it, or the
# server dies on `mkdir userdata` with nothing but an EACCES stack trace.
STATE_MOUNT="$(mktemp -d)"
sudo chown 0:0 "$STATE_MOUNT" 2>/dev/null || chown 0:0 "$STATE_MOUNT" 2>/dev/null || true
docker run -d --name "${NAME}-mount" -v "$STATE_MOUNT:/home/t3/.t3" "$IMAGE" >/dev/null
mounted_ok=0
for _ in $(seq 1 40); do
  if docker exec "${NAME}-mount" curl -fsS --max-time 3 \
       "http://127.0.0.1:3773/.well-known/t3/environment" >/dev/null 2>&1; then
    mounted_ok=1
    break
  fi
  [ "$(docker inspect -f '{{.State.Running}}' "${NAME}-mount" 2>/dev/null)" = true ] || break
  sleep 3
done
if [ "$mounted_ok" = 1 ]; then
  ok "root-owned volume mounted at the state dir is adopted"
else
  no "root-owned volume mounted at the state dir is adopted"
  docker logs "${NAME}-mount" 2>&1 | tail -15
fi

# T3_PRINT_PAIRING_ON_START is the only way to pair without a shell in the
# container, so it has to actually reach the log.
# The setup service is the only way to pair without a shell in the container
# and without a restart, so it has to work unattended.
printf '\nSetup service\n'
SETUP_JAR="$(mktemp)"
check "refuses an unauthenticated request" \
  "[ \"\$(docker exec $NAME curl -sS -o /dev/null -w '%{http_code}' \
     http://127.0.0.1:3774/status)\" = 401 ]"
docker exec "$NAME" sh -c \
  "curl -sS -c /tmp/jar -d 'key=$SETUP_KEY' -o /dev/null http://127.0.0.1:3774/login" >/dev/null 2>&1
check "grants a session for the right key" \
  "docker exec $NAME sh -c 'curl -fsS -b /tmp/jar http://127.0.0.1:3774/status | grep -q publicUrl'"
setup_pair="$(docker exec "$NAME" sh -c \
  "curl -sS -b /tmp/jar -H 'content-type: application/json' -d '{\"ttl\":\"1h\"}' \
     http://127.0.0.1:3774/pair" 2>/dev/null || true)"
case "$setup_pair" in
  *"\"pairUrl\":\"${PUBLIC_URL}/pair#token="*) ok "mints a pairing link over HTTP" ;;
  *) no "mints a pairing link over HTTP"; printf '%s\n' "$setup_pair" | head -3 ;;
esac
check "the minted link is live on the running server" \
  "docker exec -u t3 $NAME t3 auth pairing list --json 2>/dev/null | grep -q orchestration:operate"
rm -f "$SETUP_JAR"

printf '\nStartup pairing link\n'
docker rm -f "${NAME}-boot" >/dev/null 2>&1 || true
docker run -d --name "${NAME}-boot" \
  -e "T3_PUBLIC_URL=${PUBLIC_URL}" \
  -e T3_PRINT_PAIRING_ON_START=1 \
  "$IMAGE" >/dev/null
boot_ok=0
for _ in $(seq 1 40); do
  if docker logs "${NAME}-boot" 2>&1 | grep -q "Pairing URL: ${PUBLIC_URL}/pair#token="; then
    boot_ok=1
    break
  fi
  [ "$(docker inspect -f '{{.State.Running}}' "${NAME}-boot" 2>/dev/null)" = true ] || break
  sleep 3
done
if [ "$boot_ok" = 1 ]; then
  ok "T3_PRINT_PAIRING_ON_START logs a usable pairing link"
else
  no "T3_PRINT_PAIRING_ON_START logs a usable pairing link"
  docker logs "${NAME}-boot" 2>&1 | tail -15
fi
docker rm -f "${NAME}-boot" >/dev/null 2>&1 || true

printf '\n%d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
