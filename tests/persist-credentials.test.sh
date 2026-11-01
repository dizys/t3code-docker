#!/usr/bin/env bash
# Where the entrypoint keeps sign-ins (persist_agent_credentials in
# docker/entrypoint.sh): on the state volume, linked back into the home.
#
#   bash tests/persist-credentials.test.sh
#
# The function and its list of paths are read out of the entrypoint and run
# against a scratch home. Which paths are mounted on their own is stubbed
# (covering_mount reads /proc/self/mountinfo, which a test cannot arrange).
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

pass=0
fail=0
ok() { printf '  PASS %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (expected [$2], got [$3])"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log() { :; }
# Paths named in $MOUNTED are mounted on their own; everything else shares the
# home's mount.
MOUNTED=""
covering_mount() {
  local point
  for point in $MOUNTED; do
    case "$1/" in "$point"/*) printf '%s\n' "$point"; return ;; esac
  done
  printf 'home\n'
}
eval "$(sed -n '/^AGENT_DIRS=/,/^}/p' "$ROOT/docker/entrypoint.sh")"
eval "$(sed -n '/^opencode_config_root()/,/^}/p' "$ROOT/docker/entrypoint.sh")"
eval "$(sed -n '/^ensure_opencode_config()/,/^}/p' "$ROOT/docker/entrypoint.sh")"
eval "$(sed -n '/^configure_opencode_config()/,/^}/p' "$ROOT/docker/entrypoint.sh")"
declare -F persist_agent_credentials >/dev/null || { echo "persist_agent_credentials not found in the entrypoint"; exit 1; }

T3_HOME="$WORK/home"
T3CODE_HOME="$WORK/state"
T3_RUN_DIR="$WORK/run"
export T3_PERSIST_AGENT_CREDENTIALS=1
# Mirror the entrypoint default: OpenCode reads a real folder on the state
# volume, so the config never becomes a home symlink.
T3_INFRA_NODE="$(command -v node)"
export T3_INFRA_NODE
export T3_OPENCODE_CONFIG_CLI="$ROOT/docker/setup/opencode-config.mjs"
unset OPENCODE_CONFIG_DIR XDG_CONFIG_HOME
configure_opencode_config
is "CLI helpers can read the selected runtime config path" "$OPENCODE_CONFIG_DIR" "$(cat "$T3_RUN_DIR/opencode-config-dir")"
OC_ROOT="$(opencode_config_root)"
STORE="$T3CODE_HOME/agents"
mkdir -p "$T3_HOME" "$T3CODE_HOME"

# A sign-in and a git identity from before, in the home.
mkdir -p "$T3_HOME/.config/gh"
echo "github.com: {user: ana}" > "$T3_HOME/.config/gh/hosts.yml"
printf '[user]\n\tname = Ana\n' > "$T3_HOME/.gitconfig"
mkdir -p "$T3_HOME/.pi/agent/sessions"
printf '%s' 'Pi credential' > "$T3_HOME/.pi/agent/auth.json"
printf '%s' 'Pi session' > "$T3_HOME/.pi/agent/sessions/test.jsonl"
mkdir -p "$T3_HOME/.config/muse" "$T3_HOME/.local/share/muse"
printf '%s' '{"providers":{"meta":{"api_key":"muse-test-key"}}}' > "$T3_HOME/.config/muse/auth.json"
printf '%s' 'saved Muse session' > "$T3_HOME/.local/share/muse/session-test"
mkdir -p "$T3_HOME/.local/share/opencode"
printf '%s' 'OpenCode credential database' > "$T3_HOME/.local/share/opencode/opencode.db"
printf '%s' 'OpenCode pending journal' > "$T3_HOME/.local/share/opencode/opencode.db-wal"
printf '%s' '{"mcpServers":{"probe":{"command":"server"}}}' > "$T3_HOME/.claude.json"
mkdir -p "$T3_HOME/.agents/skills/local/references"
printf '%s' 'Shared skill instructions' > "$T3_HOME/.agents/skills/local/SKILL.md"
printf '%s' 'Supporting reference' > "$T3_HOME/.agents/skills/local/references/guide.md"
printf '%s' 'Unrelated agent data' > "$T3_HOME/.agents/unrelated"
mkdir -p "$T3_HOME/.gemini/config/skills/review"
printf '%s' 'Antigravity skill' > "$T3_HOME/.gemini/config/skills/review/SKILL.md"
printf '%s' 'Other Gemini data' > "$T3_HOME/.gemini/unrelated"
mkdir -p "$T3_HOME/.gemini/antigravity-cli/skills/cli-check"
printf '%s' 'Antigravity CLI skill' > "$T3_HOME/.gemini/antigravity-cli/skills/cli-check/SKILL.md"
# The host's glab sign-in, mounted into the container.
mkdir -p "$T3_HOME/.config/glab-cli"
echo "host's" > "$T3_HOME/.config/glab-cli/config.yml"
MOUNTED="$T3_HOME/.config/glab-cli"

persist_agent_credentials

[ -L "$T3_HOME/.agents/skills" ] && ok "shared skills become a scoped link" || no "shared skills become a scoped link"
[ ! -e "$T3_HOME/.config/opencode" ] && ok "no home OpenCode symlink is created" || no "no home OpenCode symlink is created"
[ -d "$OC_ROOT/skills" ] && [ ! -L "$OC_ROOT/skills" ] && [ -d "$OC_ROOT/agents" ] && [ ! -L "$OC_ROOT/agents" ] && ok "the state-volume OpenCode config stays real dirs" || no "the state-volume OpenCode config stays real dirs"
[ -L "$T3_HOME/.gemini/config/skills" ] && ok "Antigravity skills become a scoped link" || no "Antigravity skills become a scoped link"
[ ! -L "$T3_HOME/.gemini" ] && [ -f "$T3_HOME/.gemini/unrelated" ] && ok "the rest of .gemini stays in place" || no "the rest of .gemini stays in place"
[ ! -L "$T3_HOME/.agents" ] && [ -f "$T3_HOME/.agents/unrelated" ] && ok "the rest of .agents stays in place" || no "the rest of .agents stays in place"
[ -L "$T3_HOME/.agents/.skill-lock.json" ] && [ ! -e "$T3_HOME/.agents/.skill-lock.json" ] && ok "an absent package lock is linked without inventing JSON" || no "an absent package lock is linked without inventing JSON"
printf '%s' '{"version":3,"skills":{"tracked":{"source":"owner/repo"}}}' > "$T3_HOME/.agents/.skill-lock.json"
printf '%s' 'XDG skill metadata' > "$T3_HOME/.local/state/skills/fixture"

[ -L "$T3_HOME/.config/gh" ] && ok "a CLI's directory becomes a link" || no "a CLI's directory becomes a link"
is "into the state volume" "$STORE/.config_gh" "$(readlink "$T3_HOME/.config/gh")"
is "with the sign-in that was there" "github.com: {user: ana}" "$(cat "$STORE/.config_gh/hosts.yml")"
[ -L "$T3_HOME/.gitconfig" ] && ok "the home's .gitconfig becomes a link" || no "the home's .gitconfig becomes a link"
is "with the settings that were there" "Ana" "$(git config --file "$T3_HOME/.gitconfig" user.name)"
[ ! -L "$T3_HOME/.config/glab-cli" ] && ok "a mounted directory is left where it is" || no "a mounted directory is left where it is"
is "with the host's files in it" "host's" "$(cat "$T3_HOME/.config/glab-cli/config.yml")"
[ ! -e "$STORE/.config_glab-cli" ] && ok "and nothing is copied out of it" || no "and nothing is copied out of it"
[ -d "$STORE/.azure" ] && [ -L "$T3_HOME/.azure" ] && ok "a CLI not used yet gets its place too" || no "a CLI not used yet gets its place too"

# git writes through the link: what gh auth setup-git and git config --global
# add lands on the state volume, and the link stays.
HOME="$T3_HOME" git config --global credential.https://github.com.helper '!gh auth git-credential'
[ -L "$T3_HOME/.gitconfig" ] && ok "git config --global keeps the link" || no "git config --global keeps the link"
is "and writes to the state volume" '!gh auth git-credential' "$(git config --file "$STORE/.gitconfig" credential.https://github.com.helper)"

# A recreated container: a fresh home, the same state volume.
rm -rf "$T3_HOME"
mkdir -p "$T3_HOME"
MOUNTED=""
persist_agent_credentials
is "after a recreate, the sign-in is back" "github.com: {user: ana}" "$(cat "$T3_HOME/.config/gh/hosts.yml")"
is "Pi credentials survive a recreate" "Pi credential" "$(cat "$T3_HOME/.pi/agent/auth.json")"
is "Pi sessions survive a recreate" "Pi session" "$(cat "$T3_HOME/.pi/agent/sessions/test.jsonl")"
is "Muse credentials survive a recreate" '{"providers":{"meta":{"api_key":"muse-test-key"}}}' "$(cat "$T3_HOME/.config/muse/auth.json")"
is "Muse sessions survive a recreate" 'saved Muse session' "$(cat "$T3_HOME/.local/share/muse/session-test")"
is "OpenCode credential database survives a recreate" 'OpenCode credential database' "$(cat "$T3_HOME/.local/share/opencode/opencode.db")"
is "OpenCode database sidecars survive a recreate" 'OpenCode pending journal' "$(cat "$T3_HOME/.local/share/opencode/opencode.db-wal")"
is "Claude global MCP config survives a recreate" '{"mcpServers":{"probe":{"command":"server"}}}' "$(cat "$T3_HOME/.claude.json")"
is "Antigravity CLI skills survive a recreate" 'Antigravity CLI skill' "$(cat "$T3_HOME/.gemini/antigravity-cli/skills/cli-check/SKILL.md")"
is "Antigravity skills survive a recreate" 'Antigravity skill' "$(cat "$T3_HOME/.gemini/config/skills/review/SKILL.md")"
is "shared skills survive a recreate" 'Shared skill instructions' "$(cat "$T3_HOME/.agents/skills/local/SKILL.md")"
is "shared supporting files survive a recreate" 'Supporting reference' "$(cat "$T3_HOME/.agents/skills/local/references/guide.md")"
is "the package lock survives a recreate" '{"version":3,"skills":{"tracked":{"source":"owner/repo"}}}' "$(cat "$T3_HOME/.agents/.skill-lock.json")"
is "XDG skills state survives a recreate" 'XDG skill metadata' "$(cat "$T3_HOME/.local/state/skills/fixture")"
is "and so is git's identity" "Ana" "$(HOME="$T3_HOME" git config --global user.name)"
is "and its credential helper" '!gh auth git-credential' "$(HOME="$T3_HOME" git config --global credential.https://github.com.helper)"

# Running again changes nothing.
before="$(cd "$WORK" && find . | sort)"
persist_agent_credentials
is "a second run changes nothing" "$before" "$(cd "$WORK" && find . | sort)"

# A legacy layout (home symlink plus symlinked skills inside the state dir)
# migrates to real dirs without losing config; the redundant home link goes.
rm -rf "$OC_ROOT"
mkdir -p "$OC_ROOT"
printf '%s' '{"mcp":{}}' > "$OC_ROOT/opencode.json"
ln -sfn "$OC_ROOT" "$T3_HOME/.config/opencode"
mkdir -p "$WORK/shared-skills"
ln -sfn "$WORK/shared-skills" "$OC_ROOT/skills"
MOUNTED=""
persist_agent_credentials
[ ! -e "$T3_HOME/.config/opencode" ] && ok "a redundant home OpenCode link is removed" || no "a redundant home OpenCode link is removed"
[ -d "$OC_ROOT/skills" ] && [ ! -L "$OC_ROOT/skills" ] && ok "a symlinked OpenCode skills dir becomes real" || no "a symlinked OpenCode skills dir becomes real"
is "OpenCode config survives the migration" '{"mcp":{}}' "$(cat "$OC_ROOT/opencode.json")"

# A host-managed config dir is left where it is, symlinks and all.
rm -rf "$OC_ROOT/skills"
ln -sfn "$WORK/shared-skills" "$OC_ROOT/skills"
MOUNTED="$OC_ROOT"
persist_agent_credentials
[ -L "$OC_ROOT/skills" ] && ok "a mounted OpenCode config is respected" || no "a mounted OpenCode config is respected"
MOUNTED=""

# The normal deployment mounts state separately from home. That mount must
# not be mistaken for an independently mounted, host-managed config directory.
rm -rf "$OC_ROOT/skills"
ln -sfn "$WORK/shared-skills" "$OC_ROOT/skills"
MOUNTED="$T3CODE_HOME"
persist_agent_credentials
[ -d "$OC_ROOT/skills" ] && [ ! -L "$OC_ROOT/skills" ] && ok "a separate state mount still gets repaired" || no "a separate state mount still gets repaired"
MOUNTED=""

# Real config directories from before persistence was introduced also migrate,
# including agents/plugins, with their source preserved as a migration backup.
mkdir -p "$T3_HOME/.config/opencode/plugins" "$T3_HOME/.config/opencode/agents"
printf '%s' 'local plugin' > "$T3_HOME/.config/opencode/plugins/own.js"
printf '%s' 'local agent' > "$T3_HOME/.config/opencode/agents/review.md"
persist_agent_credentials
is "a real legacy config keeps its plugins" 'local plugin' "$(cat "$OC_ROOT/plugins/own.js")"
is "a real legacy config keeps its agents" 'local agent' "$(cat "$OC_ROOT/agents/review.md")"
[ -d "$T3_HOME/.config/opencode.t3-migrated" ] && ok "the real legacy directory is backed up" || no "the real legacy directory is backed up"

# A host's native config mount must remain the *effective* path, rather than
# being bypassed by exporting a new, empty state-volume directory.
unset OPENCODE_CONFIG_DIR
mkdir -p "$T3_HOME/.config/opencode"
printf '%s' '{"username":"host"}' > "$T3_HOME/.config/opencode/opencode.json"
MOUNTED="$T3_HOME/.config"
configure_opencode_config
persist_agent_credentials
is "a native config mount remains effective" "$T3_HOME/.config/opencode" "$OPENCODE_CONFIG_DIR"
is "host config contents stay unchanged" '{"username":"host"}' "$(cat "$OPENCODE_CONFIG_DIR/opencode.json")"
[ ! -e "$OPENCODE_CONFIG_DIR/skills" ] && ok "a mounted native config is not normalized" || no "a mounted native config is not normalized"
MOUNTED=""

OPENCODE_CONFIG_DIR=".custom/opencode" configure_opencode_config
is "relative explicit overrides resolve against home" "$T3_HOME/.custom/opencode" "$(OPENCODE_CONFIG_DIR=.custom/opencode opencode_config_root)"
unset OPENCODE_CONFIG_DIR
T3_PERSIST_AGENT_CREDENTIALS=0 configure_opencode_config
is "disabled persistence uses the native config directory" "$T3_HOME/.config/opencode" "$OPENCODE_CONFIG_DIR"
OPENCODE_CONFIG_DIR="$OC_ROOT"

# Shared skills mounted through their parent remain where the host mounted them.
rm "$T3_HOME/.agents/skills"
mkdir -p "$T3_HOME/.agents/skills/mounted"
printf '%s' 'Host skill' > "$T3_HOME/.agents/skills/mounted/SKILL.md"
MOUNTED="$T3_HOME/.agents"
persist_agent_credentials
[ ! -L "$T3_HOME/.agents/skills" ] && ok "a mounted .agents parent is respected" || no "a mounted .agents parent is respected"
is "mounted shared files remain intact" 'Host skill' "$(cat "$T3_HOME/.agents/skills/mounted/SKILL.md")"

# An absent Claude config must not become a broken persistence link.
rm -rf "$T3_HOME" "$T3CODE_HOME"
mkdir -p "$T3_HOME" "$T3CODE_HOME"
MOUNTED=""
persist_agent_credentials
is "a fresh Claude config starts as valid JSON" '{}' "$(cat "$T3_HOME/.claude.json")"
is "a fresh Claude config is private" '600' "$(stat -c '%a' "$STORE/.claude.json")"

# Turned off: nothing moves.
rm -rf "$T3_HOME" "$T3CODE_HOME"
mkdir -p "$T3_HOME" "$T3CODE_HOME"
printf '[user]\n\tname = Ana\n' > "$T3_HOME/.gitconfig"
T3_PERSIST_AGENT_CREDENTIALS=0 persist_agent_credentials
[ -f "$T3_HOME/.gitconfig" ] && [ ! -L "$T3_HOME/.gitconfig" ] && [ ! -e "$STORE" ] && ok "T3_PERSIST_AGENT_CREDENTIALS=0 leaves everything" || no "T3_PERSIST_AGENT_CREDENTIALS=0 leaves everything"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
