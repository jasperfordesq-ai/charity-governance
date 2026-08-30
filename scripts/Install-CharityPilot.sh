#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

usage() {
  cat <<'EOF'
CharityPilot private Linux server installer (testing profile)

Fresh install:
  bash scripts/Install-CharityPilot.sh \
    --owner-email owner@example.org \
    --owner-name "Owner Name" \
    --organisation-name "Charity Name" \
    [--origin http://localhost:8080] [--port 8080] [--state-root /absolute/path]

Preflight only:
  bash scripts/Install-CharityPilot.sh --preflight-only [--port 8080] [--state-root /absolute/path]

Replacement-host restore (rebuild a lost host from a recovery set):
  # 1. discover the exact confirmation string, changing nothing:
  bash scripts/Install-CharityPilot.sh --preflight-only \
    --restore-recovery-set /absolute/path/to/personal-server-<id> \
    --recovery-key-file /absolute/path/to/recovery-key.hex \
    --source-origin https://old-host.example.ts.net \
    [--origin https://new-host.example.ts.net] [--port 8080]

  # 2. run it, passing that confirmation back verbatim:
  bash scripts/Install-CharityPilot.sh \
    --restore-recovery-set /absolute/path/to/personal-server-<id> \
    --recovery-key-file /absolute/path/to/recovery-key.hex \
    --source-origin https://old-host.example.ts.net \
    --origin https://new-host.example.ts.net \
    --confirm 'RESTORE-CHARITYPILOT-PERSONAL-SERVER:...' \
    [--owner-email owner@example.org --owner-password-file /absolute/path]

This installer is for a dedicated non-root operator on an x86-64 Linux host.
It binds Caddy to loopback only. Private director access is added separately
through the host's exact Tailscale HTTPS origin; never expose the Caddy port.

A replacement-host restore requires a CLEAN host: empty state root, no location
pointer, no personal-server Docker resources. It rotates the database, JWT,
auth-recovery and readiness secrets and revokes every restored session. Account
passwords are not reset.
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
restore_recovery_set=''
recovery_key_file=''
source_origin=''
confirm=''
owner_password_file=''

while (($#)); do
  case "$1" in
    --owner-email) owner_email="${2:?--owner-email requires a value}"; shift 2 ;;
    --owner-name) owner_name="${2:?--owner-name requires a value}"; shift 2 ;;
    --organisation-name) organisation_name="${2:?--organisation-name requires a value}"; shift 2 ;;
    --origin) origin="${2:?--origin requires a value}"; shift 2 ;;
    --port) port="${2:?--port requires a value}"; shift 2 ;;
    --state-root) state_root="${2:?--state-root requires a value}"; shift 2 ;;
    --preflight-only) preflight_only=true; shift ;;
    --restore-recovery-set) restore_recovery_set="${2:?--restore-recovery-set requires a value}"; shift 2 ;;
    --recovery-key-file) recovery_key_file="${2:?--recovery-key-file requires a value}"; shift 2 ;;
    --source-origin) source_origin="${2:?--source-origin requires a value}"; shift 2 ;;
    --confirm) confirm="${2:?--confirm requires a value}"; shift 2 ;;
    --owner-password-file) owner_password_file="${2:?--owner-password-file requires a value}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

replacement_restore=false
[[ -n "$restore_recovery_set" ]] && replacement_restore=true

die() { printf '%s\n' "$1" >&2; exit 2; }

# ── argument validation ──────────────────────────────────────────────────────
if ! $replacement_restore; then
  for pair in "--recovery-key-file:$recovery_key_file" "--source-origin:$source_origin" \
              "--confirm:$confirm" "--owner-password-file:$owner_password_file"; do
    [[ -n "${pair#*:}" ]] && die "${pair%%:*} is valid only with --restore-recovery-set."
  done
fi
if $replacement_restore; then
  [[ -n "$recovery_key_file" && -n "$source_origin" ]] \
    || die 'Replacement-host restore requires --recovery-key-file and --source-origin.'
  if ! $preflight_only && [[ -z "$confirm" ]]; then
    die 'Replacement-host restore requires the exact --confirm value printed by a prior --preflight-only run.'
  fi
  [[ -z "$owner_password_file" || -n "$owner_email" ]] \
    || die '--owner-password-file requires --owner-email.'

  # One real directory, not a symlink, and a small regular key file.
  [[ -d "$restore_recovery_set" && ! -L "$restore_recovery_set" ]] \
    || die '--restore-recovery-set must identify one real non-symlink recovery-set directory.'
  [[ -f "$recovery_key_file" && ! -L "$recovery_key_file" ]] \
    || die '--recovery-key-file must identify one real non-symlink file.'
  (( $(stat -c %s "$recovery_key_file") <= 1024 )) \
    || die '--recovery-key-file is too large to be a recovery key.'
  grep -qiE '^[0-9a-f]{64}$' <<<"$(tr -d '[:space:]' <"$recovery_key_file")" \
    || die 'The supplied recovery key must contain exactly 64 hexadecimal characters.'
  restore_recovery_set="$(cd "$restore_recovery_set" && pwd -P)"
  recovery_key_file="$(cd "$(dirname "$recovery_key_file")" && pwd -P)/$(basename "$recovery_key_file")"
  if [[ -n "$owner_password_file" ]]; then
    [[ -f "$owner_password_file" && ! -L "$owner_password_file" ]] \
      || die '--owner-password-file must identify one real non-symlink file.'
    owner_password_file="$(cd "$(dirname "$owner_password_file")" && pwd -P)/$(basename "$owner_password_file")"
  fi
fi

if [[ "$state_root" != /* ]]; then
  die '--state-root must be absolute.'
fi
if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
  die '--port must be between 1 and 65535.'
fi
origin="${origin:-http://localhost:$port}"

# ── preflight ────────────────────────────────────────────────────────────────
# The Linux preflight already requires a clean host (empty state root, no
# location pointer, no personal-server Docker resources), which is exactly the
# replacement-host precondition, so it needs no extra mode flag.
node "$repository_root/scripts/personal-server-linux-preflight.mjs" \
  "--repository-root=$repository_root" \
  "--state-root=$state_root" \
  "--port=$port"

# ── replacement-host plan: authenticate the set before any state is created ──
plan_recovery_set_id=''
plan_confirmation=''
if $replacement_restore; then
  plan_json="$(node "$repository_root/scripts/personal-server.mjs" bootstrap-restore-plan \
    "--recovery-set=$restore_recovery_set" \
    "--source-origin=$source_origin" \
    "--origin=$origin" \
    "--port=$port" \
    "--encryption-key-file=$recovery_key_file")" || {
      printf '%s\n' 'Replacement-host recovery-set, key, origin, or exact source verification failed. No installation state was created.' >&2
      exit 1
    }

  # Validate the plan describes exactly what was asked for.
  mapfile -t plan_fields < <(
    PLAN="$plan_json" EXPECT_PATH="$restore_recovery_set" \
    EXPECT_SOURCE="$source_origin" EXPECT_TARGET="$origin" node --input-type=module <<'NODE'
let plan;
try { plan = JSON.parse(process.env.PLAN); }
catch { console.error('Replacement-host recovery plan did not return valid JSON.'); process.exit(1); }
if (plan.format !== 'charitypilot-personal-replacement-restore-plan/v1' ||
    plan.recoverySetPath !== process.env.EXPECT_PATH ||
    plan.sourceOrigin !== process.env.EXPECT_SOURCE ||
    plan.targetOrigin !== process.env.EXPECT_TARGET) {
  console.error('Replacement-host recovery plan does not match the requested path or origins.');
  process.exit(1);
}
process.stdout.write(`${plan.recoverySetId}\n${plan.confirmation}\n`);
NODE
  ) || exit 1
  plan_recovery_set_id="${plan_fields[0]}"
  plan_confirmation="${plan_fields[1]}"

  printf 'Verified replacement recovery set: %s\n' "$plan_recovery_set_id"
  printf 'Required confirmation: %s\n' "$plan_confirmation"
  printf 'The replacement will generate fresh database/JWT/auth-recovery/readiness secrets and revoke every restored session.\n'
  if ! $preflight_only && [[ "$confirm" != "$plan_confirmation" ]]; then
    printf '%s\n' 'The supplied --confirm value does not exactly match the authenticated replacement recovery plan. No installation state was created.' >&2
    exit 1
  fi
fi

if $preflight_only; then
  printf 'Linux preflight passed. No installation state was created.\n'
  exit 0
fi
if ! $replacement_restore; then
  if [[ -z "$owner_email" || -z "$owner_name" || -z "$organisation_name" ]]; then
    die '--owner-email, --owner-name and --organisation-name are required.'
  fi
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

install_mode='fresh-install'
$replacement_restore && install_mode='replacement-restore'

write_state() {
  local phase="$1"
  local failed_from="${2:-}"
  local clear_restore="${3:-}"
  PHASE="$phase" FAILED_FROM="$failed_from" STATE_PATH="$install_state" \
    SOURCE_ROOT="$repository_root" REVISION="$revision" ORIGIN="$origin" PORT="$port" \
    STATE_ROOT="$state_root" RECOVERY_ROOT="$recovery_root" ENVIRONMENT_PATH="$environment_path" \
    RECOVERY_KEY_PATH="$recovery_key" POINTER_PATH="$pointer_path" \
    INSTALL_MODE="$install_mode" CLEAR_RESTORE="$clear_restore" \
    RESTORE_SET_PATH="$restore_recovery_set" RESTORE_SET_ID="$plan_recovery_set_id" \
    RESTORE_SOURCE_ORIGIN="$source_origin" RESTORE_CONFIRMATION="$plan_confirmation" \
    node --input-type=module <<'NODE'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
const now = new Date().toISOString();
let value;
try { value = JSON.parse(readFileSync(process.env.STATE_PATH, 'utf8')); } catch { value = null; }
const replacement = process.env.INSTALL_MODE === 'replacement-restore';
value = value ?? {
  format: 'charitypilot-personal-server-install-state/v1',
  installationMode: process.env.INSTALL_MODE,
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
  restoreOperation: replacement
    ? {
      recoverySetPath: process.env.RESTORE_SET_PATH,
      recoverySetId: process.env.RESTORE_SET_ID,
      sourceOrigin: process.env.RESTORE_SOURCE_ORIGIN,
      targetOrigin: process.env.ORIGIN,
      confirmation: process.env.RESTORE_CONFIRMATION,
      secretsRotated: ['POSTGRES_PASSWORD', 'JWT_SECRET', 'AUTH_RECOVERY_SECRET', 'READINESS_API_KEY'],
      startedAt: now,
    }
    : null,
};
value.phase = process.env.PHASE;
value.updatedAt = now;
// The restore operation is a record of work in flight; a ready installation is
// an ordinary installation and must not keep claiming one is under way.
if (process.env.CLEAR_RESTORE) value.restoreOperation = null;
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

if $replacement_restore; then
  # Adopt the supplied key: the recovery set cannot be opened without the key
  # that sealed it, so a replacement host must not mint a new one.
  SUPPLIED_KEY="$recovery_key_file" RECOVERY_KEY="$recovery_key" node --input-type=module <<'NODE'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
const hex = readFileSync(process.env.SUPPLIED_KEY, 'utf8').trim().toLowerCase();
if (!/^[0-9a-f]{64}$/u.test(hex)) {
  throw new Error('The supplied recovery key must contain exactly 64 hexadecimal characters.');
}
writeFileSync(process.env.RECOVERY_KEY, `${hex}\n`, { flag: 'wx', mode: 0o600 });
chmodSync(process.env.RECOVERY_KEY, 0o600);
NODE
else
  RECOVERY_KEY="$recovery_key" node --input-type=module <<'NODE'
import { randomBytes } from 'node:crypto';
import { writeFileSync, chmodSync } from 'node:fs';
writeFileSync(process.env.RECOVERY_KEY, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
chmodSync(process.env.RECOVERY_KEY, 0o600);
NODE
fi

if $replacement_restore; then
  # bootstrap-restore refuses unless the protected state already says this is a
  # prepared replacement restore, so the state is written before it is called.
  write_state restore-prepared
  restore_arguments=(
    "--recovery-set=$restore_recovery_set"
    "--source-origin=$source_origin"
    "--origin=$origin"
    "--port=$port"
    "--confirm=$confirm"
    "--encryption-key-file=$recovery_key"
  )
  [[ -n "$owner_email" ]] && restore_arguments+=("--owner-email=$owner_email")
  [[ -n "$owner_password_file" ]] && restore_arguments+=("--owner-password-file=$owner_password_file")
  npm --prefix "$repository_root" run personal:server:bootstrap-restore -- "${restore_arguments[@]}"
else
  write_state initializing
  npm --prefix "$repository_root" run personal:server:init -- \
    "--owner-email=$owner_email" \
    "--owner-name=$owner_name" \
    "--organisation-name=$organisation_name" \
    "--origin=$origin" \
    "--port=$port"
fi
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
write_state ready '' clear
trap - ERR INT TERM

printf '\nCharityPilot private Linux server installed and verified.\n'
printf 'Local address: %s\n' "$origin"
printf 'Protected state: %s\n' "$state_root"
printf 'Keep %s separately from off-host recovery sets.\n' "$recovery_key"
if $replacement_restore; then
  printf '\nReplacement-host recovery restored recovery set %s.\n' "$plan_recovery_set_id"
  printf 'Fresh host secrets were generated and every pre-recovery session was revoked.\n'
  printf 'Account passwords were NOT reset; sign in again with the existing Owner password.\n'
else
  printf 'Store the one-time Owner password printed by initialization in the Owner password manager now.\n'
fi
