# Confluence execution ledger V2

## Scope and sequencing

V2 must preserve the original eight decision/publication groups plus immutable
execution claims, quarantined request intents and application-reported outcomes.
Legacy V1 decoders must reject V2 rather than silently dropping those groups.
Original row fields and canonical body bytes must survive encryption/readback.
Capture must use one Owner-scoped Repeatable Read transaction, fixed identifiers,
preflight size/count limits and explicit declared source/installation context.

Use a distinct format/kind and AEAD domain for V2 envelopes. Bind source, tenant,
installation, operation, writer epoch, key ID, predecessor control and wrapped key.
An unkeyed digest or caller-declared binding is not independent current authority.
No raw provider errors, credentials or inferred erasure facts are accepted.

Implementation sequence:

1. Strict eleven-group validation, bounded atomic capture and V2 archive codec.
2. Durable original capture/candidate storage and independent object adapter.
3. Authenticated mixed-version prefix conservation, reservation/publication and
   current-head readback. Reject version downgrade that omits execution evidence.
4. Suspended sole-client maintenance replay of original eleven-group records,
   preserving guards and refusing conflicting or later local history.
5. Integrate fresh one-use preparation, independent preservation and the provider
   coordinator. Receipt lookup cannot authorise another destructive call after
   interruption; an acknowledged request does not prove absence or all copies.
6. Provider, custody, transport-state and source-host-unavailable demonstrations.

V2 is not a name for the entire application backup. The four transport/outbox
record groups, full business-data/document bytes, current control, custody and
old-writer fencing still need their separately specified recovery proof. No
provider activation, global history or reopening authority follows from step1.

The initial codec/capture work does not change the V1 persisted capture guard or
wire V2 into the existing V1 publisher/replay functions. Those remain closed to
execution history until the later steps have their own evidence.


## Current source capability and proof limits

Step1 is implemented by `confluence-execution-ledger-v2.ts` and
`confluence-execution-archive-v2.ts`. The eleven-group body keeps historical
capture epochs original (and refuses epochs ahead of its declared writer).
This uses a named historical validation frame; the legacy V1 reader retains
its strict current-epoch behaviour. Each capture still validates its original
facts, identity and lineage; no synthetic validation frame is stored as history.

Five focused tests cover group/link/time/context/flag and capacity refusal,
original epochs, encryption-domain separation, exact bytes, key-buffer clearing,
post-write acknowledgement loss and expected-digest reads that cannot recreate a
missing object. The joined real PostgreSQL proof captures the populated eleven
groups under the restricted runtime role and actual Repeatable Read, compares
original claim/request/outcome rows and encrypts/decrypts the exact body.

The native fixture initially used another installation identity and was refused;
it now derives the declared installation/source/epoch from its existing synthetic
history. Neither validator nor source guards were weakened. Fixture keys and
objects are synthetic, not real KMS/S3 custody or source-attested authority.

The persisted V1 capture guard, V1 publisher and V1 maintenance replay are unchanged.
V2 durable capture/candidate storage, actual independent object adapter, mixed-version
prefix/current-head authentication and suspended maintenance replay remain stages
2–4 above. Do not feed V2 to the V1 pipeline, treat the codec as an operator recovery
entry point, or claim provider/transport/whole-backend/host-loss completion.
