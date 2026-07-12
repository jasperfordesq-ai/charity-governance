#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

usage() {
  cat <<'EOF'
CharityPilot private Linux server installer (testing profile)

Usage:
  bash scripts/Install-CharityPilot.sh \
    --owner-email owner@example.org \
    --owner-name "Owner Name" \
    --organisation-name "Charity Name" \
    [--origin http://localhost:8080] [--port 8080] [--state-root /absolute/path]

  bash scripts/Install-CharityPilot.sh --preflight-only [--port 8080] [--state-root /absolute/path]

This installer is for a dedicated non-root operator on an x86-64 Linux host.
It binds Caddy to loopback only. Private director access is added separately
through the host's exact Tailscale HTTPS origin; never expose the Caddy port.
EOF
}

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
owner_email=''
owner_name=''
organisation_name=''
origin=''
port='8080'
state_root="${XDG_DATA_HOME:-$HOME/.local/share}/charitypilot/personal-server"
preflight_only=false

while (($#)); do
  case "$1" in
    --owner-email) owner_email="${2:?--owner-email requires a value}"; shift 2 ;;
    --owner-name) owner_name="${2:?--owner-name requires a value}"; shift 2 ;;
    --organisation-name) organisation_name="${2:?--organisation-name requires a value}"; shift 2 ;;
    --origin) origin="${2:?--origin requires a value}"; shift 2 ;;
    --port) port="${2:?--port requires a value}"; shift 2 ;;
    --state-root) state_root="${2:?--state-root requires a value}"; shift 2 ;;
    --preflight-only) preflight_only=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$state_root" != /* ]]; then
  printf '%s\n' '--state-root must be absolute.' >&2
  exit 2
fi
if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
  printf '%s\n' '--port must be between 1 and 65535.' >&2
  exit 2
fi
origin="${origin:-http://localhost:$port}"

node "$repository_root/scripts/personal-server-linux-preflight.mjs" \
  "--repository-root=$repository_root" \
  "--state-root=$state_root" \
  "--port=$port"

if $preflight_only; then
  printf 'Linux preflight passed. No installation state was created.\n'
  exit 0
fi
if [[ -z "$owner_email" || -z "$owner_name" || -z "$organisation_name" ]]; then
  printf '%s\n' '--owner-email, --owner-name and --organisation-name are required.' >&2
  exit 2
fi

pointer_root="${XDG_STATE_HOME:-$HOME/.local/state}/charitypilot"
pointer_path="$pointer_root/personal-server-location.json"
environment_path="$state_root/.env.personal-server"
recovery_root="$state_root/recovery"
recovery_key="$state_root/recovery-key.hex"
health_report="$state_root/initial-runtime-health.json"
install_state="$state_root/install-state.json"
revision="$(git -C "$repository_root" rev-parse HEAD)"
failed=false

write_state() {
  local phase="$1"
  local failed_from="${2:-}"
  PHASE="$phase" FAILED_FROM="$failed_from" STATE_PATH="$install_state" \
    SOURCE_ROOT="$repository_root" REVISION="$revision" ORIGIN="$origin" PORT="$port" \
    STATE_ROOT="$state_root" RECOVERY_ROOT="$recovery_root" ENVIRONMENT_PATH="$environment_path" \
    RECOVERY_KEY_PATH="$recovery_key" POINTER_PATH="$pointer_path" node --input-type=module <<'NODE'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
const now = new Date().toISOString();
let value;
try { value = JSON.parse(readFileSync(process.env.STATE_PATH, 'utf8')); } catch { value = null; }
value = value ?? {
  format: 'charitypilot-personal-server-install-state/v1',
  installationMode: 'fresh-install',
  hostProfile: 'private-linux-server',
  startedAt: now,
  sourceRoot: process.env.SOURCE_ROOT,
  source: {
    kind: 'git', revision: process.env.REVISION, fingerprint: null, branch: 'master',
    canonicalRemote: true, canonicalTrackingRef: true,
    originMasterRevision: process.env.REVISION, verifiedArchive: null, releaseIdentity: null,
  },
  activeImageTag: 'local',
  origin: process.env.ORIGIN,
  port: Number(process.env.PORT),
  stateRoot: process.env.STATE_ROOT,
  recoveryRoot: process.env.RECOVERY_ROOT,
  environmentPath: process.env.ENVIRONMENT_PATH,
  recoveryKeyPath: process.env.RECOVERY_KEY_PATH,
  locationPointerPath: process.env.POINTER_PATH,
  restoreOperation: null,
};
value.phase = process.env.PHASE;
value.updatedAt = now;
if (process.env.FAILED_FROM) {
  value.failedFromPhase = process.env.FAILED_FROM;
  value.failedAt = now;
} else {
  delete value.failedFromPhase;
  delete value.failedAt;
}
writeFileSync(process.env.STATE_PATH, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
chmodSync(process.env.STATE_PATH, 0o600);
NODE
}

fail_install() {
  local exit_code=$?
  trap - ERR INT TERM
  failed=true
  npm --prefix "$repository_root" run personal:server:stop >/dev/null 2>&1 || true
  if [[ -f "$install_state" ]]; then
    local previous_phase
    previous_phase="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).phase)}catch{}" "$install_state")"
    write_state failed "${previous_phase:-initializing}" || true
  fi
  printf 'Installation failed safely. State and Docker resources were preserved at %s.\n' "$state_root" >&2
  exit "$exit_code"
}
trap fail_install ERR INT TERM

mkdir -p "$state_root" "$recovery_root" "$pointer_root"
chmod 700 "$state_root" "$recovery_root" "$pointer_root"
export CHARITYPILOT_PERSONAL_SERVER_ENV_FILE="$environment_path"

POINTER_PATH="$pointer_path" STATE_ROOT="$state_root" ENVIRONMENT_PATH="$environment_path" node --input-type=module <<'NODE'
import { writeFileSync, chmodSync } from 'node:fs';
const value = {
  format: 'charitypilot-personal-server-location/v1',
  hostProfile: 'private-linux-server',
  stateRoot: process.env.STATE_ROOT,
  environmentPath: process.env.ENVIRONMENT_PATH,
  createdAt: new Date().toISOString(),
};
writeFileSync(process.env.POINTER_PATH, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
chmodSync(process.env.POINTER_PATH, 0o600);
NODE

RECOVERY_KEY="$recovery_key" node --input-type=module <<'NODE'
import { randomBytes } from 'node:crypto';
import { writeFileSync, chmodSync } from 'node:fs';
writeFileSync(process.env.RECOVERY_KEY, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
chmodSync(process.env.RECOVERY_KEY, 0o600);
NODE

write_state initializing
npm --prefix "$repository_root" run personal:server:init -- \
  "--owner-email=$owner_email" \
  "--owner-name=$owner_name" \
  "--organisation-name=$organisation_name" \
  "--origin=$origin" \
  "--port=$port"
chmod 600 "$environment_path" "$recovery_key" "$install_state" "$pointer_path"
write_state initialized-backup-pending

before_count="$(find "$recovery_root" -mindepth 1 -maxdepth 1 -type d -name 'personal-server-*' | wc -l)"
npm --prefix "$repository_root" run personal:server:backup
after_count="$(find "$recovery_root" -mindepth 1 -maxdepth 1 -type d -name 'personal-server-*' | wc -l)"
if ((after_count != before_count + 1)); then
  printf '%s\n' 'The installer could not identify exactly one newly completed recovery set.' >&2
  false
fi
recovery_set="$(find "$recovery_root" -mindepth 1 -maxdepth 1 -type d -name 'personal-server-*' -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)"
npm --prefix "$repository_root" run personal:server:rehearse-restore -- "--recovery-set=$recovery_set"

if [[ "$origin" == http://localhost:* || "$origin" == http://127.0.0.1:* ]]; then
  npm --prefix "$repository_root" run personal:server:certify -- \
    "--env-file=$environment_path" "--report-file=$health_report" --local-only
else
  npm --prefix "$repository_root" run personal:server:certify -- \
    "--env-file=$environment_path" "--report-file=$health_report"
fi
chmod 600 "$health_report"
write_state ready
trap - ERR INT TERM

printf '\nCharityPilot private Linux server installed and verified.\n'
printf 'Local address: %s\n' "$origin"
printf 'Protected state: %s\n' "$state_root"
printf 'Keep %s separately from off-host recovery sets.\n' "$recovery_key"
