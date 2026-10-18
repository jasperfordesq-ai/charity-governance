# Retiring the retained capture control key

## Contract — 18 October 2026

The existing format-9 and format-10 plans deliberately retain one modern secret
key for positive-control canary checks. A separate read-role JWT capture does
not revoke that privileged key. This is an explicit remaining writer path.

`ManagedCaptureControlRetirement` adds an internal format-11 component with
`REVOKE_REVIEWED_KEYS_THEN_RETIRE_CAPTURE_CONTROL_V1` and an exact retirement
configuration digest. Existing plans cannot activate it. The main coordinator selects format 11 only when both the read-role and
retirement components are explicitly supplied. It rejects a retirement component
bound to another provider/control instance or installation. Current candidate
discovery explicitly refuses format 11 until its retirement-aware binding exists.

The component requires a matching current fully evidenced OBSERVED_CLOSED head,
source/epoch/attempt/plan binding and exact provider registry. It conditionally
stores a request under the original attempt's `capture-control-baseline.json`,
with SSE-KMS, checksum, original version acknowledgement and exact readback.
Only that live successful publication allows the provider primitive to run.

The provider primitive checks two matching project/organisation/region snapshots,
legacy keys and S3 protocol disabled, and exactly the one configured secret key.
It sends one DELETE for that ID with `reveal=false`, validates the response ID
and type, then requires two matching snapshots with no modern keys. It creates,
rotates or restores no key, and deletes no document. Returned evidence contains
IDs and hashes only; provider secret-bearing response fields are discarded.

A separate immutable report pins the original request version and the bounded
metadata observation. Missing request ACK prevents DELETE. Unknown DELETE ACK
leaves a request without a report, even if a later read sees the key absent.
Unknown report ACK can be inspected as saved evidence, but cannot authorise a
second DELETE. A fresh caller meets the same conditional request conflict.

Read-only inspection checks the exact request/report pair, stable current head,
current metadata and configured scope. It cannot reconstruct original ACKs,
retry retirement, admit an archive or authorise reopening. Changed/recreated
keys or internally substituted records refuse inspection.

## Evidence and remaining integration

Synthetic tests exercise the real provider-control class, current control-head
parser, conditional evidence store and AWS SDK serialization with a modelled
transport. This is not hosted Supabase/AWS, IAM or physical-host-loss proof.
Exact test results and deployed/source SHAs are recorded in the private handoff.

Still required before activation:

- Complete the current data-plane comparison described below. The explicit
  coordinator construction and retirement-aware inspection are implemented.
- Add a new candidate/request/report binding that carries retirement evidence
  through the canonical snapshot/source/archive/cold-reader path. Neither legacy
  nor format-4 capture may imply that evidence.
- Verify data-plane refusal of the retired key against a legitimate read-role
  positive control, actual provider propagation and current signer/project/SQL
  identity and visibility.
- Exclude remaining management/signing issuers, signed/resumable capabilities,
  in-flight requests and privileged provider actors; prove independent IAM,
  current recovery authority and physical-host-loss/guarded reopening.

All global-writer, data-plane, in-flight, signed-capability, whole-backend and
action-authority claims remain false. No provider action is authorised by this
source implementation or by saved inspection output.

## Primary sources

- [Supabase API key deletion contract](https://supabase.com/docs/reference/api/v1-delete-project-api-key): named key ID, reveal flag, required permissions and response.
- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys): secret keys are privileged and deleting a key is irreversible.
## Coordinator sequence

With both components configured, `close()` records the original full shutdown
and positive-control evidence and explicitly reports retirement still required.
`retireCaptureControl()` then rereads the original immutable artifacts and current
service/database/signing/Storage metadata without replaying the old secret-key
canary GET. Only the separate component's original request ACK allows DELETE.
Retirement is never inferred from the first closure phase.

Public `inspect()` for this policy requires the saved retirement report and
current key-absence observation. It rereads the original evidence, current
service/database/signing state and stable head, with no old secret-key positive
control, PUT or DELETE. Original acknowledgement reconstruction remains false;
fresh credential-read refusal and retired-control data-plane refusal remain
false. Missing retirement evidence or recreated keys fail closed. No route,
provider credential or tenant installation opts into the policy automatically.

The [read comparison component](retired-control-read-comparison.md) is integrated under explicit format 12, with original intent and separate baseline ACKs before DELETE. Public-data-only historical validation is implemented. Capture/candidate/archive propagation and actual provider acceptance remain open.
## Format 12 — retained comparison evidence

Supplying the public comparison descriptor and live probe to the retirement
component selects a new configuration digest; the coordinator pins it in format
12 with `REVOKE_KEYS_RETIRE_CONTROL_WITH_CANARY_READ_COMPARISON_V2`. Execution
requires the live probe, while saved inspection needs only its public descriptor.
The intent ACK precedes all new credential probes; a separate exact-version
baseline ACK precedes DELETE. The version-2 report includes the original baseline
pin and saved GET-refusal comparison. The coordinator distinguishes a verified
recorded canary refusal from a fresh refusal, which inspection does not perform.
All global writer exclusion, provider currency and action-authority limits remain.

## 18 October integration update

Plan 12 now uses [candidate format 5 and original-record cold discovery](managed-retired-control-common-candidate.md). This supersedes earlier pending-integration notes above. Plan 11 remains refused. Actual native format-5 execution and provider/current-authority/host-loss acceptance remain open.
