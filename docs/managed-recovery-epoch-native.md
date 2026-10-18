# Native two-epoch synthetic recovery proof

The opt-in `CHARITYPILOT_TEST_SEPARATE_CUSTODY=1` cohort in
`scripts/synthetic-custody-process.native.test.mjs` includes a dedicated shared
namespace for two strictly increasing maintenance epochs. Run it only from an
exact clean canonical Linux checkout under the existing non-root kernel-contained
proof runner and local Docker boundary. Compile the API first. Ordinary CI also
checks the protected bootstrap and original-receipt validation boundaries; it
does not silently opt into the separate-custody native cohort.

## Original publication and recovery boundary

The external synthetic custody supervisor provisions a distinct genesis with an
original conditional PUT acknowledgement and exact-version readback. It retains
the genesis digest, storage configuration digest and provider-test routing session
in a protected directory outside the source proof workspace. The fixture never
provisions an actual provider or resets production state.

One shared backing namespace holds both epochs' original control, plan,
retirement, source-job, archive and epoch-chain records. Each epoch exercises real
TLS SQL closure, canonical imported snapshot/dump, isolated restore and signed-SDK
archive custody through a kernel-contained source cohort. The second epoch uses
new synthetic provider key identities and a new original attempt. Its test-only
operator advances the closed control using the exact observed prior ETag. This
is not a supported production reopening operation or evidence of its authority.

The original epoch publisher's successful return sends an IPC receipt with only
sequence, maintenance epoch, entry digest, head revision and source SHA. The
supervisor validates source/sequence and fsyncs each receipt separately. The
checkpoint for recovery is taken from that live original receipt, never a GET,
backup, archive pin or candidate ID supplied by the source. Neither provider
responses recovered later nor an embedded record reconstruct a lost receipt.

After the source exits, a fresh process receives only the recovery capability and
protected external bootstrap with the original second receipt's checkpoint. New
SDK clients validate the complete two-entry chain and bind its latest control,
journal and archive to the existing quarantine-only recovery inspector. Its
current candidate must be the second epoch's single verified root. Generic
archive verification also reads the first epoch's historical root. No writes or
data-key generation are permitted during recovery. Source absence and capability
separation are synthetic process boundaries on the same machine.

## Existing and remaining evidence

The original independent legacy/read-role/retired-control ACK-loss cohorts and
genuine legacy/retired-control caller SIGKILL cases remain separate. Their
22-current-candidate counts do not become multi-epoch evidence. The new shared
namespace reports its own two-entry chain and one latest-epoch root.

Source integration alone is not an executed native proof. Dated exact-source
native results and failures belong in the ignored private handoff. New epoch
entry/head ACK-loss, external-checkpoint rollback/version/list drift and genuine
caller loss within the shared two-epoch path still require their own native
execution. Modelled SDK tests cover those store boundaries separately.

Actual provider IAM/no-delete/no-copy/lifecycle/rollback controls, independently
retained genesis/checkpoints and key custody, whole-backend writer exclusion,
current tenant preservation/disposal authority and physical-host-loss recovery
remain acceptance gates. No admission, cleanup, replay, reopening or external
provider authorization follows from this fixture.
