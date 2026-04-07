#!/usr/bin/env bash
# check-chrome-update.sh — Runs ON THE VM (via gcloud compute ssh bash -s).
# Compares the Chrome version in the running container against the latest
# available in Google's apt repo. Rebuilds the Docker image if they differ.
set -euo pipefail

BLUE='\033[36m'; GREEN='\033[32m'; YELLOW='\033[33m'; NC='\033[0m'
REMOTE_DIR=/opt/novnc-chrome

# ── Get container ID for the running service ──────────────────────────────────
CONTAINER=$(cd "$REMOTE_DIR" && sudo docker compose ps -q novnc-chrome 2>/dev/null | head -1 || true)

if [ -z "$CONTAINER" ]; then
  printf "${YELLOW}⚠ Container not running — skipping Chrome update check.${NC}\n"
  exit 0
fi

# ── Installed version (from running container) ────────────────────────────────
INSTALLED=$(sudo docker exec "$CONTAINER" \
  google-chrome-stable --version 2>/dev/null \
  | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' || true)

if [ -z "$INSTALLED" ]; then
  printf "${YELLOW}⚠ Could not read Chrome version from container — skipping.${NC}\n"
  exit 0
fi

# ── Latest available version (from Google's apt repo metadata) ────────────────
# Fetches Packages.gz — the same source apt uses — no apt-get update needed.
LATEST=$(curl -fsSL --max-time 15 \
  "https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-amd64/Packages.gz" \
  | zcat 2>/dev/null \
  | grep -A10 "^Package: google-chrome-stable$" \
  | grep "^Version:" \
  | head -1 \
  | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
  || true)

if [ -z "$LATEST" ]; then
  printf "${YELLOW}⚠ Could not reach Google apt repo — skipping update check.${NC}\n"
  exit 0
fi

printf "  Installed : %s\n" "$INSTALLED"
printf "  Available : %s\n" "$LATEST"

# ── Compare and rebuild if needed ─────────────────────────────────────────────
if [ "$INSTALLED" = "$LATEST" ]; then
  printf "${GREEN}✓ Chrome is up to date.${NC}\n"
else
  printf "${BLUE}==> Chrome update found ($INSTALLED → $LATEST). Rebuilding image...${NC}\n"
  cd "$REMOTE_DIR" && sudo docker compose up -d --build --no-deps novnc-chrome
  printf "${GREEN}✓ Chrome updated to $LATEST. Container restarted.${NC}\n"
fi
