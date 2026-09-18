#!/bin/sh
# Starts the built static frontend in the background and opens the local browser.
set -eu
cd "$(dirname "$0")" || exit 1
exec node scripts/open-workbench.mjs
