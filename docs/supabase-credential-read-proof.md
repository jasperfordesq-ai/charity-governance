# Supabase credential read-refusal evidence

> **17 October integration:** [Maintenance protocol4](durable-credential-read-baseline.md)
> now stores the baseline body/pin with exact independent readback before shutdown,
> then retains the later refusal artifact. It binds the registry and keeps fresh
> inspection separate from original history. Actual provider/custody and broader
> gates remain open.

17 October 2026. `SupabaseCredentialReadProof` tests a specific modern server
credential's access to a pre-existing private synthetic canary. It is an internal
read-only evidence component. No route/job/command activates it or provisions its
fixture; it does not create/delete objects, revoke keys or grant access.

## Reviewed scope

The registry binds installation, exact project reference, the fixed
`charitypilot-recovery-canaries` bucket and a canary below
`charitypilot-recovery-canary/<installationId>/`. The object must be approved
synthetic text, 1–1,024 bytes, with an independently known SHA and exact path.
The component refuses ordinary governance buckets, unsafe paths and arbitrary
origins. A missing fixture is unresolved; it never creates a substitute.

The source-owned default is [recovery-canary-v1.txt](../fixtures/recovery-canary-v1.txt),
pinned to LF bytes. Provision it separately at
`charitypilot-recovery-canary/<installationId>/v1.txt` in the private canary
bucket during authorised infrastructure setup. Its exact byte count and SHA
must populate the registry; the reader does not upload it or create the bucket.
The supplied file is 86 bytes with SHA-256
`6b5e73cff184fc31c641a3edfd65b1f836ec9ec27eda0fb5ce367231f6c0f19b`.

The control credential and 1–50 tested credentials have distinct UUID labels and
SHA-256 fingerprints. Actual modern server secrets are supplied separately and
must match those fingerprints before any request. All configuration/secret input
is copied; no environment credential discovery occurs. Fingerprints bind the
supplied value, but do not independently prove the provider key-ID association,
account ownership, region or custody. Keep the reviewed issuance/provider registry
as separate evidence. Legacy JWTs and publishable/user-context keys are not covered.

## Baseline and later check

1. `baseline` reads the exact private canary with the control credential, every
   tested credential and the control again. Bucket ID/visibility, object MIME,
   byte count and full SHA must match. No plaintext is returned; owned buffers
   are cleared. Every tested credential must actually work during this baseline.
2. It returns a canonical bounded baseline body and SHA, containing configuration
   digest, credential count, canary hash/size and observation time. No secret value
   or raw canary bytes are in it. This is a source observation, not a signature.
3. Before destroying credentials, a caller must retain/authenticate that baseline
   SHA and body independently. `verifyReadRefusal(body, trustedExpectedSha)` checks
   exact bytes, closed schema, configuration/count/canary equality and time shape
   before reading the source. Do not derive the trusted SHA solely from the
   recovered body or treat a caller-supplied JSON claim as independent custody.
4. For every tested credential, the control reads the exact canary immediately
   before and after a GET with that credential. Only HTTP 401/403 are accepted as
   observed refusal. HTTP 200, redirects, missing objects, rate limits, server
   failures, changed content or failed controls make the evidence unresolved.

The new `SupabaseRecoveryCapture.readRecoveryCanary` reuses its fixed-origin,
private-bucket, exact-byte and clearing checks, restricted to this fixture scope.
All requests use the project HTTPS endpoint and modern `apikey` header, with no
Bearer identity, redirect, signed/public URL, transformation or retry. Error
bodies are cancelled without parsing/logging provider details. Existing successful
reads retain their 15-second request bounds; denial reads have a 10-second bound,
each canary read 30 seconds and a complete proof 180 seconds. Caller cancellation and
late response-body cancellation remain required.

## What the observation means

`credentialReadRefusalsObserved=true` and
`coverage=EXPLICIT_MODERN_SECRET_READS_ONLY` describe the tested GETs. They do not
establish why a credential was refused: a 403 may be resource policy rather than
revocation. They do not prove write rejection, complete key coverage, signed
capability revocation, in-flight drain, global source quiescence or reopening.
All corresponding broader flags remain false. The result includes current
observation time, tested UUIDs/statuses, configuration/baseline hashes and an
observation digest; it contains no secrets. Treat it as restricted evidence.

## Integration and verification boundary

Tests compose the real management-control primitive with this reader through
synthetic HTTP: establish a working baseline, close the exact reviewed key path,
then observe refusal with the retained control still working. Other cases cover
401/403, prior invalid credentials, a failed trailing control, missing/outage/
rate-limit responses, body tampering, scope/key mismatch, changed canary bytes,
cancellation, stalled denial and late-body cleanup.

The current internal maintenance protocol4 now calls this component through the
independently retained baseline workflow linked above. It deliberately still
does not claim broad data-plane write exclusion. Source-process-memory storage in
the earlier standalone synthetic test is not independent custody; the new CAS
workflow is tested with a separate S3 model, and real custody remains unverified.
No actual supplier account, key, canary or cloud transfer was used in these tests.

Write-path/capability and control-plane exclusion, actual provider acceptance,
common capture/authority reconciliation, independent recovery custody/full restore
and physical source-host-off/reopening proof remain in the full goal.

Primary references checked 17 October 2026:

- [Storage error distinctions](https://supabase.com/docs/guides/storage/debugging/error-codes).
- [Private file download](https://supabase.com/docs/reference/javascript/file-buckets-download).
- [Modern server-key handling](https://supabase.com/docs/guides/getting-started/api-keys).
