# Managed capture catalogue diagnostic

`jobs:preflight-managed-capture-window` exposes the existing read-only
`ManagedStorageDatabaseInventory.observeCaptureWindowCompatibility` observation
as a bounded operator command. Use it alongside `jobs:preflight-managed-database`
before considering a real provider's role/capture-window trial.

## Invocation and input

Build the API, then supply a protected JSON object on stdin to:

```text
node apps/api/dist/jobs/preflight-managed-capture-window.js --stdin
```

The package script supplies `--stdin` itself. Keep the credential-bearing input
out of command arguments, chat, logs and tracked files. The operator supplies:

- `format: 1` and an explicit `databaseUrl` with `sslmode=verify-full` and
  `target_session_attrs=read-write`; optionally supply the reviewed CA file.
- `configuration`: exact database name/OID, observer name/OID, capture role
  name/OID and one to sixteen relation schema/name/OID entries, following the
  existing [inventory contract](managed-storage-database-inventory.md).
- `expectedConfigurationDigest`: SHA-256 of that separately reviewed configuration
  as normalised by the inventory service. A digest supplied by the caller is not
  independent approval or provider identity proof.

Input is strict, bounded to 16 KiB and valid UTF-8. Unknown fields, extra command
arguments, mismatched observer/database, unsafe or duplicate connection parameters
and a changed configuration digest refuse before connecting. The command uses
only its explicit target, not an ambient application database. It adds a bounded
connection timeout if omitted and uses the shared strict Prisma TLS transport.

## Meaning of the result

The service checks PostgreSQL 16, encrypted connection, exact database/observer
identity and read-only transaction state. Within its bounded transaction it
observes ACL predicates for the eight fixed privilege catalogues. It does not
execute `LOCK TABLE`, role changes, schema/data writes, capture callbacks,
provider API actions, session termination or reopening.

Exit 0 reports `ACL_PREDICATES_PRESENT`; exit 2 reports `ACL_PREDICATES_MISSING`.
Exit 1 is a fixed refusal with no diagnostic result. Provider, parse, TLS and
cleanup failures do not expose exception details or reconstruct a success.

The output allowlist contains configuration/observation digests, observation time,
status and missing catalogue names. It explicitly keeps actual locks, active
privilege window, provider compatibility, all-writer inventory, whole-backend
quiescence and execution/action authority **false**. No source-release or direct
endpoint attestation is issued. A good ACL observation is a prerequisite for a
separately authorised actual lock window, not proof that one can be held while
the provider is active or that a recovery capture is safe.

Here, the false lock/window fields mean no capture-window `SHARE` lock was
acquired or attested. Ordinary PostgreSQL read transactions can take implicit
read locks; the diagnostic does not claim a lock-free query or zero impact.

This command does not select a database supplier or authorise a paid trial.
Actual provider observations, exact-release execution, independently held
decisions and real host-loss restoration remain separate acceptance gates.
