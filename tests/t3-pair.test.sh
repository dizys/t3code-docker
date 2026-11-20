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

# A failed launcher can still print a complete JSON response before it exits.
cat > "$WORK/failing-launcher" <<'SH'
#!/usr/bin/env bash
echo "migration chatter" >&2
if [ -n "$FIXTURE_PAIR_RESPONSE" ]; then printf '%s\n' "$FIXTURE_PAIR_RESPONSE"; fi
exit 1
SH
chmod +x "$WORK/failing-launcher"

for response in '' '{"pairUrl":"https://example.test/pair/fixture"}'; do
  status=0
  # The caller supplies the URL, so the resolver is unnecessary here.
  output="$(FIXTURE_PAIR_RESPONSE="$response" T3_INFRA_LAUNCHER="$WORK/failing-launcher" \
    T3_INFRA_NODE=/bin/false \
    bash "$T3_PAIR" --base-url https://example.test --no-qr 2>&1)" || status=$?

  if [ "$status" = 1 ]; then ok "a failed mint exits 1"; else no "a failed mint exits 1 (got $status)"; fi
  if [[ "$output" == *"failed to mint a pairing token"* && "$output" != *"Pairing URL:"* ]]; then
    ok "a failed mint reports the error without printing a link"
  else
    no "a failed mint reports the error without printing a link"
  fi
done

if [ "$fail" -eq 0 ]; then printf 'all %s checks passed\n' "$pass"; exit 0; fi
printf '%s of %s checks failed\n' "$fail" "$((pass + fail))"
exit 1
