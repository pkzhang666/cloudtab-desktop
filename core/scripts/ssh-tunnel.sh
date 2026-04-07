#!/usr/bin/env bash
# ssh-tunnel.sh — Open IAP SSH tunnel to the VM for noVNC access.
#                 Checks Chrome updates on connect.
#                 Auto-stops the VM with a countdown after the tunnel closes.
# Usage: make tunnel  (or: bash scripts/ssh-tunnel.sh <vm-name> <zone> <project-id>)

VM_NAME="${1:-novnc-chrome}"
ZONE="${2:-us-central1-a}"
PROJECT_ID="${3:-}"

BLUE='\033[36m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; BOLD='\033[1m'; NC='\033[0m'

if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
fi
if [ -z "$PROJECT_ID" ]; then
  printf "${RED}ERROR: No GCP project. Run: gcloud config set project YOUR_PROJECT_ID${NC}\n"
  exit 1
fi

# ── Check VM state ────────────────────────────────────────────────────────────
STATUS=$(gcloud compute instances describe "$VM_NAME" \
  --zone="$ZONE" --project="$PROJECT_ID" \
  --format="value(status)" 2>/dev/null || echo "NOT_FOUND")

if [ "$STATUS" = "NOT_FOUND" ]; then
  printf "${RED}ERROR: VM '$VM_NAME' not found. Run 'make tf-apply' first.${NC}\n"
  exit 1
fi

if [ "$STATUS" = "TERMINATED" ] || [ "$STATUS" = "STOPPED" ]; then
  printf "${YELLOW}VM is stopped. Starting it...${NC}\n"
  gcloud compute instances start "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" --quiet
  printf "${YELLOW}Waiting for VM to be ready (30s)...${NC}\n"
  sleep 30
fi

# ── Chrome update check ───────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
printf "\n${BLUE}==> Checking Chrome version...${NC}\n"
gcloud compute ssh "$VM_NAME" \
  --zone="$ZONE" --project="$PROJECT_ID" \
  --tunnel-through-iap \
  --command="bash -s" < "$SCRIPT_DIR/check-chrome-update.sh" \
  || printf "${YELLOW}⚠ Chrome update check failed (non-critical, continuing).${NC}\n"

# ── Open tunnel ───────────────────────────────────────────────────────────────
printf "\n${BOLD}noVNC IAP Tunnel${NC}\n"
printf "  VM      : %s (%s)\n" "$VM_NAME" "$ZONE"
printf "  Tunnel  : localhost:8080 → VM:8080\n"
printf "  Browser : ${BLUE}http://localhost:8080${NC}\n"
printf "\n  Press ${YELLOW}Ctrl+C${NC} to close the tunnel.\n\n"

gcloud compute ssh "$VM_NAME" \
  --zone="$ZONE" \
  --project="$PROJECT_ID" \
  --tunnel-through-iap \
  -- -L 8080:localhost:8080 -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  || true

# ── Tunnel closed — auto-stop with cancellable countdown ─────────────────────
# Pressing Ctrl+C during the countdown calls shutdown_cancelled(), which prints
# a message and exits 0 immediately — the VM stop command never runs.
shutdown_cancelled() {
  printf "\r                              \r"
  printf "${YELLOW}Shutdown cancelled — VM is still running.${NC}\n"
  printf "Stop manually: ${BLUE}make vm-stop${NC}\n\n"
  exit 0
}

printf "\n${YELLOW}Tunnel closed.${NC}\n"
printf "Stopping VM in ${BOLD}10 seconds${NC}... (press ${YELLOW}Ctrl+C${NC} to keep it running)\n"

trap 'shutdown_cancelled' INT TERM

for i in $(seq 10 -1 1); do
  printf "\r  %2ds remaining...  " "$i"
  sleep 1
done

trap - INT TERM  # restore default signal handling

printf "\r                         \r"
printf "${BLUE}==> Stopping VM ${VM_NAME}...${NC}\n"
gcloud compute instances stop "$VM_NAME" \
  --zone="$ZONE" --project="$PROJECT_ID" --quiet
printf "${GREEN}VM stopped. Disk is preserved.${NC}\n"
printf "Restart with: ${BLUE}make tunnel${NC} (auto-starts VM) or ${BLUE}make vm-start${NC}\n\n"
