# Production runtime database credentials

This describes the strict hosted-production source contract. It does not certify
a host, provision a provider or apply to the separate private personal-server
installers. Hosting approval, protected configuration, database grants, actual
release/image checks and DPO acceptance remain separate gates.

## Configuration and custody

The protected maintenance environment keeps the canonical PostgreSQL URL with
`sslmode=verify-full` and `target_session_attrs=read-write`. It names a separate
protected runtime environment through the absolute
`CHARITYPILOT_PRODUCTION_APP_ENV_FILE` selector. That runtime file has the same
reviewed non-database application settings and a distinct restricted database
role/password on the same host, port, database and CA. It must omit the selector,
maintenance/executor settings and unneeded release-image metadata. Do not copy
the maintenance password into other runtime values.

The environment generator is a scaffold, not a runtime-file or grant
provisioner. Prepare and review both files before deployment preflight. Current
execution requires verified owner-only POSIX file permissions; Windows content
dry-run is not ACL certification and unverified execution is refused. Custom
CA files need separately reviewed protection and container availability. This
slice does not configure those mounts or certify provider custody.

Guarded transport checks exact file identity/bytes throughout cutover. A change
requires a new review. Prisma consumers get an explicit strict TLS transport;
libpq backup/restore keeps the canonical URL. Credential maps and expanded
Compose output contain secrets and must not enter public evidence.

## Mandatory Compose overlay

Normal preflight, deploy, rollback delegation and failed-migration recovery use
`compose.production.yml` plus `compose.production.roles.yml`, and the TLS overlay
when selected. There is no role-overlay opt-out. The roles overlay completely
replaces the API environment file, preserves ordinary-worker allowlists and
supplies the restricted runtime URL. Migration/root-secret-rotation duties keep
their explicitly classified maintenance input.

Compose **2.24.4 or later** is required for the explicit `!override` replacement.
Older versions must fail preflight; never replace it with an append/merge or a
maintenance fallback. See [Docker's merge specification](https://docs.docker.com/reference/compose-file/merge/).

The base file remains only a building block and a compatible emergency
`down --remove-orphans` configuration. It does not need derived runtime secrets
to stop the same Compose project. **Never use base-only `up` or `run`**. Use the
guarded lifecycle commands; TLS-overlay opt-out does not disable role separation.

## Runtime role verification

After pulling the selected API image, deployment runs `runtime-role-check`
before downtime. This one-off service receives only its restricted database
URL and mode settings, with no API signing secrets or maintenance environment
file. A bounded stdin message supplies reviewed role/database metadata and the
phase. The job opens a fresh strict-TLS client, performs read-only catalogue
verification and disconnects before returning a minimal versioned receipt.

Pre-migration may permit absent later schema objects but must reject unsafe
privileges on those present. After migration/status, the same job requires the
named protected tables and maintenance functions. Both receipt phases must
match exactly; missing, malformed or ambiguous evidence refuses startup. A
failed first check leaves the existing runtime running. A failed second check
keeps it stopped and retains the pre-migration backup/recovery posture.

The selected API image must contain the probe job and this protocol. Older
images without it cannot silently skip verification; test a compatible/backported
image before proposing a rollback. Current orchestration mocks do not prove old
image compatibility, an actual deployed role or a successful provider restore.

These checks verify the stated catalogue contract, not every function body,
complete migration correctness, all application grants or permanent protection
against later privileged changes. Grant provisioning/reconciliation and positive
application access after migration still require reviewed provider-specific
evidence; the verifier never creates roles, grants access or repairs an elevated
login. The ordinary application readiness/smoke and acceptance gates remain.

## Verification commands

After installing the repository dependencies:

```text
npm run test:production-runtime-role
```

This builds the API and runs the role, transport, effective-Compose and real
synthetic PostgreSQL/TLS fixtures. Docker with the verified local endpoint and
OpenSSL are required. Fixtures use temporary data/certificates and remove their
exact containers/directories; they do not contact a production database.

Passing local tests is not remote CI, a rebuilt Linux image, approved hosting,
host-boundary certification, live acceptance or Nikita's review.
