#!/usr/bin/env bash
# vm-setup.sh — Verify Docker is ready on the VM (called by `make push`)
# Runs remotely via gcloud compute ssh.
set -euo pipefail

echo "==> Checking Docker..."
if ! command -v docker &>/dev/null; then
  echo "Docker not found. Waiting for startup script to finish..."
  for i in $(seq 1 12); do
    sleep 10
    command -v docker &>/dev/null && break
    echo "  Still waiting... ($((i * 10))s)"
  done
fi

sudo docker info > /dev/null 2>&1 || { echo "ERROR: Docker daemon not running"; exit 1; }
echo "==> Docker OK: $(docker --version)"

echo "==> Creating app directory..."
sudo mkdir -p /opt/novnc-chrome
# Resolve current user (USER may be unset in non-interactive SSH sessions)
_APP_USER="${USER:-${LOGNAME:-$(id -un 2>/dev/null || echo '')}}"
if [ -n "$_APP_USER" ]; then
  sudo chown "$_APP_USER:$_APP_USER" /opt/novnc-chrome
fi
sudo chmod 777 /opt/novnc-chrome

echo "==> VM ready for deployment."
