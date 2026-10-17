## 17 October: real-window/new-parent/common archive native cohort

The [combined native integration](managed-common-native-integration.md) now calls
the actual common parent with its original closed control, real TLS window/full
source proof, SDK crypto/custody and durable root journal. Success plus lost root,
report and request ACK cases use fresh live-head discovery without supplied IDs/
pin; originals/holder are unavailable to the fresh reader. Actual cloud custody,
full source-VM loss/current authority and production supervision remain open.

# Managed common-candidate journal and root discovery

17 October 2026. Internal source and synthetic tests; no deployment/provider
activation or tenant policy change. Full delegated goal active. Further personal
Nikita review optional.

## Original request and saved root reference

Common captures use binding format3/MANAGED_QUARANTINED_COMMON_CAPTURE_V3 and an
explicit archive configuration digest in addition to original installation,
source, epoch, attempt, plan, control revision, capture/window/journal digests and
candidate ID. The original conditional request and exact readback precede source
preparation and capture. Existing format2 file-only requests/reports are unchanged.

The common report stores capture/window/snapshot evidence and a V2 archive pin
plus its original prepared-root version. Its state is PREPARED_ROOT_REFERENCE_ONLY;
finalPublicationAcknowledgementReconstructed stays false. The report is written
and originally acknowledged before the final root write. Thus unknown final-root
ACK or process loss can leave a discoverable original pin without inventing ACK,
re-executing capture or automatically publishing a missing final root.

Both versions reuse the existing immutable candidate namespace and strict bounded
request/report store. Format/kind/binding pairs are explicit; a legacy report
cannot silently become a common one. The common pin must match installation,
source SHA, capture configuration and object observation time. Complete snapshot/
window binding and captured file/object equality are checked before serialization.
Unknown request/report outcomes keep quarantine, with no replay lease from saved
observations. Local original-ACK permission is cleared on every acknowledged run's
exit, including failure.

## Managed parent ordering

`captureCommonQuarantined` verifies storage scope, component/archive configuration,
the actual original protocol9 closed head/plan/epoch, supported current inspection
and the saved hash-matched plan descriptor. It obtains the original request ACK,
then uses `runWithSnapshot`. The trusted source callback receives the ephemeral
snapshot and cancellation signal, prepares genuine database proof/custody and
supplies an actual file visitor plus a callback to complete index/custody input.
Callback references are snapshotted before awaiting file capture.

After the window completes, the parent validates its full evidence, rechecks the
head/inspection, completes archive input, calls the actual archive's
prepareImported and stagePrepared, and journals the common root reference.
Only original report ACK plus another unchanged-head check allow publishPrepared.
It then independently reads/verifies the discovered root and rechecks the head.
Uncertain outcomes never advance control, repair/publish from saved observations,
reopen, restore into live data or grant admission.

## Trusted bootstrap and fresh reads

The existing live-head/plan bootstrap and bounded repeated candidate catalogue
now dispatch both stored versions. Common report summaries expose the saved root
pin/prepared version and expected archive digest, not entire inventories.
No additional head, guessed candidate ID or parallel authority ledger is created.

`verifyDiscoveredCommonRoot` first matches an independently configured archive's
digest, then reads exact original request/report and verifies the actual final
V2 archive using that archive's trusted configuration. It requires the signed
completed interval to match the candidate and compares the canonical captured
object inventory hash, not merely counts. The root verifier exposes its signed
object inventory hash for that check. A missing root, wrong archive configuration,
changed interval or same-count substituted bytes cannot count as success.

The result keeps originalAcknowledgementReconstructed,
savedObservationAuthorizesExecution, archivedSetAdmitted and actionAuthorized
false. A verified immutable historical root is not a current policy/reopen grant.
A fresh reader needs trusted storage/control/epoch floor and archive configuration;
it must not derive trust roots from the first returned candidate.

## Evidence and remaining integration

Focused tests use the actual original coordinator/journal/capture classes with
explicit synthetic window/archive dependencies. They cover ACK ordering, replay
refusal, unknown final/root/report ACK, current bootstrap learning the pin,
archive/interval/binding/time/state substitution and object inventory mismatch.
The [combined native integration](managed-common-native-integration.md) now runs
the actual new parent with real TLS window, full helper and actual SDK crypto/
archive callbacks in its original closed-control cohort. It checks success,
unknown root/report/request ACK, learned original root reference and fresh
verification with local originals removed. Maintenance source SHA and original
installation/storage/credential scope match instead of weakening matchers.

Complete supported production source runner/supervision/cancellation/crash/orphan
lifecycle, independently current preservation/disposal authority, actual provider
identity/privileges/writer exclusions, immutable root/key/epoch custody, full app
quarantine/replacement/repeated epochs and actual independent provider/source-host-
loss/guarded reopening proof. Existing catalogue limitations on complete/deleted
history, cross-page atomicity and monotonic authority remain unchanged.
