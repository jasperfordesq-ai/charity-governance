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
below. The durable dispatcher and suspended maintenance replay core are described below;
runtime integration and independent custody/host-loss proof remain open.
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
The existing KMS adapter remains pinned to one configured key. The explicit
historical-key router below retains that boundary while composing configured
delegates. The integrated transport fixture uses synthetic provider responses
and does not prove real multi-key KMS custody.

V2 has its own reserved append/history method and explicit journal kind. Generic
append and format1 publication cannot bypass the reservation. Candidate verification
distinguishes absent, exactly pending and already head-published entries; only the
published predecessor prefix counts as prior evidence. Lost publication acknowledgements
resume the exact original candidate and metadata without another head write.
The slot stays occupied. These functions neither upload a missing candidate nor
release the operation, run provider deletion, restore SQL, establish physical host
loss readiness or authorise reopening. All corresponding authority flags stay false.

Durable one-use upload, original progress/acknowledgement and version-specific slot
release are implemented in the metadata coordinator described below. V2
maintenance replay core is described below. Runtime integration and the complete
provider/whole-backend/custody demonstration remain required before activation. There is no new route,
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


## Explicit historical KMS routing

`KmsRecoveryDataKeyRing` snapshots one exact current Ireland key ARN and up to31
unique historical key ARNs. It rejects duplicate, malformed and out-of-region
configuration and requires explicit credentials. `generate` accepts only the
current key; `unwrap` routes only to the originally named configured key and
passes the original installation, organisation, operation, writer epoch and
source revision unchanged. No recovered record, provider response, alias or
ambient credential selection can add a key or trigger fallback to another key.
The original single-key adapter remains unchanged.

Each delegate retains its pinned endpoint, exact provider key/context checks,
bounded deadline, no automatic retry, sanitised errors and clearing of SDK
plaintext buffers, including late/rejected responses. Caller-owned key buffers
still require clearing after use; the existing archive codec does that. The ring
neither caches plaintext keys nor activates provider accounts or permissions.

The integrated mixed-history fixture now traverses the actual S3 adapter and KMS
router/delegates using isolated synthetic SDK responses. Five dedicated ring
tests cover current-only generation, original-context unwrap, copied bounded
configuration, unknown/old generation refusal, invalid provider key response,
no fallback, timeout cancellation and late-buffer clearing. They do not verify
live AWS IAM, key availability, independent custody or host-loss recovery.

Provider policy must independently enforce the intended separation: generation
for the current key and decrypt-only access to retained historical keys. This is
an operating requirement, not a claim that IAM has been configured. Do not delete
historical wrapping keys while retained recovery evidence still needs them.

Official AWS references checked16October2026:

- [GenerateDataKey](https://docs.aws.amazon.com/kms/latest/APIReference/API_GenerateDataKey.html)
  documents the separate generation permission, exact matching encryption context
  for subsequent decryption and prompt removal of plaintext data keys.
- [Decrypt](https://docs.aws.amazon.com/kms/latest/APIReference/API_Decrypt.html)
  documents decrypt permission and original key/context binding.
- [Deleting KMS keys](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html)
  explains the recovery consequence of deleting keys needed by ciphertext.

The software decision is to apply that separation explicitly. Source allowlists
are not substitutes for provider IAM, protected policy custody or tested recovery.
The V2 metadata dispatcher below implements durable upload/progress/
acknowledgement/release. The maintenance replay core is described below. Runtime integration and the
managed whole-backend/provider/host-loss demonstration remain open.


Router verification: API TypeScript build passed; all22 focused ring, single-key
KMS and mixed-prefix tests passed; all3348 ordinary API tests passed with zero
skips. Secrets/static-analysis scanned1580 files and control-byte checks1564
source files, all passed. Manual staged review and whitespace checks passed.
No SQL/model/restore inventory or runtime entry point changed, so the preceding
separately dated full/native gates were not rerun for this provider-router-only
increment. Exact hosted checks, live permissions/custody and deployment remain
separate evidence requirements.


## Durable V2 metadata dispatcher, progress and acknowledgement

`ConfluenceExecutionV2Dispatcher` joins the immutable original/candidate stores,
trusted writer/key policy, prefix verification, reservation, upload-attempt guard,
publication and progress observations. It never recaptures source or generates
new keys. Only the caller receiving a fresh committed attempt insert may call
create. Lost attempt acknowledgement or a missing object after uncertain upload
requires read-only reconciliation; no automatic second create or timeout unlock.
The local candidate reader used before upload is explicitly separate from the
provider reader and does not count as independent object-presence evidence.
Historical readers retain their provider object's receiver/prototype.

Current local Owner and original candidate checks repeat around asynchronous
proofs and before control changes and archive creation; no database lock spans IO.
Journal publication can leave pending metadata on interruption. This coordinator
does not provide an atomic database/provider transaction or all-writer fencing.
Before creating, the dispatcher reauthenticates the prefix and refuses if its
entry is already pending or published. A regression test first reproduced an
unwanted create after publication changed during a missing-object read. Both V1
and V2 creation paths now refuse that case. This bounds the observed race; it is
not proof of all-writer isolation or of a cross-provider transaction.

`ConfluenceExecutionV2ProgressStore` records PUBLISHED and ACKNOWLEDGED separately
in the existing immutable progress table. Each retry reauthenticates the original
candidate and current full prefix; an old local receipt cannot substitute for a
missing archive. ACKNOWLEDGED requires its committed matching PUBLISHED receipt
and an independently observed empty slot. All local persistence retains the
active Owner, tenant, original candidate, WAL/isolation and append-only guards.
The existing SQL guards are format-neutral; no migration, table or restore-format
change was needed. That increment retained schema194 and recovery inventory format15. The later
forward migration195 below adds replay functions without changing that inventory.

`acknowledgeConfluenceExecutionV2Archive` verifies the exact original body digest,
full supported prefix and unchanged current control. A separate
`releaseConfluenceExecutionV2Control` adapter clears only its exact V2 archive
head, operation, preparation and envelope digest with conditional replacement.
V1 archive, decision-state and disposal releases cannot clear it. A lost release
acknowledgement is reconciled by reauthenticating the same archive and unchanged
identity with an empty slot; a newly acquired slot is never cleared. Release
means acknowledgement of metadata, not provider deletion or safe reopening.

The disposable PostgreSQL extension executes actual capture/candidate, attempt
and progress commits under the restricted runtime role. New clients reconcile
lost upload, entry, head and release responses plus actual attempt/progress commit
acknowledgement loss. Races leave one attempt/create; unknown absent uploads stay
quarantined. Owner transfer during a provider read completes with a500ms SQL lock
timeout and prevents creation, proving that the observer did not hold Owner locks
across that IO. Completed progress remains immutable; removing the fake object
still refuses despite local receipts. These new tenants begin with empty eleven-
group source histories; the joined earlier proof separately captures populated
execution groups and compares their original bytes. Neither proof is live AWS,
Confluence deletion, independent custody or physical source-host loss.

Synthetic S3 integration verifies conditional V2 release, cross-version refusal,
unknown release readback, reauthentication after an empty slot and refusal to
clear a later operation. Unit cases also cover corrupt receipts/candidates,
revocation, competing dispatchers, unsupported pending suffixes and lost state.
All action/current-history/custody/reopening/transport authority flags remain
false. There is no route, worker, user-facing execution button or operator recovery
activation in this increment. The suspended V2 maintenance core is described below; runtime integration and
complete provider/whole-backend/custody/host-loss evidence remain required.


Dispatcher verification: the local full repository gate passed shared62/web576/
API3383/native PostgreSQL14, production1264 (7 reported skips), personal-server164
and local-Docker45. A final populated-execution journey was then added; the
rebuilt ordinary API suite passed3384 with zero skips, preserving original claim,
request and outcome bytes through the complete metadata flow. The final joined
native proof passed with both PUBLISHED and ACKNOWLEDGED commit-response loss,
one-use attempt races, revocation during IO and immutable progress/attempt rows.
Secrets/static-analysis scanned1589 files and control-byte checks1573 files, all
passed. Manual staged review passed. These local/synthetic results do not replace
exact hosted checks, runtime deployment or real provider/custody/host-loss proof.


## V2 maintenance replay core (inactive)

Forward migration `20261016190000_confluence_execution_v2_maintenance_replay`
adds separate `ConfluenceExecutionV2Recovery_assert/rows/replay` functions.
Existing V1 functions, stored bytes and migration checksums remain unchanged.
No model/table or restore-inventory change: source now has195 migrations and
restore format15 remains authoritative. Future release guards must expect195.

SQL requires the invoker to own all eleven tables, a suspended organisation,
origin replication role, Read Committed, durable WAL settings, exclusive source
table locks and the sole database client. Client checks run before and after
non-waiting row/table locks so an old lock-holding client is refused promptly. User guards must have their exact
names, enabled state, expected function and BEFORE/event/row shape. Internal FK
triggers must remain enabled and constraints validated. Reads preflight each
group's row count and aggregate size before materialising bodies. Functions have
fixed identifiers/search paths and PUBLIC execution is revoked; no runtime grant
or SECURITY DEFINER path is added.

`buildConfluenceExecutionV2ReconciliationPlan` compares a bounded older local
subset with the authenticated original eleven-group archive. Every retained row
must match exactly; local-only/later evidence is neither dropped nor overwritten.
The proposal inserts only missing originals in dependency/revision order. A local
subset may be missing parents; that does not justify inventing facts or ignoring
extra fields/groups. Proposal flags are not authentication and provide no action,
transport, custody or reopening authority.

`replayConfluenceExecutionV2Rows` snapshots its binding/policy, reads original
local rows and authenticates the complete current V2 prefix. Any occupied operation
slot refuses replay. In one maintenance transaction, SQL compares the exact fresh
local snapshot, pauses only eleven named row guards and inserts exact typed
original rows. FK, unique, CHECK and no-truncate protections remain. Typed field,
timestamp and readback equality is required, then guards are reenabled and checked.
The coordinator verifies complete reconciliation and reauthenticates the archive
and unchanged control before commit. The bounded five-minute transaction limit
accommodates the prefix reader's own120-second processing bound; it is not a
throughput or recovery-time guarantee for maximum-size datasets. Late SQL, head or archive loss rolls back
all groups. An unknown commit response retries fresh independent evidence and
inserts zero when original rows already committed; it never manufactures receipts
or recreates a missing archive.

The joined disposable PostgreSQL proof creates a separate synthetic tenant via
supported review/scope/permission, claim/request/outcome and publication services.
All eleven source groups are populated. Outcomes are originally reported under
the restricted runtime role, then restored under the maintenance owner with the
original role/timestamps/identity preserved. The real durable V2 dispatcher also
populates all four transport groups before the older-source fixture. Replay
preserves those four groups byte-for-byte without claiming their reconciliation.

Native cases restore eleven original records, roll back after SQL/head/archive
failure, lose an actual PostgreSQL commit response and reconcile through a new
client with zero inserts. Missing archives still refuse after local recovery.
Active/runtime callers, non-origin replication, wrong isolation/WAL, a second
client, disabled guards, wrong trigger event/function and unvalidated constraints
refuse. Contradictory outcomes and later unarchived requests are preserved rather
than replaced or deleted. Original document bytes and deletion state are untouched.

These are local synthetic maintenance proofs. They do not establish physical
old-writer fencing, independent provider/key custody, whole-application or missing
transport restoration, managed-backend availability or safe reopening. No operator
installer/recovery command, route, worker, provider deletion or live policy change
is activated by this core. Those integration and provider/host-loss gates remain
part of the full goal.


Final replay-core verification: complete repository gate PASS shared62/web576/
API3406/native PostgreSQL14, production1264 (7 reported skips), personal-server164
and local-Docker45. Retention-policy gate PASS4/4; byte-authority native gate PASS.
The populated eleven-group proof passes with exact original readback, three late
rollbacks, fresh-client unknown-commit retry and zero duplicate inserts. Its final
lock-holding-client test refuses within1.5 seconds, and a runtime role remains
refused even with temporary synthetic execute grants. Migration lint has zero
blocked/warned/override/exemption results. Secrets/SAST1595 files and control-byte
checks1579 files passed. All proof targets are disposable/synthetic; no live host,
provider deletion, IAM provisioning, custody or whole-backend recovery is certified.
