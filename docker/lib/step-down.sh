# shellcheck shell=bash
# Explicit functions shared by the entrypoint and CLI helpers. Root callers
# source this only from its image-owned path. Checkout overrides apply after
# privilege drop, for unprivileged development and tests.
t3_reset_root_path() {
  inherited_path="$PATH"
  [ "$EUID" -ne 0 ] || PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
}

t3_step_down() {
  if [ "$EUID" -eq 0 ]; then
    if ! command -v gosu >/dev/null 2>&1 || ! id t3 >/dev/null 2>&1; then
      printf '%s\n' 'Cannot switch to the t3 account; refusing to run as root.' >&2
      exit 1
    fi
    exec env PATH="$inherited_path" "$(command -v gosu)" t3 "$@"
  fi
}
