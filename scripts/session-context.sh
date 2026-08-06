#!/bin/sh
# Compatibility wrapper. Claude SessionStart calls the portable Node script
# directly; other POSIX environments may keep using this entry point.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 0
exec node "$script_dir/session-context.mjs"
