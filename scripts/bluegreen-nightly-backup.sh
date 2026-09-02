#!/usr/bin/env bash
# =============================================================================
# CharityPilot private VM — nightly backup via the blue-green engine.
#
# Runs `bluegreen:backup` (row census + pg_dump -Fc + documents tar + sha256
# manifest under .bluegreen/state/backups/<stamp>, 14-day retention pruned by
# the engine itself) and logs the outcome. Replaces the appliance-era
# ~/bin/charitypilot-backup.sh — `--install-cron` removes that entry.
#
# Install/replace the cron entry:  bash scripts/bluegreen-nightly-backup.sh --install-cron
# Run one backup now:              bash ~/bin/bluegreen-nightly-backup.sh
#
# Backups are ON the VM. Copy them off-host (see docs/bluegreen-runbook.md,
# "Cutting the private VM over") — a dead VM takes its backups with it.
# =============================================================================
set -euo pipefail

REPO_DIR="$HOME/charity-governance"
ENV_FILE="$REPO_DIR/.bluegreen/private-vm.env"
STATE_DIR="$REPO_DIR/.bluegreen/state"
LOG="$HOME/charitypilot-bluegreen-backup.log"
MIN_FREE_GIB=10

# cron runs with a minimal PATH; node/npm live in /usr/bin via NodeSource.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }

if [ "${1:-}" = "--install-cron" ]; then
    mkdir -p "$HOME/bin"
    install -m 700 "$0" "$HOME/bin/bluegreen-nightly-backup.sh"
    # Idempotent, and retires the appliance's entry in the same edit.
    ( crontab -l 2>/dev/null | grep -v 'charitypilot-backup.sh' | grep -v 'bluegreen-nightly-backup.sh' || true
      echo "30 3 * * * $HOME/bin/bluegreen-nightly-backup.sh >/dev/null 2>&1" ) | crontab -
    echo "Installed: $HOME/bin/bluegreen-nightly-backup.sh"
    echo "Cron now:"
    crontab -l
    exit 0
fi

log '--- backup run starting ---'

if [ ! -f "$ENV_FILE" ]; then
    log "FAIL: env file missing at $ENV_FILE"
    exit 1
fi

mkdir -p "$STATE_DIR"
free_gib=$(df -BG --output=avail "$STATE_DIR" | tail -1 | tr -dc '0-9')
if [ "$free_gib" -lt "$MIN_FREE_GIB" ]; then
    log "WARN: only ${free_gib} GiB free on the state volume (threshold ${MIN_FREE_GIB} GiB)"
fi

cd "$REPO_DIR"
if npm run --silent bluegreen:backup -- --env-file "$ENV_FILE" >> "$LOG" 2>&1; then
    newest=$(ls -1dt "$STATE_DIR"/backups/*/ 2>/dev/null | head -1 || true)
    count=$(ls -1d "$STATE_DIR"/backups/*/ 2>/dev/null | wc -l || echo 0)
    log "OK: backup written and manifested. newest=${newest:-none} total_sets=${count} free=${free_gib}GiB"
else
    log 'FAIL: bluegreen:backup returned non-zero -- see output above'
    exit 1
fi
