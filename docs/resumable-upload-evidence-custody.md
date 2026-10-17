# Original TUS baseline and report custody

17 October 2026. `S3ResumableUploadEvidence` independently publishes the original
resumable baseline and refusal report through exact-version pins. It composes
locally with the [probe](supabase-resumable-upload-proof.md) and
[location vault](resumable-location-vault.md). The [default protocol7 coordinator](durable-resumable-maintenance.md) now
requires these components behind the original acquired guard.

## Retained evidence

Configuration binds the exact installation/attempt/plan/source/epoch, probe
digest, encrypted-location custody digest, tested retired credential ID and
explicit independent S3 bucket/account/SSE-KMS key/credentials. No ambient
endpoint/credentials, redirect, retry, listing, delete or current-version
fallback is used. The two fixed keys are:

```text
managed-maintenance/<installation>/<attempt>/resumable-baseline.json
managed-maintenance/<installation>/<attempt>/resumable-observation.json
```

Each conditional creation includes expected owner, encryption key and checksum.
A pin is acknowledged only after exact-version GET returns matching metadata,
bytes, SHA and closed canonical evidence. Each TUS artifact is bounded to8192bytes.
Requests/readback use15-second stage bounds and caller cancellation. Late bodies
are destroyed and cannot resume acknowledgement. Both publication operations
are consumed per instance before validation/I/O. Existing current objects block
a fresh publication; missing ACKs cannot be replaced by guessed versions.

Conditional creation does not exclude external deletion, delete-marker recreation
or privileged replay. Actual IAM, retained versions, independent custody and
the parent's original one-attempt guard remain necessary.

## Pair and chronology checks

The shared TUS contract used by the probe and store fixes the original6MiB
unfinished prefix,6MiB-plus-one length, expected prefix hash, credential ID,
reference/encrypted-pin association and known lifetime. Report publication reads
the exact original baseline pin first and checks baseline SHA, probe digest,
encrypted-location pin SHA and original credential ID. The report digest is
recomputed; only401/403 refusal and the narrowly scoped flags are allowed.

Observation must follow baseline capture. Provider time is constrained by the
existing60-second clock tolerance and180-second bounded operation, and must show
at least60seconds left on the original upload. A report observed much later is
not a proof of an earlier rejection. Baseline lifetime is bounded to24hours plus
the clock tolerance. Historical inspection may read an expired upload's original
report; it does not rerun the upload or infer refusal from expiry.

Recomputed hashes do not bypass scope, credential, offset, length, expiry or
cross-artifact checks. Closed schemas reject raw URI/credential fields and claims
of all-session revocation, signed-TUS coverage, drained writes, hosted release
attestation, storage quiescence or action authority. Hashes establish integrity
and linkage, not truth against a writer able to forge the complete artifact set.
The trusted probe/parent and actual independent supplier evidence remain required.

## Shared storage transport

The write, signed-upload and TUS stores now use one internal
`S3MaintenanceArtifactStore` transport with separate fixed namespaces, strict
format validators, pin schemas, byte bounds, failure messages and pair checks.
Existing write/signed object keys, artifact formats and pin formats remain the
same. Standard-write transport now also races SDK calls against cancellation
and disposes of late bodies, matching the signed store's existing behaviour;
oversized baseline pins refuse before GET. Shared configuration also requires a
UUID-form KMS key ARN; malformed pseudo-ARNs fail before storage I/O. These are explicit bound improvements,
not broader credential-revocation evidence.

## Fresh inspection and remaining integration

`observeBaseline()` and `observeObservation()` read only exact pinned S3 versions.
They never decrypt an upload location, issue a credential, perform TUS requests,
create a new session, publish an artifact or reconstruct a missing original ACK.
The parent must still durably acknowledge the original baseline pin before
shutdown and the report pin/digest before recording completion.

Local tests compose actual probe, AES-GCM vault and evidence store with synthetic
AWS/Storage transports: original location retained, original baseline published
and re-read, same unfinished upload tested, report published, fresh saved-report
inspection with no new TUS/KMS request. Additional cases cover compound
substitutions with recomputed digests, chronology/expiry, malformed retained
metadata/content, lost PUT/readback ACKs and closed canonical formats. Existing
write/signed tests and the default-component disposable TLS PostgreSQL exercise
verify transport integration with their original formats. Supplier transports
remain synthetic; this is not a hosted/provider/OS-process/physical-host-loss test.

The [complete configured-set factory](managed-resumable-credential-cohort.md) now
adds parent-bound child identities and complete baseline/report manifests.
Protocol7 now requires acquired-attempt parent pin transitions, original-only
inspection and native/default-component lost-ACK checks. Signed TUS, other
credentials/sessions, S3, in-flight/control-plane exclusion, common capture,
current preservation/disposal authority, full restore and actual supplier/
source-host-off/reopening proof remain open.

References: [conditional S3 creation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
and [exact object versions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/RetrievingObjectVersions.html).
These contracts do not attest to the actual independent provider configuration.
