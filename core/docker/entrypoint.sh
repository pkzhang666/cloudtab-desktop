#!/usr/bin/env bash
# entrypoint.sh — Runs as PID 2 under dumb-init.
# Parses RESOLUTION into RESOLUTION_WIDTH/HEIGHT so supervisord programs
# can reference %(ENV_RESOLUTION_WIDTH)s without users managing three variables.
set -euo pipefail

# ── Parse RESOLUTION (WxHxD) into WIDTH and HEIGHT ────────────────────────────
: "${RESOLUTION:=1920x1080x24}"

RESOLUTION_WIDTH=$(echo "$RESOLUTION"  | cut -dx -f1)
RESOLUTION_HEIGHT=$(echo "$RESOLUTION" | cut -dx -f2)

if ! echo "$RESOLUTION_WIDTH"  | grep -qE '^[0-9]+$' || \
   ! echo "$RESOLUTION_HEIGHT" | grep -qE '^[0-9]+$'; then
  echo "ERROR: RESOLUTION='$RESOLUTION' is not valid. Expected format: WxHxD (e.g. 1920x1080x24)" >&2
  exit 1
fi

export RESOLUTION_WIDTH RESOLUTION_HEIGHT

exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf
