#!/usr/bin/env bash
# Boot the image and assert the things a user would notice if they broke.
#
#   scripts/smoke-test.sh [image]      (default: t3code:full)
set -euo pipefail

IMAGE="${1:-t3code:full}"
NAME="t3code-smoke-$$"
PORT="${SMOKE_PORT:-13773}"
PUBLIC_URL="https://smoke.example.test"

pass=0
fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
no()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else no "$1"; fi; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

printf '\nSmoke-testing %s\n\n' "$IMAGE"

docker run -d --name "$NAME" \
  -p "127.0.0.1:${PORT}:3773" \
  -e "T3_PUBLIC_URL=${PUBLIC_URL}" \
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
check "docker healthcheck reports healthy" \
  '[ "$(docker inspect --format "{{.State.Health.Status}}" '"$NAME"')" = healthy ]'

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

printf '\nRuntimes\n'
for bin in node python3 git gh; do
  check "$bin present" "docker exec $NAME command -v $bin"
done

if docker exec "$NAME" command -v chromium >/dev/null 2>&1; then
  printf '\nBrowser (full image)\n'
  for bin in go rustc cargo bun deno uv ffmpeg cmake clang; do
    check "$bin present" "docker exec $NAME command -v $bin"
  done
  check "chromium renders headless" \
    "docker exec $NAME chromium --headless --no-sandbox --disable-gpu --dump-dom about:blank"
  check "playwright-mcp present" "docker exec $NAME command -v playwright-mcp"
  check "chrome-devtools-mcp present" "docker exec $NAME command -v chrome-devtools-mcp"
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

printf '\n%d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
