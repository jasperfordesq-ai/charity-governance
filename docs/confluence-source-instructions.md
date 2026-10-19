# Instructions for an authoritative Confluence source

## Current increment

This is an internal compatibility foundation, not an available dashboard
workflow. No HTTP creation/withdrawal route or instruction form is enabled.
Follow-up reports and the complete synthetic browser journey remain to be built.

The instruction service records a current charity Owner's assessment for one
exact citation, with controlled authority, retention, administrator and evidence
references, an intended Trash/purge action and an operational follow-up date.
The target may be a standalone source or an existing Vault citation. An
instruction never creates a file, publication, storage job, provider mutation or
external message, and never establishes legal disposal authority by itself.

Original-request retries preserve the issued record. Withdrawal appends a
separate event; historical read-back exposes it without rewriting or
reactivating the original. Current caller authorization remains mandatory after
unciting or disconnecting. Input and target digests are validated when receipts
are read, including after JSON object-key reordering in PostgreSQL.

## Persistence and recovery

The existing append-only SecurityAuditEvent history carries typed instruction,
withdrawal and future follow-up events. Enum additions commit separately before
their first SQL use. New indexes enforce request identity and one withdrawal per
instruction. The insert guard checks active same-charity ownership, the live
citation target, original withdrawal identity and the recovery-enforcement
freeze. Existing user-subject constraints remain in force.

No durable table or alternate decision store is introduced. Existing recovery
capture includes the audit table; native tests also restore instruction and
withdrawal events and recheck immutability/recovery refusal. This is component
restore evidence, not independently current history or physical-host recovery.

## Delivery order and remaining work

Deploy and verify the compatible Prisma enum, audit-feed and UI readers before
exposing any creation route that can write these values. The currently serving
older Prisma client cannot be assumed to decode a new audit enum value.
Keep historical citation V1 reports with instruction:null unchanged.

Then add the separately versioned instruction-linked follow-up report, Owner
web-session routes, bounded history/discovery and reviewed UI. Test lost-response
retry, withdrawal, role/site/target changes, observation uncertainty and the
synthetic zero-file journey. An operator's action report must remain distinct
from a fresh GET-only provider observation. A page not observed does not prove
permanent erasure of attachments, versions or backups.

Actual provider deletion, current sandbox disconnect and independent current
decision/key custody remain separate open requirements.

## Local verification commands

```powershell
npm.cmd run db:generate --workspace @charitypilot/api
npm.cmd test --workspace @charitypilot/api
npm.cmd run test:retention-policy
```

The retention command includes the isolated native PostgreSQL source-instruction
migration test. It verifies upgrade, tenant/target and original-request guards,
withdrawal uniqueness, preserved legacy subjects and restored history without
creating application files or deletion jobs.
