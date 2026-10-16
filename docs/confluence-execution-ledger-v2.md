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

The initial codec/capture increment did not change persisted guards. The later
persistence increment below adds explicit V2 validation while retaining V1
behaviour. V1 publisher/replay functions remain closed to execution history
until version-aware publication/replay has its own evidence.


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

The V1 publisher and maintenance replay remain V1-only. Persisted capture and
candidate guards now distinguish formats as described below. The actual independent
object adapter, mixed-version prefix/current-head authentication and suspended
maintenance replay remain required stages2–4. Do not feed V2 to the V1 pipeline, treat the codec as an operator recovery
entry point, or claim provider/transport/whole-backend/host-loss completion.


## Durable originals and encrypted candidates

`ConfluenceExecutionV2CaptureStore.prepare` accepts only the declared context and
original predecessor-control observation. Actor/tenant come from the internal
trusted caller. It repeats current active-Owner/tenant checks and persists the
complete original eleven-group body, digest and binding in the same Repeatable
Read transaction. A retry with an existing operation identity returns its original
committed bytes; changed actor/binding/context is refused, never recaptured.

`ConfluenceExecutionV2CandidateStore.prepare` reads that original, obtains a data
key and encrypts outside database locks, then repeats Owner/source-binding checks
in a second transaction. Only its committed winning ciphertext can be returned.
An existing candidate is authenticated and reused; it is never silently resealed.
Revocation while obtaining a key prevents a new candidate from being persisted.
These operations do not upload, reserve or publish an archive.

The forward `20261016170000_confluence_execution_v2_persistence` migration reuses
the existing immutable capture/candidate tables. Version1 keeps its eight-group
contract and refusal when claims would be omitted. Version2 must match all eleven
actual source groups and its exact original envelope context/version. Actor, WAL,
isolation, bounds, timestamp, hash, recovery-binding and append-only checks remain.
Earlier migration checksums and stored records are unchanged. Schema194 does not
change the restore inventory: format15 already hashes both transport tables in full.

A capture is a consistent MVCC view. Its clock stamp does not establish that no
concurrent writer committed later. Independent current-head authentication and
supported all-writer fencing are still required before any dispatch or reopening.
Original bytes cannot be substituted for that freshness proof.

The joined native database proof loses actual capture/candidate commit responses
and resumes through new clients, races candidate preparations with one committed
row, refuses omitted source records and cross-version metadata in direct SQL,
retains immutable originals, and refuses a candidate after an atomic Owner transfer
during key generation. Fixture keys are synthetic and external writes remain zero.
This is local persistence/reconciliation evidence, not provider custody or host loss.
