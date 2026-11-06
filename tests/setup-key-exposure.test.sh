#!/usr/bin/env bash
# The setup key is a credential: said once when new, never leaked.
#
#   bash tests/setup-key-exposure.test.sh
#
# The entrypoint used to print the kept key on every start and export it to
# every child (T3 Code, its terminals, the agents in them), where anything
# could read it from /proc. Now the key is announced only when it is new,
# and only the setup server's own subshell inherits it.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="$ROOT/docker/entrypoint.sh"

pass=0
fail=0
ok() { printf '  PASS %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }

# Load only announce_setup_key from the entrypoint: sourcing the whole file
# would remap users and start services. Function boundaries are exact.
extracted="$(sed -n '/^announce_setup_key() {/,/^}/p' "$ENTRYPOINT")"
if [ -z "$extracted" ]; then
  no "announce_setup_key exists in the entrypoint"
  printf '\n%d passed, %d failed\n' "$pass" "$fail"
  exit 1
fi
load_announce() {
  unset -f announce_setup_key log 2>/dev/null || true
  eval "$extracted"
  log() { printf '%s\n' "$*"; }
}

run_announce() { # source key
  T3_SETUP_KEY_SOURCE="$1" T3_SETUP_KEY="$2" T3CODE_HOME="/nonexistent" announce_setup_key
}

SECRET="s3cr3t-key-value"

out="$(load_announce; run_announce new "$SECRET")"
case "$out" in
  *"$SECRET"*) ok "a new key is printed once, so first start can be found in the log" ;;
  *) no "a new key is printed once (got: $out)" ;;
esac

out="$(load_announce; run_announce boot "$SECRET")"
case "$out" in
  *"$SECRET"*) ok "an ephemeral key is printed, since it changes every start" ;;
  *) no "an ephemeral key is printed (got: $out)" ;;
esac

out="$(load_announce; run_announce volume "$SECRET")"
if [ -z "$out" ] || ! printf '%s' "$out" | grep -qF "$SECRET"; then
  ok "a kept key is never printed again"
else
  no "a kept key is never printed again (got: $out)"
fi

out="$(load_announce; run_announce env "$SECRET")"
if [ -z "$out" ] || ! printf '%s' "$out" | grep -qF "$SECRET"; then
  ok "a configured key is never printed, its owner already chose it"
else
  no "a configured key is never printed (got: $out)"
fi

# The export must live inside the server's subshell only, with an unset
# after it so later children (T3, terminals, agents) never inherit the key.
exports="$(grep -c 'export T3_SETUP_KEY' "$ENTRYPOINT")"
unsets="$(grep -c '^[[:space:]]*unset T3_SETUP_KEY$' "$ENTRYPOINT")"
if [ "$exports" = 1 ] && [ "$unsets" = 1 ]; then
  ok "the key is exported once, then unset before later children start"
else
  no "the key is exported once, then unset (exports=$exports unsets=$unsets)"
fi

if grep -q '^    export T3_SETUP_KEY T3_SETUP_KEY_SOURCE$' "$ENTRYPOINT"; then
  ok "the export is scoped inside the server subshell"
else
  no "the export is scoped inside the server subshell"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
