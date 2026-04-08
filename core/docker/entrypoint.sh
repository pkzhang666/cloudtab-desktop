#!/usr/bin/env bash
# entrypoint.sh — Runs as PID 2 under dumb-init.
# Parses RESOLUTION into RESOLUTION_WIDTH/HEIGHT so supervisord programs
# can reference %(ENV_RESOLUTION_WIDTH)s without users managing three variables.
set -euo pipefail

# ── Parse RESOLUTION (WxHxD) and derive display/window geometry ───────────────
: "${RESOLUTION:=1920x1080x24}"
# WINDOW_OFFSET_Y shifts Chrome down to avoid top clipping in some host/browser combos.
# EXTRA_HEIGHT_PX is kept for backward compatibility.
: "${WINDOW_OFFSET_Y:=${EXTRA_HEIGHT_PX:-30}}"

RESOLUTION_WIDTH=$(echo "$RESOLUTION"  | cut -dx -f1)
RESOLUTION_HEIGHT=$(echo "$RESOLUTION" | cut -dx -f2)
RESOLUTION_DEPTH=$(echo "$RESOLUTION"  | cut -dx -f3)

if ! echo "$RESOLUTION_WIDTH"  | grep -qE '^[0-9]+$' || \
   ! echo "$RESOLUTION_HEIGHT" | grep -qE '^[0-9]+$' || \
   ! echo "$RESOLUTION_DEPTH"  | grep -qE '^[0-9]+$'; then
  echo "ERROR: RESOLUTION='$RESOLUTION' is not valid. Expected format: WxHxD (e.g. 1920x1080x24)" >&2
  exit 1
fi

if ! echo "$WINDOW_OFFSET_Y" | grep -qE '^[0-9]+$'; then
  echo "ERROR: WINDOW_OFFSET_Y='$WINDOW_OFFSET_Y' must be a non-negative integer." >&2
  exit 1
fi

XVFB_HEIGHT=$((RESOLUTION_HEIGHT + WINDOW_OFFSET_Y))
XVFB_RESOLUTION="${RESOLUTION_WIDTH}x${XVFB_HEIGHT}x${RESOLUTION_DEPTH}"

export RESOLUTION_WIDTH RESOLUTION_HEIGHT WINDOW_OFFSET_Y XVFB_RESOLUTION

exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf
