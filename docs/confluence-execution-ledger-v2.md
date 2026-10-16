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
candidate guards distinguish formats as described below. Separate V2 object
transport and mixed-version publication/current-head verification are implemented
below. Durable upload coordination and suspended maintenance replay remain open.
Do not feed V2 to the V1 pipeline, treat the codec as an operator recovery entry
point, or claim provider/transport/whole-backend/host-loss completion.


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


## V2 object transport (not activated)

`S3AuthorityObjectStore.readExecutionLedgerV2/createExecutionLedgerV2` use the
separate `confluence-execution-ledger-v2/{installation}/{organisation}/{epoch}/{operation}.json`
namespace. Existing V1 keys and decoders are unchanged. Validated full context
must match the V2 header, including source, operation, epoch and configured replay
key; structural header inspection does not authenticate ciphertext or history.
The coordinator must still open the envelope against its original binding.

This adapter reuses the fixed Ireland endpoint, explicit credentials, expected
bucket owner, storage KMS binding, checksum, version metadata, bounded strict-UTF8
stream and deadlines. Writes are conditional create-if-absent; conflict returns
false, unknown write outcome throws without retry, and missing reads never create.
Storage encryption and envelope wrapping keys remain separate.

Five synthetic SDK transport tests cover exact paths/headers, scope and version
substitution, epoch isolation, missing objects, inconsistent metadata, conditional
conflict and uncertain writes. They do not call AWS or prove actual independent
custody. No runtime entry point activates V2 upload. Durable one-use attempts,
fresh authenticated mixed-version prefix/publication, maintenance replay and
provider/host-loss proof remain required; do not wire the pre-publication helper
directly to a route or worker.


Local verification for this adapter: API TypeScript build; seven focused
codec/transport tests; all 3,330 ordinary API tests with zero failures/skips;
secret/static-analysis scans of 1,577 files and control-byte scan of 1,561 source
files. The separate native migration fixtures were not rerun for this
transport-only increment (no SQL/model/restore-inventory change); the preceding
persistence increment's full/native results remain separately dated evidence.
Manual review checked normalized full-context comparison, legacy separation,
conditional-write failure handling, no network retry and no activation path.
Hosted verification and provider evidence remain separate.


## Mixed-version V2 publication and observed-head verification

`confluence-execution-v2-prefix.ts` supplies a separate current-head reader,
candidate verifier and verified publisher. It traverses the complete supported
journal prefix rather than filtering unrelated kinds. Unsupported protocols,
missing objects, changed heads, foreign pending suffixes, contradictory receipts
and processing/byte limits refuse verification. Published decision captures,
original plaintext, plan/key/writer/predecessor and receipt digests must agree.
Successive archives preserve every earlier immutable row; once a V2 archive
appears, a later V1 archive is refused, including when execution groups would be
empty in a proposed downgrade. Claimed/requested/reported history is retained
without converting it into provider execution, absence or erasure evidence.

The caller supplies an explicitly trusted, ordered writer-epoch/key policy from
independent operator custody. Each call snapshots that policy before asynchronous
reads, so later mutation cannot add an accepted candidate key mid-verification.
It must cover each original context, disallow epoch
regression and end at the observed current writer. Historical source/key/epoch
fields remain original. This is not a mechanism for adopting a policy from a
backup or authorising a writer takeover. Production custody/provisioning of the
policy is still an integration requirement. The legacy V1 progression checker
remains single-epoch; a named V2 historical checker permits only nondecreasing
original epochs and retains canonical bytes, exact hash lineage and immutable
record checks. It supplies no authority to change writers.

The S3 historical readers retain original key/source headers. They check scope,
operation, version and, for V2, the epoch locator; the prefix reader subsequently
checks trusted key policy, journal digest and authenticated original AAD. They do
not guess a source revision or silently substitute the current key. Existing V1
current-key readers and full-context V2 reader remain strict. The integrated
synthetic SDK test traverses the real S3 adapter across old/new keys and epochs,
then confirms that the legacy current-key readers still refuse old-key payloads.
No live AWS call or actual independently administered policy is implied.
The existing KMS adapter is deliberately pinned to one configured key. Before
activation, provide an explicit bounded historical-key router with current-key-only
generation and original-context unwrap; do not fall back to ambient keys or weaken
that single-key adapter. The integrated transport fixture uses synthetic key
responses and does not prove real multi-key KMS custody.

V2 has its own reserved append/history method and explicit journal kind. Generic
append and format1 publication cannot bypass the reservation. Candidate verification
distinguishes absent, exactly pending and already head-published entries; only the
published predecessor prefix counts as prior evidence. Lost publication acknowledgements
resume the exact original candidate and metadata without another head write.
The slot stays occupied. These functions neither upload a missing candidate nor
release the operation, run provider deletion, restore SQL, establish physical host
loss readiness or authorise reopening. All corresponding authority flags stay false.

Durable one-use upload, original progress/acknowledgement and version-specific slot
release remain required before activation, followed by V2 maintenance replay and
the complete provider/whole-backend/custody demonstration. There is no new route,
worker, operator recovery command or live provider action in this increment.


Verification for this publication increment includes mixed epoch/key history,
same-epoch key rotation, policy mutation during reads, exact original row
conservation, missing historical data, version downgrade, changed heads,
unsupported/pending suffixes, different ciphertext, generic publication bypass,
no-release semantics and exact lost-head-acknowledgement reconciliation. The
integrated SDK case exercises historical object lookup through the actual S3
adapter; keys and heads are synthetic. Local test completion and exact hosted
release results are recorded separately in the ignored continuation checkpoint.


The local full repository gate passed shared62/web576/API3342/native PostgreSQL14,
production1264 (7 reported skips), personal-server164 and local-Docker45. A final
policy-snapshot hardening then passed a rebuilt ordinary API suite of3343 with
zero skips, plus a fresh joined native PostgreSQL recovery proof. Source security
scans and manual staged review passed. The full repository result predates only
that final prefix-local policy-snapshot change; the final API/native results cover
it. These are local/synthetic results, not hosted CI, deployment or provider proof.
