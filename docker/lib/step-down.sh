# shellcheck shell=bash
# Shared privilege step-down for the image entrypoint and every docker/bin
# helper. Sourced, never executed: the PATH reset below runs inline in the
# caller, so `inherited_path`, `$0` and `"$@"` all stay the caller's own.
#
# Root runs nothing through the PATH it was handed: under `docker exec` that is
# the container's own, which a container recreated from an older image may have
# carried over (see the entrypoint). The step-down gives it back to t3.
inherited_path="$PATH"
[ "$EUID" -ne 0 ] || PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# `docker exec` lands as root (the image sets no USER so the entrypoint can
# remap uids). Step down so nothing here leaves root-owned files in the state
# directory. The entrypoint sources this with T3_STEP_DOWN_DEFER=1: its
# privileged half adopts the volumes first and steps down later, so it takes
# only the PATH reset above.
if [ "${T3_STEP_DOWN_DEFER:-0}" != 1 ] && [ "$EUID" -eq 0 ] \
  && command -v gosu >/dev/null 2>&1 && id t3 >/dev/null 2>&1; then
  exec env PATH="$inherited_path" "$(command -v gosu)" t3 "$0" "$@"
fi
