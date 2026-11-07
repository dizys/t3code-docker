#!/bin/sh
# Only ssh reads this output; it never passes through the helper's stdout.
# The password itself never enters the environment: only this file's path
# does, so /proc/<pid>/environ and any grandchildren stay free of it.
printf '%s\n' "$(cat "$T3_CREDENTIAL_PASSWORD_FILE")"
