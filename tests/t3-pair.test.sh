#!/usr/bin/env bash
# t3-pair must explain a failed mint instead of dying silently: `set -e`
# would otherwise abort the script before its own error handling runs.
#
#   bash tests/t3-pair.test.sh
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
T3_PAIR="$ROOT/docker/bin/t3-pair"
# The helper sources the shared step-down from the image path; point it at
# the checkout instead.
export T3_STEP_DOWN_LIB="$ROOT/docker/lib"

pass=0
fail=0
ok() { printf '  PASS %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A launcher that always fails, with the migration chatter a real CLI adds.
printf '#!/usr/bin/env bash\necho "migration chatter" >&2\nexit 1\n' > "$WORK/failing-launcher"
chmod +x "$WORK/failing-launcher"

output="$(set +e; T3_INFRA_LAUNCHER="$WORK/failing-launcher" \
  T3_INFRA_NODE="$(command -v node)" T3_PUBLIC_URL_RESOLVER=/nonexistent.mjs \
  bash "$T3_PAIR" --no-qr 2>&1; echo "exit=$?")"
status="${output##*exit=}"

if [ "$status" = 1 ]; then ok "a failed mint exits 1"; else no "a failed mint exits 1 (got $status)"; fi
if printf '%s' "$output" | grep -q 'failed to mint a pairing token'; then
  ok "the failure says so"
else
  no "the failure says so"
fi

if [ "$fail" -eq 0 ]; then printf 'all %s checks passed\n' "$pass"; exit 0; fi
printf '%s of %s checks failed\n' "$fail" "$((pass + fail))"
exit 1
