# Complete configured TUS credential set

17 October 2026. `ManagedResumableUploadEvidence` prepares and tests one original
TUS session for **every** configured retired modern secret,1–50 credentials. It
does not acquire the parent maintenance guard, change supplier configuration or
acquire a default coordinator phase itself. The
[default protocol7 coordinator](durable-resumable-maintenance.md) now requires it
behind the acquired guard. No route, command or job activates a real supplier.

## Static scope and child identities

The factory parses/copies/sorts the full registry and supplied credentials.
Credential IDs and SHA values must be distinct, match supplied modern secrets,
and exclude the capture control. `assertStorageScope()` requires the exact full
retired-ID set, installation/project and capture key. Missing/extra/duplicate
credentials fail; the implementation never silently chooses the first.

The static configuration digest binds the registry, declared supplier release,
upload ID format, vault and evidence targets. It excludes the acquired attempt,
avoiding a circular parent plan hash. Preparation performs no provider I/O.

Each acquired parent binding and credential deterministically derives a separate
child attempt ID from a purpose-tagged SHA-256 digest, with UUIDv8 version/variant
bits. This follows [RFC9562's application-defined UUIDv8 layout](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.8),
not the UUIDv5/SHA-1 algorithm. All parent dimensions and credential identity enter
the derivation. The child keeps the parent's plan/source/epoch and receives its
own synthetic path, encrypted-location object and baseline/report objects.

**A derived ID is identity, never acquisition or acknowledgement authority.**
Only the parent's fresh acknowledged guard can authorise starting the
factory. A fresh factory can otherwise create another incomplete session before
conditional custody rejects it; the factory does not replace that guard or resume
an uncertain parent operation.

## Bounded aggregate manifests

Complete sorted child pin sets are retained as separate parent artifacts:

```text
managed-maintenance/<parent-installation>/<parent-attempt>/resumable-cohort-baseline.json
managed-maintenance/<parent-installation>/<parent-attempt>/resumable-cohort-observation.json
```

The original parent binding and static digest, exact full credential set,
deterministic child identities and correct child pin kinds are validated.
Observation also binds the original baseline-manifest SHA and child report
digests. Duplicate, missing, reordered or swapped identities refuse, including
when public hashes are recomputed.

Each manifest is limited to128KiB so fifty long child-version pins fit. Only the
new `resumable-cohort` namespace permits that transport bound. Existing child
artifact, write and signed-upload limits remain unchanged. The parent control
head is still limited to8192bytes; protocol7 stores a manifest
pin rather than embed the set. Conditional creation and exact-version readback
use the shared [evidence transport](resumable-upload-evidence-custody.md).

## Active operations and original-only inspection

`forAttempt()` builds a component set for each exact derived child:
[TUS probe](supabase-resumable-upload-proof.md),
[encrypted original-location vault](resumable-location-vault.md) and
[original baseline/report custody](resumable-upload-evidence-custody.md).

`baseline()` retains all original locations and working incomplete-upload
baselines, publishes/readbacks each child artifact, then publishes/readbacks the
complete manifest and revalidates every saved child baseline. A failed child
stops the sequence; no complete manifest is acknowledged for an incomplete set.

`verifyRefusal()` requires the original baseline-manifest pin. It reads original
child baselines, decrypts each exact original location, performs the actual valid
PATCH refusal bracketed by retained controls and publishes each original report.
Only after every configured credential passes does it acknowledge a complete
report manifest and its SHA. One still-working credential leaves the aggregate
unresolved, even if other child reports were already retained.

Both active operations are consumed per attempt object and bounded to five
minutes with cancellation propagated to child operations. Unknown child or
aggregate publication acknowledgements never permit active retry, cleanup,
replacement or compensation.

`observeBaseline()` and `observeObservation()` read only exact original manifests
and child versions. They validate actual child scope/digests and chronology;
they do not unwrap locations, make TUS requests, publish evidence, revoke keys
or invent a missing report. Child baselines must precede aggregate capture;
child reports must follow it and precede aggregate observation. Each retained
child report still needs its original live-upload lifetime evidence.

## Evidence limits and next integration

The result concerns one original session per configured retired modern secret.
It does not attest to complete supplier writer inventory, all sessions, signed
TUS tokens, S3, in-flight work, control-plane exclusion, independent IAM/key custody,
supplier release, storage quiescence or reopening/action authority. The broader
flags stay false. Conditional current-object creation does not defeat privileged
deletion/replay, and artifact hashes are not independent authenticity.

Local synthetic transports exercise the actual factory/probe/AES-GCM vault/
artifact/manifests with two credentials, one still-working credential, unknown
child/aggregate ACKs, fresh GET-only inspection, compound pin/digest/chronology
substitution and fifty-entry manifest bounds. These are fresh components, not an
OS-process restart, real cloud activation or physical-host-loss exercise.

Protocol7 now requires the TUS-manifest head transition before shutdown, original
report manifest at final completion and original-only inspection; default-component
and native PostgreSQL lost-ACK scenarios exercise that integrated path. Keep common
capture/current authority/full application restore and actual supplier/source-
host-off/reopening proof open.
