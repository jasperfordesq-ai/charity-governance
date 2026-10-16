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
Explicit CA files are now included in the protected file review: bounded UTF-8
PEM, at most32 current CA certificates, no private keys or trailing material,
POSIX protection against group/other writes, public certificate readability,
and identity/content binding throughout cutover. Use a certificate-only file
owned by the deployment operator, normally mode0644 or0444. Environment files
and keys remain owner-only. Mode0600 is unsuitable for this public CA mount
because application/migration containers run as their own user.
Changes or expiry refuse the reviewed configuration. This validates the selected
trust-anchor input, not its organisational approval or provider identity.
Guarded lifecycle commands automatically add compose.production.database-ca.yml
for an explicit CA, mounting only that reviewed file read-only at
/run/charitypilot/database-ca.pem on all eight database-consuming services.
Host URLs remain unchanged; derived container URLs use the mounted path.
The Prisma CLI environment converts its derived maintenance URL separately.
No CA overlay is selected for default/system trust. Windows permission
certification, actual Linux image/provider compatibility and custody remain
separate gates.

Guarded transport checks exact file identity/bytes throughout cutover. A change
requires a new review. Prisma consumers get an explicit strict TLS transport;
libpq backup/proof tools retain canonical TLS semantics. Their source-hashed
helper independently validates and mounts an explicit CA at the same fixed
container path, rewrites only its confidential child URL, and checks file
continuity after execution. Disposable restore targets use their existing local
connection. CA paths containing commas or quotes are refused by this Docker
transport; prepare a reviewed certificate-only path without those characters. Credential maps and expanded
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

## Grant compatibility evidence and duties

The tracked Prisma/TLS fixture now migrates a fresh disposable PostgreSQL
database through every source migration with the actual Prisma CLI. It applies
the existing blue-green grant script only inside that fixture, then uses a
fresh restricted Prisma login for ordinary tenant/Owner creation, tenant update
and user lookup. The tenant and first Owner are created in one transaction,
preserving the database's exactly-one-active-Owner constraint.

The same fixture checks the full role catalogue, explicit permission-denied
responses for no-op deletion from each of the fourteen protected tables, and
refusal of a maintenance replay entry point. A newly created ordinary table is
unavailable until reconciliation; reconciliation enables its synthetic data
operation while retaining the catalogue restrictions.

| Duty | Intended credential boundary |
| --- | --- |
| Ordinary API and scheduled application data operations | Restricted runtime login |
| Four named document-byte capabilities | Narrow reviewed function calls; no direct protected-table DML |
| Migration history and protected recovery state | Runtime read access; maintenance-only mutations |
| Confluence snapshot/replay/assert maintenance functions | Maintenance login; no runtime or PUBLIC execution |
| Inactive recovery executors that write protected state | Separate reviewed activation/executor design required |

This is local compatibility evidence for the existing grant map, not authority
to apply it to a provider or a new hosted provisioning path. The fixture uses
a synthetic PostgreSQL superuser for migrations/reconciliation; managed-provider
role-administration permissions and custody remain unproved. It does not test
every API route, all four document-byte capabilities end to end, old-data
upgrade, Linux application image, rollback or independent recovery. Do not widen
runtime grants to activate currently inactive recovery executors.

The CA transport fixture also uses an unprivileged PostgreSQL-tools container
with the real reviewed public certificate mount: file write fails, verified
TLS login succeeds, and a wrong hostname refuses. Effective Compose rendering
covers all eight mounts and the migration-only strict URL. This does not prove
an exact published Linux application image, a managed provider, full dump/restore
with that provider or a hosted deployment.

## Linux image gate

The CI and release workflows now test locally built API and migration images
before the production configuration checks and publication. Both are labelled
with the checked-out commit; the test receives immutable local image IDs. It
uses a disposable TLS PostgreSQL container with no published port and a public
CA file mounted read-only. The application and migration images run as node
with read-only root filesystems, temporary /tmp, no added capabilities and no
new privileges. It applies all source migrations with the actual Linux CLI,
checks the restricted role before/after, tests TLS/permission refusals and
performs synthetic tenant/Owner operations through the packaged factory.

For a local repeat after building both labelled Docker targets, supply
CHARITYPILOT_TEST_API_IMAGE, CHARITYPILOT_TEST_MIGRATION_IMAGE (sha256 image IDs)
and CHARITYPILOT_TEST_SOURCE_COMMIT (40-character commit), then run
npm run test:production-linux-database-images. Missing inputs fail; no skipped
claim or image-tag fallback is provided. The PostgreSQL fixture may pull only
its fixed digest when absent. Docker endpoint validation/pinning applies to
every lifecycle child. The test cleans its exact database container and
temporary certificates.

The first local receipt binds images built from763ed75a. It is not a remote CI
run, signature/registry evidence, a Linux-host permission attestation, full HTTP
acceptance, old-data upgrade, provider compatibility, or a deployed release.

## Default roots in PostgreSQL backup clients

For verify-full connections with no explicit host CA file, the proof/backup
helper now derives sslrootcert=/etc/ssl/certs/ca-certificates.crt inside its
pinned PostgreSQL-tools image. An explicit system value uses the same mapping.
The reviewed host URL remains unchanged. This keeps certificate-chain and
hostname checks enabled and avoids relying on a user's missing root.crt or a
version-specific special value. Explicit reviewed CA files keep their separate
readonly mount and integrity checks. Other/local connection modes are unchanged.

PostgreSQL describes the default user certificate file and the explicit file
parameter in its [PostgreSQL16 TLS documentation](https://www.postgresql.org/docs/16/libpq-ssl.html).
The tracked native-image gate reproduces the missing-user-root failure, then
checks trusted/untrusted default image roots, explicit system mapping and
hostname refusal. Its trust-store override contains only a synthetic public
certificate, mounted read-only in disposable clients; no host trust store is
changed. Actual provider trust compatibility and full backup/restore remain
separate acceptance checks.

A failed initial stop can have partially stopped services. Deployment therefore
records its stop attempt after the configuration guard and retries cleanup on
failure. Backup/migration/startup do not proceed. If cleanup fails, shutdown is
unverified and the operator must confirm all services stopped before recovery;
no automatic rollback or successful shutdown is asserted.

## Rollback image compatibility is more than a schema marker

The guarded rollback delegates to the same deployment checks with the selected
rollback digests. Its runtime-role probe runs from the selected API image before
stopping services and again after migration/status. A schema compatibility
attestation does not supply a missing probe job or make an older database client
compatible with the strict runtime credential/TLS contract. Missing or invalid
phase-bound probe output refuses the cutover; do not bypass the gate or give the
application maintenance credentials to make an older image start.

Before approving a release, identify an exact usable rollback image set and
prove it supports this runtime protocol, restricted application permissions,
the intended database schema and certificate transport. A reviewed compatible
backport may be necessary; adding the job alone is not proof of the other
requirements. Rehearse the exact application/migration images and relevant data
upgrade/restore path. Keep the prior schema-bound backup and its evidence.
Neither an unchanged compatibility label nor a successful dry run proves a
working rollback. The separate private blue-green profile retains its own
release and rollback contract.

The tracked rollback tests exercise the real rollback-to-deployment delegation
with synthetic files and mocked lifecycle I/O. An unavailable selected-image
probe permits the image pull but no shutdown, backup, migration or startup;
a supported phase-bound probe exercises the normal two-phase path. This is
orchestration evidence, not an actual old-image or restored-data rehearsal.

## Authenticated API version diagnostics

The API identity snapshot honours CHARITYPILOT_BUILD_REVISION when explicitly
set, otherwise uses the image CHARITYPILOT_BUILD_COMMIT stamp. Blank values
are ignored; both missing remains unknown. This is read once at process start
and does not invent a revision from the package version or working tree. The
existing signed-in health boundary is unchanged and anonymous health output
still omits build identity.

The native image gate also checks this packaged metadata against the expected
image source commit. Build the API target with CHARITYPILOT_BUILD_COMMIT as
well as its revision label; a label alone does not populate the API stamp.
These API diagnostics do not prove an installed MCP client upgrade, historical
replay cause, image signature or DPO acceptance.
