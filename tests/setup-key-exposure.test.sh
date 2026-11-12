#!/usr/bin/env bash
# The setup key is printed once when new, and scoped to Setup's environment.
#
#   bash tests/setup-key-exposure.test.sh
#
# The entrypoint used to print the kept key on every start and export it to
# every child (T3 Code, its terminals, the agents in them). Run the actual
# startup functions with a fixture Setup process and real key resolution.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="${ENTRYPOINT:-$ROOT/docker/entrypoint.sh}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok() { printf '  PASS %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }

# Load only announce_setup_key from the entrypoint: sourcing the whole file
# would remap users and start services. Function boundaries are exact.
extracted="$(sed -n '/^setup_key_fingerprint() {/,/^}/p; /^announce_setup_key() {/,/^}/p' "$ENTRYPOINT")"
if [ -z "$extracted" ]; then
  no "announce_setup_key exists in the entrypoint"
  printf '\n%d passed, %d failed\n' "$pass" "$fail"
  exit 1
fi
load_announce() {
  unset -f announce_setup_key setup_key_fingerprint log 2>/dev/null || true
  eval "$extracted"
  log() { printf '%s\n' "$*"; }
}

run_announce() { # source key
  T3_SETUP_KEY_SOURCE="$1" T3_SETUP_KEY="$2" T3CODE_HOME="/nonexistent" announce_setup_key
}

SECRET="s3cr3t-key-value"

out="$(load_announce; run_announce new "$SECRET")"
if ! printf '%s' "$out" | grep -qF "$SECRET"; then
  case "$out" in
    *fingerprint*) ok "a new key is announced by fingerprint, never in full" ;;
    *) no "a new key is announced by fingerprint (got: $out)" ;;
  esac
else
  no "a new key is announced by fingerprint (got: $out)"
fi

out="$(load_announce; run_announce boot "$SECRET")"
if ! printf '%s' "$out" | grep -qF "$SECRET"; then
  case "$out" in
    *fingerprint*) ok "an ephemeral key is announced by fingerprint, since it changes every start" ;;
    *) no "an ephemeral key is announced by fingerprint (got: $out)" ;;
  esac
else
  no "an ephemeral key is announced by fingerprint (got: $out)"
fi

LONG="abcdef0123456789abcdef0123456789"
out="$(load_announce; run_announce new "$LONG")"
if ! printf '%s' "$out" | grep -qF "$LONG" &&
    printf '%s' "$out" | grep -q "sha256:$(printf '%s' "$LONG" | sha256sum | cut -c1-12)" &&
    ! printf '%s' "$out" | grep -q 'abcd.*6789'; then
  ok "a generated key logs a hash, without raw key fragments"
else
  no "a generated key logs a hash, without raw key fragments (got: $out)"
fi

out="$(load_announce; T3_PRINT_SETUP_KEY=1 run_announce new "$SECRET")"
case "$out" in
  *"$SECRET"*) ok "T3_PRINT_SETUP_KEY=1 still prints the full key for a first start" ;;
  *) no "T3_PRINT_SETUP_KEY=1 still prints the full key (got: $out)" ;;
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

# Use the unprivileged environment prelude and the Setup startup section.
# Redirect fixed image paths to fixtures, leaving the functions and their
# call/unset sequence intact. Never source the privileged entrypoint itself.
sed -n '/^# --- unprivileged half/,/^if ! mkdir/{ /^if ! mkdir/d; p; }' "$ENTRYPOINT" > "$WORK/prelude.sh"
sed -n '/^setup_key_fingerprint() {/,/^start_router() {/{ /^start_router() {/d; p; }' "$ENTRYPOINT" \
  | sed "s|/opt/t3-setup/|$WORK/setup/|g" > "$WORK/startup.sh"
mkdir "$WORK/setup"
touch "$WORK/setup/server.mjs"

cat > "$WORK/node" <<'NODE'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  */setup-key.mjs)
    [ "${RESOLVE_FAIL:-0}" != 1 ] || exit 1
    exec "$REAL_NODE" "$REAL_RESOLVER" --resolve ;;
  */server.mjs)
    printf '%s %s\n' "${T3_SETUP_KEY_SOURCE-unset}" "${T3_SETUP_KEY-unset}" > "$CASE_DIR/setup-env" ;;
  *) exit 2 ;;
esac
NODE
chmod +x "$WORK/node"

cat > "$WORK/boot.sh" <<'BOOT'
set -euo pipefail
# shellcheck source=/dev/null
. "$FIXTURE_ROOT/prelude.sh"
bash -c 'printf "%s %s\n" "${T3_SETUP_KEY-unset}" "${T3_SETUP_KEY_SOURCE-unset}"' > "$CASE_DIR/helper-env"
log() { printf '%s\n' "$*"; }
# End the fixture Setup loop after it has captured its environment. This runs
# only in the background subshell, so the foreground can continue to T3.
sleep() { exit 0; }
# shellcheck source=/dev/null
. "$FIXTURE_ROOT/startup.sh"
wait
bash -c '
  printf "%s %s\n" "${T3_SETUP_KEY-unset}" "${T3_SETUP_KEY_SOURCE-unset}"
  bash -c '\''printf "%s %s\n" "${T3_SETUP_KEY-unset}" "${T3_SETUP_KEY_SOURCE-unset}"'\''
' > "$CASE_DIR/t3-env"
BOOT

boot() { # case-name [environment overrides...]
  local name="$1"
  shift
  CASE_DIR="$WORK/$name"
  mkdir -p "$CASE_DIR/state"
  env -u T3_SETUP_KEY -u T3_SETUP_KEY_SOURCE \
    FIXTURE_ROOT="$WORK" CASE_DIR="$CASE_DIR" \
    REAL_NODE="$(command -v node)" REAL_RESOLVER="$ROOT/docker/setup/setup-key.mjs" \
    T3_INFRA_NODE="$WORK/node" T3CODE_HOME="$CASE_DIR/state" \
    T3_SETUP_ENABLED=1 T3_SETUP_PORT=3774 T3_SINGLE_PORT='' \
    "$@" bash "$WORK/boot.sh" > "$CASE_DIR/log" 2>&1
}

children_have_no_key() {
  [ "$(cat "$CASE_DIR/helper-env")" = 'unset unset' ] &&
    [ "$(cat "$CASE_DIR/t3-env")" = $'unset unset\nunset unset' ]
}

boot configured T3_SETUP_KEY="$SECRET" T3_SETUP_KEY_SOURCE=env
if [ "$(cat "$CASE_DIR/setup-env")" = "env $SECRET" ] &&
    [ "$(cat "$CASE_DIR/state/setup-key")" = "$SECRET" ] &&
    children_have_no_key && ! grep -qF "$SECRET" "$CASE_DIR/log"; then
  ok "a configured key reaches Setup and its file, but no helper, T3 or descendant"
else
  no "configured key inheritance or logging"
fi

boot short T3_SETUP_KEY="tiny" T3_SETUP_KEY_SOURCE=env
if grep -q "WARNING: the setup key is short" "$CASE_DIR/log" &&
    ! grep -qF "tiny" "$CASE_DIR/log"; then
  ok "a short configured key warns in the log without printing the key"
else
  no "short key log warning"
fi

boot generated
generated="$(cat "$CASE_DIR/state/setup-key")"
if [ "$(cat "$CASE_DIR/setup-env")" = "new $generated" ] &&
    ! grep -qF "$generated" "$CASE_DIR/log" &&
    grep -q "fingerprint: sha256:$(printf '%s' "$generated" | sha256sum | cut -c1-12)" "$CASE_DIR/log" &&
    ! grep -q "WARNING: the setup key is short" "$CASE_DIR/log" && children_have_no_key; then
  ok "a generated key reaches Setup; the first-start log carries its fingerprint only"
else
  no "generated key inheritance or first-start logging"
fi

boot optin T3_PRINT_SETUP_KEY=1
opted="$(cat "$CASE_DIR/state/setup-key")"
if grep -qF "$opted" "$CASE_DIR/log"; then
  ok "T3_PRINT_SETUP_KEY=1 prints the full generated key for a first start"
else
  no "opt-in full key logging"
fi
boot generated
if [ "$(cat "$CASE_DIR/setup-env")" = "volume $generated" ] &&
    ! grep -qF "$generated" "$CASE_DIR/log" && children_have_no_key; then
  ok "a restart keeps the key working for Setup without logging or inheriting it"
else
  no "kept key inheritance or restart logging"
fi

boot ephemeral T3CODE_HOME="$WORK/no-such-volume"
ephemeral="$(cat "$CASE_DIR/setup-env")"
ephemeral="${ephemeral#boot }"
if [[ "$(cat "$CASE_DIR/setup-env")" == 'boot '* ]] &&
    children_have_no_key && grep -q 'generated one for this start' "$CASE_DIR/log" &&
    grep -q 'Set T3_SETUP_KEY.*recreate' "$CASE_DIR/log" &&
    grep -q 'T3_PRINT_SETUP_KEY=1' "$CASE_DIR/log" &&
    ! grep -qF "$ephemeral" "$CASE_DIR/log"; then
  ok "Setup still gets an ephemeral key when no file can be written"
else
  no "ephemeral key inheritance"
fi

for mode in disabled missing resolve-failed; do
  options=()
  case "$mode" in
    disabled) options+=(T3_SETUP_ENABLED=0) ;;
    missing) rm "$WORK/setup/server.mjs" ;;
    resolve-failed) touch "$WORK/setup/server.mjs"; options+=(RESOLVE_FAIL=1) ;;
  esac
  boot "$mode" T3_SETUP_KEY="$SECRET" T3_SETUP_KEY_SOURCE=env "${options[@]}"
  if [ ! -f "$CASE_DIR/setup-env" ] && children_have_no_key &&
      ! grep -qF "$SECRET" "$CASE_DIR/log"; then
    ok "Setup $mode leaves no key in helpers, T3 or descendants"
  else
    no "Setup $mode key cleanup"
  fi
done

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
