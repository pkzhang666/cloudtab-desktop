#!/usr/bin/env bash
# dev-display.sh — Virtual desktop for running Electron on a headless VM
# Access via: gcloud compute ssh <vm> --tunnel-through-iap -- -L 6080:localhost:6080 -N
# Then open: http://localhost:6080

set -euo pipefail

DISPLAY_NUM=1
VNC_PORT=5911
NOVNC_PORT=6081
RESOLUTION="1600x900x24"
NOVNC_DIR="/opt/novnc"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[dev-display]${NC} $*"; }
success() { echo -e "${GREEN}[dev-display]${NC} $*"; }
warn()    { echo -e "${YELLOW}[dev-display]${NC} $*"; }
die()     { echo -e "${RED}[dev-display] ERROR:${NC} $*" >&2; exit 1; }

# ── Install dependencies ───────────────────────────────────────────────────────
install_deps() {
  local missing=()
  command -v Xvfb   >/dev/null 2>&1 || missing+=(xvfb)
  command -v x11vnc >/dev/null 2>&1 || missing+=(x11vnc)
  command -v fluxbox >/dev/null 2>&1 || missing+=(fluxbox)
  command -v xterm  >/dev/null 2>&1 || missing+=(xterm)
  command -v xdpyinfo >/dev/null 2>&1 || missing+=(x11-utils)
  command -v nc     >/dev/null 2>&1 || missing+=(netcat-openbsd)

  if [[ ${#missing[@]} -gt 0 ]]; then
    info "Installing: ${missing[*]}"
    sudo apt-get update -qq
    sudo apt-get install -y -qq "${missing[@]}"
  fi

  if [[ ! -d "$NOVNC_DIR" ]]; then
    info "Installing noVNC…"
    sudo git clone --depth 1 https://github.com/novnc/noVNC.git "$NOVNC_DIR"
    sudo git clone --depth 1 https://github.com/novnc/websockify.git "$NOVNC_DIR/utils/websockify"
  fi
}

# ── Kill any previous dev display ─────────────────────────────────────────────
cleanup_previous() {
  pkill -f "Xvfb :${DISPLAY_NUM}" 2>/dev/null || true
  pkill -f "x11vnc.*rfbport ${VNC_PORT}" 2>/dev/null || true
  pkill -f "novnc_proxy.*${NOVNC_PORT}" 2>/dev/null || true
  pkill -f "fluxbox" 2>/dev/null || true
  rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"
  sleep 1
}

# ── Start virtual display ──────────────────────────────────────────────────────
start_xvfb() {
  info "Starting Xvfb on :${DISPLAY_NUM} (${RESOLUTION})"
  Xvfb ":${DISPLAY_NUM}" -screen 0 "${RESOLUTION}" -ac +extension GLX +render -noreset &
  local xvfb_pid=$!
  # Wait until the display is ready
  local retries=0
  until DISPLAY=":${DISPLAY_NUM}" xdpyinfo >/dev/null 2>&1; do
    sleep 0.5
    (( retries++ )) && [[ $retries -gt 20 ]] && die "Xvfb failed to start"
  done
  success "Xvfb running (PID $xvfb_pid)"
}

start_wm() {
  info "Starting Fluxbox window manager"
  DISPLAY=":${DISPLAY_NUM}" fluxbox >/dev/null 2>&1 &
  sleep 1
}

start_xterm() {
  info "Starting xterm (project terminal)"
  local project_dir
  project_dir="$(cd "$(dirname "$0")" && pwd)"
  DISPLAY=":${DISPLAY_NUM}" xterm \
    -fa 'Monospace' -fs 13 \
    -title 'CloudTab Dev' \
    -geometry 180x40+0+0 \
    -e bash -c "cd '${project_dir}' && bash" &
  sleep 0.5
}

start_vnc() {
  info "Starting x11vnc on port ${VNC_PORT} (no password for localhost-only)"
  x11vnc \
    -display ":${DISPLAY_NUM}" \
    -rfbport "${VNC_PORT}" \
    -nopw \
    -listen localhost \
    -forever \
    -shared \
    -noxrecord -noxfixes -noxdamage -noipv6 \
    >/tmp/x11vnc-dev.log 2>&1 &
  local retries=0
  until nc -z localhost "${VNC_PORT}" 2>/dev/null; do
    sleep 0.5
    (( retries++ )) && [[ $retries -gt 20 ]] && die "x11vnc failed to start"
  done
  success "x11vnc listening on localhost:${VNC_PORT}"
}

start_novnc() {
  info "Starting noVNC on port ${NOVNC_PORT}"
  "${NOVNC_DIR}/utils/novnc_proxy" \
    --vnc "localhost:${VNC_PORT}" \
    --listen "localhost:${NOVNC_PORT}" \
    --web "${NOVNC_DIR}" \
    >/tmp/novnc-dev.log 2>&1 &
  sleep 2
  success "noVNC ready"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  export DISPLAY=":${DISPLAY_NUM}"

  info "Setting up virtual desktop for Electron development…"
  install_deps
  cleanup_previous
  start_xvfb
  start_wm
  start_xterm
  start_vnc
  start_novnc

  local vm_name project_id zone
  vm_name=$(hostname)
  project_id=$(gcloud config get-value project 2>/dev/null || echo "<PROJECT_ID>")

  echo ""
  success "Virtual desktop is running!"
  echo ""
  echo -e "  ${YELLOW}Connect via IAP tunnel:${NC}"
  echo -e "  ${CYAN}gcloud compute ssh ${vm_name} --project=${project_id} --tunnel-through-iap -- -L ${NOVNC_PORT}:localhost:${NOVNC_PORT} -N${NC}"
  echo ""
  echo -e "  Then open: ${GREEN}http://localhost:${NOVNC_PORT}/vnc.html?autoconnect=true${NC}"
  echo ""
  echo -e "  ${YELLOW}In the xterm that opens, run:${NC}"
  echo -e "  ${CYAN}npm install && npm run dev${NC}"
  echo ""
  echo -e "  Press ${RED}Ctrl+C${NC} to shut down the virtual desktop"
  echo ""

  # Keep alive — kill everything on exit
  trap 'info "Shutting down…"; cleanup_previous' EXIT INT TERM
  wait
}

main "$@"
