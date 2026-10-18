# Configured read-role capture composition

18 October 2026. `ManagedReadRoleCapture` is an explicit internal configuration
joining installation/source/maintenance epoch, project/bucket, JWT subject/role,
SQL database/role/observer OIDs, both Storage metadata relations and the exact
capture/catalogue/snapshot component digests. Construction refuses mismatches
before SQL or HTTP. Configuration is copied, credentials remain private, and
configuration digests stay inspectable after the token expires.

## Combined live interval

`runWithSnapshot` acquires the catalogue privilege window first, then SHARE locks
on both `storage.buckets` and `storage.objects` and exports the original snapshot.
The source callback receives that snapshot and a combined cancellation signal.
Token lifetime and the configured 1–30 second budget bound source preparation
as well as HTTP capture. The source must import the snapshot while it remains
live and propagate cancellation. No SQL client or signer is handed to it.

The capture uses the configured asymmetric role token without server-key fallback.
After capture, both intervals must complete and their exact database/configuration
bindings must agree. Failures discard the candidate. Returned evidence retains
explicit false provider-token identity, provider/project/database identity,
complete visibility, retained privileged credential exclusion, global quiescence
and action authority. The source's opaque return value is not a root publication.

See [JWT verification](managed-capture-jwt.md), [catalogue privilege window](managed-capture-privilege-window.md)
and the existing snapshot interval contracts for their respective proof limits.
No provider grant, role/key creation, route, job, restore or reopening is enabled.

## Maintenance plan binding

When explicitly supplied to `ManagedBackendMaintenance`, this configuration
selects plan format 10 and pins `captureAuthorization` plus
`EXPLICIT_JWT_SQL_PRIVILEGE_AND_METADATA_WINDOW_V1`. The previously provisioned
format-9 READY head cannot authorise the changed plan digest. Plan bootstrap
serialization and read-only inspection recognise both exact versions.

Format 10 refuses both legacy capture entry points before network or source work.
The versioned candidate/journal/archive path for the new capture report still
needs integration; it must not coerce the report into the legacy privileged-key
format. No operator should switch a live plan until that complete path and
actual provider compatibility are verified.

The inherited maintenance policy still retains its privileged canary/control
credential. This component does not claim that credential's write authority is
excluded. Provider signing-key currency, actual deployed Storage role/release,
unfiltered RLS visibility, complete issuer/session/in-flight/control-plane fences,
independent current authority and physical-host-loss proof remain required.
Catalogue UPDATE or other broader privileges must not be granted just to make
this path available on an unsupported managed provider.
