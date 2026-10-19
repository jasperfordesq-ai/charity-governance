# Instructions for an authoritative Confluence source

## Current increment

The compatibility foundation was released before enabling instruction writes.
The current source increment adds Owner web-session routes, reviewed forms,
withdrawal, linked follow-up reports and bounded history. Verification and release
of this activation are pending; source availability is not deployment evidence.

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
withdrawal and follow-up events. Enum additions commit separately before
their first SQL use. New indexes enforce request identity and one withdrawal per
instruction. The insert guard checks active same-charity ownership, the live
citation target, original withdrawal identity and the recovery-enforcement
freeze. Existing user-subject constraints remain in force.

No durable table or alternate decision store is introduced. Existing recovery
capture includes the audit table; native tests also restore instruction and
withdrawal/follow-up events and recheck immutability/recovery refusal. This is component
restore evidence, not independently current history or physical-host recovery.

## Delivery order and remaining work

Compatible Prisma enum, audit-feed and UI readers must be deployed and verified
before exposing creation routes. The compatibility release satisfies this order;
retain it as the previous reader during activation and rollback.
Keep historical citation V1 reports with instruction:null unchanged.

The separately versioned instruction-linked follow-up records the original
instruction and the withdrawal known at commit. Owner-only forms retain the
request identity after uncertain responses and offer explicit receipt lookup,
without automatically resubmitting. Paged history remains readable after unciting;
recording a fresh follow-up still requires the current citation. Event timestamps
come from a database statement after decision locks, rather than transaction-start
time. Verify lost-response lookup, withdrawal, role/site/target changes,
observation uncertainty and the complete synthetic zero-file journey before
activation. An operator's action report remains distinct from a fresh GET-only
provider observation. A page not observed does not prove
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
