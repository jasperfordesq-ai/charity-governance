# Original resumable-upload PATCH proof

17 October 2026. `SupabaseResumableUploadProof` implements an active probe of
one original TUS upload with one reviewed modern secret credential. It is an
internal component required by [default protocol7](durable-resumable-maintenance.md). No actual
supplier resource, upload or token was used in its local tests.

## Source-driven decisions

The [Supabase resumable guide](https://supabase.com/docs/guides/storage/uploads/resumable-uploads)
documents the direct storage host,6MiB chunks, a distinct upload URL, PATCH
resumption and signed resumable uploads through `x-signature`. The
[TUS protocol](https://tus.io/protocols/resumable-upload) distinguishes a valid
PATCH at the current offset from conflicts, missing resources and expiration.
Those failure meanings must not become credential-revocation evidence.

Upstream Storage was inspected at exact revision
`c826a70ac6e6f56d3e6033ccb164fb1ff5282570`:

- [TUS lifecycle](https://github.com/supabase/storage/blob/c826a70ac6e6f56d3e6033ccb164fb1ff5282570/src/http/routes/tus/lifecycle.ts)
  checks upload authority on incoming requests; its ordinary HEAD/OPTIONS path
  does not require upload authorisation. HEAD success is not a write-exclusion
  failure, and HEAD rejection alone is not the write-refusal proof.
- [Upload IDs](https://github.com/supabase/storage/blob/c826a70ac6e6f56d3e6033ccb164fb1ff5282570/src/storage/protocols/tus/upload-id.ts)
  and [backend separators](https://github.com/supabase/storage/blob/c826a70ac6e6f56d3e6033ccb164fb1ff5282570/src/storage/backend/adapter.ts)
  support path-version and `-$v-` file-version formats. Generated URLs remove
  the tenant prefix and base64url-encode the bucket/object/version.

This upstream revision is research evidence, not the hosted supplier release.
The configured release identifiers remain declarations; provider attestation
stays false.

## Supported synthetic profile

Only `charitypilot-recovery-resumable-probes` is allowed. Three exact paths under
the installation and original maintenance attempt are used: `old.txt`,
`control-before.txt` and `control-after.txt`. Input credentials must match the
reviewed modern secret IDs and SHA values; no ambient credentials, JWT refresh,
arbitrary bucket/object URL, redirects or retries are allowed.

The endpoint is the exact HTTPS direct storage hostname for the configured
project. A returned Location must be absolute and canonical, have no query,
fragment, credentials or explicit/default port normalization, and decode to the
exact synthetic bucket/object plus a lowercase UUID in the explicitly selected
ID format. Alternate hosts, paths, encodings and formats refuse before custody
or a chunk write.

The baseline confirms a private bucket and absent completed object, creates a
6MiB-plus-one-byte upload with the retired credential, and requires acknowledged
location custody before writing6MiB. HEAD must confirm the original length and
offset, while the completed object remains absent. The profile requires an
explicit valid Upload-Expires header with at least60seconds remaining and no
more than24hours. Missing/changed expiry is unresolved; no expiry is inferred
from documentation or a404.

After maintenance, verification uses that original retained location/reference
and unchanged reviewed credential. A valid one-byte PATCH at the original offset
must return401/403, bracketed by successful retained-control TUS uploads and
verified control-object bytes. The original offset must stay unchanged, the
original upload must remain unexpired, and its completed object must stay absent.
Unexpected acceptance or partial side effects fail without hiding the residue.

## Custody, evidence and uncertainty

The required callback acknowledges `RESUMABLE_LOCATION_PIN_V1`: exact reference,
custody digest, encrypted-body SHA/length and version pin, plus original location
SHA. The [purpose-separated location vault](resumable-location-vault.md) now
implements that contract with exact-version decrypted readback. Actual independent
provider/IAM/key-custody proof remains open. The original URL is supplied separately
for verification. Baseline/report artifacts contain hashes/pins and no raw
location or credential. Outbound request tracing must also redact resource URLs
before activation; the component cannot control a caller's tracing transport.

Each instance consumes a phase before dispatch. Unknown custody/POST/PATCH results
do not produce a baseline/report or allow that instance to retry. A fresh instance
could create another session for an incomplete object without the independent
parent attempt guard; this component does not supply that guard.
Caller cancellation,15-second bounded
requests,180-second outer deadlines,32-request budgets and bounded response bodies
apply. Late location acknowledgements and provider bodies cannot resume the
component after timeout. No automatic termination, deletion or reset is exposed.

The report proves only the tested modern-secret PATCH refusal. Signed resumable
tokens, other credentials/sessions, S3, already-dispatched writes, control-plane
actors and retained-key least privilege remain outside this evidence. Global
revocation, drained writes, hosted attestation, storage quiescence and action
authority remain false.

## Verification and next integration

Local synthetic transport tests exercise both reviewed ID formats, successful
original-prefix upload and refused final PATCH, working controls, continued
acceptance, side effects,500/409/404/410, missing/changed state, expiry, URL/attempt/
credential/payload/custody substitutions, lost custody ACK and bounded late
callbacks/provider bodies. They do not prove actual provider or host-loss behaviour.

Encrypted original-location custody and
[independent baseline/report publication](resumable-upload-evidence-custody.md)
are implemented and compose locally. The complete configured-set factory, required parent pin barriers and default
coordinator/native fixture now compose through protocol7. Add signed-resumable and S3 coverage and
prove actual provider in-flight/control-plane exclusion before common capture.
Keep the full independent-recovery/current-authority/full-restore/host-loss goal
open; a local PATCH model is not its completion.

The separate [signed-TUS component](signed-resumable-upload-proof.md) now tests
an original x-signature capability with issuer validation and required combined
custody. Its encrypted store/publication/parent integration still remain open;
ordinary protocol7 success does not include that component yet.
