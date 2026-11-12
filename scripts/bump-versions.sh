#!/usr/bin/env bash
# Refresh the pinned tool versions in the Dockerfile against published releases.
#
# The pins exist so a rebuild is reproducible. The cost of pinning is that an
# image goes stale the moment upstream ships, and a freshly built image that
# immediately asks you to upgrade two agents is worse than no pin at all - so
# this script is what keeps the pins honest, and CI runs it with --check.
#
#   ./scripts/bump-versions.sh            # rewrite the Dockerfile in place
#   ./scripts/bump-versions.sh --check    # report drift, change nothing (CI)
set -euo pipefail

cd "$(dirname "$0")/.."
CHECK_ONLY=false
[ "${1:-}" = "--check" ] && CHECK_ONLY=true

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; RESET=$'\033[0m'
[ -t 1 ] || { BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""; }

drift=0
changed=0

# ARG name : release source. T3 uses GitHub; the other pins use npm.
# Agent harnesses are deliberately absent: they are installed at runtime
# through mise, which resolves and records an exact version on explicit install
# rather than baking one into the image.
PINS="
T3_VERSION:github-t3
CHROME_DEVTOOLS_MCP_VERSION:chrome-devtools-mcp
PLAYWRIGHT_MCP_VERSION:@playwright/mcp
"

npm_latest() {
  curl -fsS --connect-timeout 5 --max-time 30 --retry 2 --retry-max-time 20 \
    "https://registry.npmjs.org/$1/latest" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["version"])'
}

github_latest() {
  # CI already supplies a token. Keep it out of process arguments and send it
  # only to api.github.com; registry and archive requests remain unauthenticated.
  local headers=""
  [ -z "${GITHUB_TOKEN:-}" ] || headers="Authorization: Bearer ${GITHUB_TOKEN}"
  printf '%s\n' "$headers" | curl -fsS --connect-timeout 5 --max-time 30 \
    --retry 2 --retry-max-time 20 --header @- \
    "https://api.github.com/repos/$1/releases/latest"
}

latest_version() {
  if [ "$1" = github-t3 ]; then
    github_latest pingdotgg/t3code \
      | python3 -c 'import sys,json,re; tag=json.load(sys.stdin)["tag_name"]; re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag) or sys.exit("Expected a stable T3 release tag"); print(tag[1:])'
  else
    npm_latest "$1"
  fi
}

printf '%s%-28s %-12s %-12s%s\n' "$BOLD" "PIN" "CURRENT" "LATEST" "$RESET"

for entry in $PINS; do
  arg="${entry%%:*}"; pkg="${entry#*:}"
  current="$(grep -m1 "^ARG ${arg}=" Dockerfile | cut -d= -f2)"
  [ -n "$current" ] || { echo "${RED}no ARG ${arg} in Dockerfile${RESET}" >&2; exit 1; }

  if ! latest="$(latest_version "$pkg")"; then
    echo "${RED}could not check published releases for ${pkg}${RESET}" >&2
    exit 1
  fi

  if [ "$current" = "$latest" ]; then
    printf '%-28s %-12s %-12s %s✓%s\n' "$arg" "$current" "$latest" "$GREEN" "$RESET"
    continue
  fi

  drift=$((drift + 1))
  printf '%-28s %-12s %s%-12s%s %sbehind%s\n' \
    "$arg" "$current" "$BOLD" "$latest" "$RESET" "$YELLOW" "$RESET"

  if [ "$CHECK_ONLY" = false ]; then
    # The value is a bare semver, so anchoring on the ARG name is enough.
    sed -i "s|^ARG ${arg}=.*|ARG ${arg}=${latest}|" Dockerfile
    changed=$((changed + 1))
  fi
done

# The browser MCP tree installs from a lockfile so rebuilds resolve the same
# tree. The Dockerfile ARGs stay the version record: keep the checked-in
# package.json in sync with them, then re-snapshot the lockfile. --check only
# compares, so a stale tree is reported, never refreshed.
MCP_PINS="CHROME_DEVTOOLS_MCP_VERSION:chrome-devtools-mcp PLAYWRIGHT_MCP_VERSION:@playwright/mcp"
if [ -f docker/browser-mcp/package.json ]; then
  for entry in $MCP_PINS; do
    mcp_arg="${entry%%:*}"; mcp_pkg="${entry#*:}"
    mcp_pinned="$(grep -m1 "^ARG ${mcp_arg}=" Dockerfile | cut -d= -f2)"
    mcp_current="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("dependencies", {}).get(sys.argv[2], ""))' docker/browser-mcp/package.json "$mcp_pkg")"
    if [ "$mcp_current" != "$mcp_pinned" ]; then
      drift=$((drift + 1))
      printf '%-28s %-12s %s%-12s%s %sbehind%s\n' \
        "browser-mcp ${mcp_pkg}" "${mcp_current:-none}" "$BOLD" "$mcp_pinned" "$RESET" "$YELLOW" "$RESET"
      if [ "$CHECK_ONLY" = false ]; then
        python3 - docker/browser-mcp/package.json "$mcp_pkg" "$mcp_pinned" <<'EOF'
import json, sys
path, pkg, version = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as handle:
    manifest = json.load(handle)
manifest.setdefault("dependencies", {})[pkg] = version
with open(path, "w") as handle:
    json.dump(manifest, handle, indent=2)
    handle.write("\n")
EOF
        changed=$((changed + 1))
      fi
    fi
  done
  if [ "$CHECK_ONLY" = false ]; then
    ( cd docker/browser-mcp && npm install --package-lock-only --no-audit --no-fund )
  else
    for entry in $MCP_PINS; do
      mcp_arg="${entry%%:*}"; mcp_pkg="${entry#*:}"
      mcp_pinned="$(grep -m1 "^ARG ${mcp_arg}=" Dockerfile | cut -d= -f2)"
      mcp_locked="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("packages", {}).get("node_modules/" + sys.argv[2], {}).get("version", ""))' docker/browser-mcp/package-lock.json "$mcp_pkg" 2>/dev/null || true)"
      if [ "$mcp_locked" != "$mcp_pinned" ]; then
        drift=$((drift + 1))
        printf '%-28s %-12s %s%-12s%s %sbehind%s\n' \
          "browser-mcp lock ${mcp_pkg}" "${mcp_locked:-none}" "$BOLD" "$mcp_pinned" "$RESET" "$YELLOW" "$RESET"
      fi
    done
  fi
fi

# gh is deliberately unpinned - GitHub's apt repo keeps only the current
# release - so all that can drift is the floor the Dockerfile asserts against.
# T3 Code states its own requirement in its bundle; report when that moves.
gh_floor="$(grep -m1 '^ARG GH_MIN_VERSION=' Dockerfile | cut -d= -f2)"
printf '\n%sgh%s is unpinned (tracks GitHub'"'"'s apt repo); asserted floor is %s%s%s\n' \
  "$DIM" "$RESET" "$BOLD" "$gh_floor" "$RESET"
echo "${DIM}T3 Code's own declared minimum is checked by the smoke test.${RESET}"

# mise installs every agent and toolchain at runtime, so it matters, but it
# ships several releases a week and a pin a few days old is not a defect.
# Reported, never counted as drift and never bumped here: a new release also
# needs its checksums and the idiomatic allowlist regenerated.
mise_pin="$(grep -m1 '^ARG MISE_VERSION=' Dockerfile | cut -d= -f2)"
mise_latest="$(github_latest jdx/mise 2>/dev/null \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["tag_name"].lstrip("v"))' 2>/dev/null || echo "?")"
if [ "$mise_pin" = "$mise_latest" ]; then
  printf '%smise%s %s is current\n' "$DIM" "$RESET" "$mise_pin"
else
  printf '%smise%s pinned at %s%s%s, latest %s - to move it, set MISE_VERSION and run\n' \
    "$DIM" "$RESET" "$BOLD" "$mise_pin" "$RESET" "$mise_latest"
  echo "${DIM}  scripts/generate-mise-idiomatic.sh (checksums and allowlist) before rebuilding.${RESET}"
fi

echo
if [ "$drift" -eq 0 ]; then
  echo "${GREEN}every pin is current${RESET}"
  exit 0
fi
if [ "$CHECK_ONLY" = true ]; then
  echo "${YELLOW}${drift} pin(s) behind${RESET} - run ./scripts/bump-versions.sh to update"
  exit 1
fi
echo "${GREEN}updated ${changed} pin(s)${RESET} - rebuild and run the smoke test before committing"
