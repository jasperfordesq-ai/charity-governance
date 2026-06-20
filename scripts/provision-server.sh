#!/usr/bin/env bash
#
# Prepare a fresh Ubuntu/Debian server to run the CharityPilot production stack:
# installs Docker Engine + the Compose plugin and opens the firewall for SSH (22),
# HTTP (80), and HTTPS (443). Idempotent and safe to re-run.
#
# REVIEW THIS SCRIPT BEFORE RUNNING — it makes system-level changes.
# Run as root on the target server:
#   sudo bash scripts/provision-server.sh
#
# After it finishes: copy the repo (and your .env.production) to the server, then
# deploy with TLS per docs/LAUNCH-GUIDE.md Step 4.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (e.g. sudo bash scripts/provision-server.sh)." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script targets Ubuntu/Debian (apt). Install Docker manually on other systems:" >&2
  echo "  https://docs.docker.com/engine/install/" >&2
  exit 1
fi

echo "==> Installing Docker Engine + Compose plugin (if not already present)"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "    Docker and the Compose plugin are already installed; skipping."
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.asc ]; then
    . /etc/os-release
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" \
      > /etc/apt/sources.list.d/docker.list
  fi
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

echo "==> Configuring the firewall (ufw)"
if ! command -v ufw >/dev/null 2>&1; then
  apt-get install -y ufw
fi
# IMPORTANT: allow SSH BEFORE enabling ufw, or you can lock yourself out.
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (Let's Encrypt + redirect to HTTPS)
ufw allow 443/tcp   # HTTPS
ufw allow 443/udp   # HTTP/3
ufw --force enable
ufw status verbose || true

echo ""
echo "==> Done. This server can now run the CharityPilot stack."
echo "    Next (see docs/LAUNCH-GUIDE.md Step 4):"
echo "      1. Point DNS A records for your web + api domains at this server's IP."
echo "      2. Copy the repo and your filled .env.production here."
echo "      3. docker compose --env-file .env.production \\"
echo "           -f compose.production.yml -f compose.production-tls.yml up -d"
echo "    Caddy will obtain HTTPS certificates automatically."
