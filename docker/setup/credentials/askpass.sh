#!/bin/sh
# Only ssh reads this output; it never passes through the helper's stdout.
printf '%s\n' "$T3_CREDENTIAL_PASSWORD"
