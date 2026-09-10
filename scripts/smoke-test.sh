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
# The setup service runs under a restart loop, so a single probe can land in the
# gap and fail a release build for no reason. Retry the ones that only talk to
# it; a genuine outage is caught separately by the crash-loop assertion below.
retry() { local n=$1; shift; local i; for i in $(seq 1 "$n"); do
  if eval "$*" >/dev/null 2>&1; then return 0; fi; sleep 2; done; return 1; }

STATE_MOUNT=""
cleanup() {
  docker rm -f "$NAME" "${NAME}-mount" "${NAME}-boot" "${NAME}-anon" "${NAME}-env" >/dev/null 2>&1 || true
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

# Agent sign-ins default to $HOME, which is only persisted if the whole home is
# mounted. Anchoring them under the state directory is what makes "sign in once"
# true for a deployment that only mounted .t3.
printf '\nCredential persistence\n'
check "agent credentials are anchored on the state volume" \
  "docker exec $NAME sh -c '[ \"\$(readlink /home/t3/.claude)\" = /home/t3/.t3/agents/.claude ]'"
check "a written credential lands on the state volume" \
  "docker exec -u t3 $NAME sh -c 'echo x > ~/.codex/auth.json && test -f /home/t3/.t3/agents/.codex/auth.json'"
# The Dockerfile declares VOLUME, so an unmounted deployment still looks mounted
# from inside; only the mount source distinguishes a throwaway anonymous volume.
docker rm -f "${NAME}-anon" >/dev/null 2>&1 || true
docker run -d --name "${NAME}-anon" -e T3_SETUP_KEY=x "$IMAGE" >/dev/null
# The entrypoint always prints exactly one persistence verdict, so wait for any
# of them rather than only the one we want. A wrong verdict then fails at once
# with the line it printed, and a container that died fails with its exit code,
# instead of burning the whole timeout in silence the way this used to.
anon_verdict=""
for _ in $(seq 1 30); do
  anon_verdict="$(docker logs "${NAME}-anon" 2>&1 | grep -m1 \
    -e 'is an anonymous volume' -e 'credentials persist on' -e 'is not on a mount at all' || true)"
  [ -n "$anon_verdict" ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "${NAME}-anon" 2>/dev/null)" = true ] || break
  sleep 3
done
case "$anon_verdict" in
  *'is an anonymous volume'*)
    ok "an anonymous volume is called out as not durable" ;;
  *)
    no "an anonymous volume is called out as not durable"
    printf '    verdict: %s\n' "${anon_verdict:-<none printed>}"
    printf '    container: %s\n' \
      "$(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' "${NAME}-anon" 2>/dev/null || echo unknown)"
    docker logs "${NAME}-anon" 2>&1 | tail -15 ;;
esac
docker rm -f "${NAME}-anon" >/dev/null 2>&1 || true

# The setup service is the only way to pair without a shell in the container
# and without a restart, so it has to work unattended.
printf '\nSetup service\n'
SETUP_JAR="$(mktemp)"
# Gate the section on the service actually answering, so the first assertion
# is not the one that discovers it is still starting.
retry 30 "docker exec $NAME curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:3774/" \
  || no "setup service never answered"
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

# Agent authentication, driven the way the page drives it.
printf '\nAgent authentication\n'
auth_post() { docker exec "$NAME" sh -c "curl -sS -b /tmp/jar -H 'content-type: application/json' -d '$1' http://127.0.0.1:3774$2"; }

codex_key_stored() {
  auth_post '{"agent":"codex","key":"sk-smoke-test-key"}' /auth/apikey | grep -q '"ok":true' &&
  docker exec -u t3 "$NAME" codex login status 2>&1 | grep -q "API key"
}
check "an API key signs Codex in" codex_key_stored

opencode_key_stored() {
  auth_post '{"agent":"opencode","provider":"deepseek","key":"sk-smoke"}' /auth/apikey | grep -q '"ok":true' &&
  docker exec -u t3 "$NAME" sh -c 'grep -q deepseek ~/.local/share/opencode/auth.json'
}
check "an API key is written for OpenCode" opencode_key_stored

check "an unknown agent is refused" \
  "auth_post '{\"agent\":\"bogus\",\"key\":\"x\"}' /auth/apikey | grep -q error"

# The panel used to decide this from a credentials file on disk, which misses
# every credential that never lands there. T3 Code honours ANTHROPIC_API_KEY and
# CLAUDE_CODE_OAUTH_TOKEN, so a container holding one showed as authenticated in
# T3 Code and "Not signed in" here. Ask each CLI instead, and assert both
# directions: the reading has to change when the credential appears, or it is
# not reading anything.
setup_status() { docker exec "$1" sh -c \
  "curl -sS --max-time 20 -b /tmp/envjar http://127.0.0.1:3774/status"; }

env_token_reads_as_signed_in() {
  docker rm -f "${NAME}-env" >/dev/null 2>&1 || true
  docker run -d --name "${NAME}-env" -e T3_SETUP_KEY=envkey \
    -e CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-smoke "$IMAGE" >/dev/null
  retry 25 "docker exec ${NAME}-env sh -c \"curl -sS --max-time 5 -c /tmp/envjar \
    -d 'key=envkey' -o /dev/null http://127.0.0.1:3774/login && \
    curl -fsS --max-time 20 -b /tmp/envjar http://127.0.0.1:3774/status | grep -q harnesses\"" || return 1
  setup_status "${NAME}-env" | python3 -c '
import json, sys
h = {a["id"]: a for a in json.load(sys.stdin)["harnesses"]}
sys.exit(0 if h["claude"]["signedIn"] is True else 1)'
}
check "an env-var Claude credential reads as signed in" env_token_reads_as_signed_in
docker rm -f "${NAME}-env" >/dev/null 2>&1 || true

# Reading it correctly once is not enough: a cached verdict would keep saying
# "not signed in" straight after a key is stored, which is exactly when someone
# is looking at the panel.
key_flips_signed_in() {
  docker exec "$NAME" sh -c \
    "curl -sS --max-time 20 -b /tmp/jar http://127.0.0.1:3774/status" | python3 -c '
import json, sys
h = {a["id"]: a for a in json.load(sys.stdin)["harnesses"]}
sys.exit(0 if h["codex"]["signedIn"] is True and h["claude"]["signedIn"] is False else 1)'
}
check "a stored key flips the panel without waiting for a cache" key_flips_signed_in

# Grok has no status command, and its credentials file proves nothing - a file
# of exactly the shape its own help text documents still leaves the CLI saying
# "You are not authenticated". So the reading comes from `grok models`, the way
# T3 Code does it, and a fresh container must read as a definite no rather than
# the "not readable" this used to show.
grok_reads_definitely() {
  docker exec "$NAME" sh -c \
    "curl -sS --max-time 25 -b /tmp/jar http://127.0.0.1:3774/status" | python3 -c '
import json, sys
h = {a["id"]: a for a in json.load(sys.stdin)["harnesses"]}
sys.exit(0 if h["grok"]["signedIn"] is False and h["cursor"]["signedIn"] is False else 1)'
}
check "Grok and Cursor report a definite sign-in state" grok_reads_definitely

# OpenCode takes a key per provider and there are over two hundred of them, so
# the page offers the models.dev catalog rather than asking you to recall an id.
provider_catalog() {
  docker exec "$NAME" sh -c \
    "curl -sS --max-time 30 -b /tmp/jar http://127.0.0.1:3774/providers" | python3 -c '
import json, sys, re
d = json.load(sys.stdin)
ids = [p["id"] for p in d["providers"]]
ok = len(ids) >= 10 and "anthropic" in ids
# Every id the picker offers has to survive the write path, or the dropdown
# hands people options the server then rejects.
rx = re.compile(r"^[a-z0-9][a-z0-9._-]{0,39}$")
sys.exit(0 if ok and all(rx.match(i) for i in ids) else 1)'
}
check "the provider picker offers a catalog the server accepts" provider_catalog

# Claude renders its URL as an OSC-8 hyperlink wrapped over several lines;
# scraping the visible text yields a truncated URL missing the PKCE challenge
# and state, which would send you to a sign-in page that cannot complete.
claude_url_complete() {
  local id
  id="$(auth_post '{"agent":"claude"}' /auth/signin | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
  [ -n "$id" ] || return 1
  sleep 14
  docker exec "$NAME" sh -c "curl -sS -b /tmp/jar 'http://127.0.0.1:3774/auth/session?id=$id'" \
    | grep -q 'code_challenge' &&
  docker exec "$NAME" sh -c "curl -sS -b /tmp/jar 'http://127.0.0.1:3774/auth/session?id=$id'" \
    | grep -q '"state":"awaiting-code"'
}
check "Claude sign-in captures a complete OAuth URL" claude_url_complete

# Capturing the URL is half the flow; the code has to get back in. That prompt
# runs the terminal in raw mode, where Enter arrives as CR - an LF is taken as
# part of the pasted text and the prompt just sits there, which is what left the
# panel saying "Submitting" for ever. A rejected code is the only exchange that
# can be driven without an account, and it proves the same thing: the CLI read
# the line, tried it, and answered. Stuck on "submitted" means it never did.
claude_code_reaches_the_prompt() {
  local id state
  id="$(auth_post '{"agent":"claude"}' /auth/signin | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
  [ -n "$id" ] || return 1
  sleep 14
  auth_post "{\"id\":\"$id\",\"code\":\"bogusCode123#bogusState456\"}" /auth/code >/dev/null
  state=submitted
  for _ in $(seq 1 20); do
    state="$(docker exec "$NAME" sh -c "curl -sS -b /tmp/jar 'http://127.0.0.1:3774/auth/session?id=$id'" \
      | sed -n 's/.*"state":"\([^"]*\)".*/\1/p')"
    [ "$state" != "submitted" ] && break
    sleep 2
  done
  # And the verdict has to stick. The child is killed once its output says the
  # code was rejected, and `script` reports that kill as a clean exit, which
  # flipped the session to "done" a moment later - telling someone they were
  # signed in when they had just been turned away. Re-read after it settles.
  sleep 6
  state="$(docker exec "$NAME" sh -c "curl -sS -b /tmp/jar 'http://127.0.0.1:3774/auth/session?id=$id'" \
    | sed -n 's/.*"state":"\([^"]*\)".*/\1/p')"
  [ "$state" = "failed" ]
}
check "a pasted code reaches the Claude prompt" claude_code_reaches_the_prompt

# Waiting for the CLI to exit was the wrong finish line. These are terminal UIs;
# one that prints its result and stays up is not a failure, but it left the
# panel on "Submitting" for ever. Completion is "this agent is signed in now",
# so prove a session notices that with the process still running. Codex is the
# one whose state can be flipped from outside mid-flow, so use it - signed out
# first, since only a transition counts.
signin_finishes_on_transition() {
  local id state
  docker exec -u t3 "$NAME" sh -c 'rm -f ~/.codex/auth.json'
  id="$(auth_post '{"agent":"codex"}' /auth/signin | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
  [ -n "$id" ] || return 1
  sleep 12
  auth_post '{"agent":"codex","key":"sk-smoke-transition"}' /auth/apikey | grep -q '"ok":true' || return 1
  for _ in $(seq 1 10); do
    state="$(docker exec "$NAME" sh -c "curl -sS -b /tmp/jar 'http://127.0.0.1:3774/auth/session?id=$id'" \
      | sed -n 's/.*"state":"\([^"]*\)".*/\1/p')"
    [ "$state" = "done" ] && return 0
    sleep 3
  done
  return 1
}
check "a sign-in finishes when the agent becomes signed in" signin_finishes_on_transition

# Codex's default login starts a callback server on localhost:1455, which is
# unreachable from a browser on any other machine - the redirect lands on the
# user's own localhost. Any sign-in URL naming localhost is broken by
# construction for a remote server, so assert against the whole class.
codex_device_not_localhost() {
  local id session
  id="$(auth_post '{"agent":"codex"}' /auth/signin | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
  [ -n "$id" ] || return 1
  sleep 13
  session="$(docker exec "$NAME" sh -c "curl -sS -b /tmp/jar 'http://127.0.0.1:3774/auth/session?id=$id'")"
  printf '%s' "$session" | grep -q 'auth.openai.com/codex/device' &&
  ! printf '%s' "$session" | grep -q localhost
}
check "Codex signs in by device code, not a localhost callback" codex_device_not_localhost

grok_device_code() {
  local id
  id="$(auth_post '{"agent":"grok"}' /auth/signin | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
  [ -n "$id" ] || return 1
  sleep 12
  docker exec "$NAME" sh -c "curl -sS -b /tmp/jar 'http://127.0.0.1:3774/auth/session?id=$id'" \
    | grep -q 'accounts.x.ai'
}
check "Grok sign-in captures a device URL" grok_device_code

# The page's script is built inside a template literal, so an escape can be
# eaten on the way out and leave the browser with JavaScript that does not
# parse - which looks like a page that simply never loads its data. Written as
# a function rather than an eval string: the nested quoting this needs is
# exactly the kind that dies inside eval, taking the whole run with it.
browser_script_parses() {
  docker exec "$NAME" sh -c '
    curl -sS -c /tmp/j3 -d "key='"$SETUP_KEY"'" -o /dev/null http://127.0.0.1:3774/login
    curl -sS -b /tmp/j3 http://127.0.0.1:3774/ \
      | sed -n "/<script>/,/<\/script>/p" | sed "1d;\$d" > /tmp/page.js
    test -s /tmp/page.js && node --check /tmp/page.js
  '
}
check "the script it serves to the browser parses" browser_script_parses

# A proxy routing a path prefix here forwards it intact. Serving the page only
# at / turned that into a bare "unauthorized", which reads as a wrong password.
check "serves the page under an unconfigured path prefix" \
  "retry 5 \"docker exec $NAME curl -fsS --max-time 5 http://127.0.0.1:3774/__setup | grep -qi '<!doctype html>'\""
check "and its routes work under that prefix" \
  "retry 5 \"docker exec $NAME sh -c \\\"curl -sS --max-time 5 -c /tmp/j2 -d 'key=$SETUP_KEY' -o /dev/null http://127.0.0.1:3774/__setup/login && curl -fsS --max-time 5 -b /tmp/j2 http://127.0.0.1:3774/__setup/status | grep -q publicUrl\\\"\""

# Retrying above would hide a service that is actually crash-looping, so assert
# separately that it started once and stayed up.
setup_stayed_up() {
  ! docker logs "$NAME" 2>&1 | grep -q "setup service exited"
}
check "the setup service did not crash-loop" setup_stayed_up
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
