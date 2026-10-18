# Managed recovery epoch catalogue

## Purpose and scope

An explicit closed-epoch catalogue supplies recovery inspection with a recorded
source/control binding and a separately retained checkpoint. It removes reliance
on a bare caller-supplied epoch floor in the new anchored inspection path.
Existing quarantine-only inspection remains unchanged. Neither path authorises
restore, disposal, admission or reopening.

`ManagedRecoveryEpochCatalogue` accepts a trusted installation, store configuration
digest, genesis-head SHA-256 and an externally trusted checkpoint sequence/digest.
Do not discover the genesis or checkpoint from the same backup or namespace being
verified. Updating that checkpoint does not change the catalogue's identity digest
or invalidate earlier records; it strengthens the reader's required floor.

## Store contract

Read capability and original publication capability are separate interfaces.
The reader must obtain authenticated, uncached current-head reads with non-reused
provider revisions and exact-version entry reads. The writer must use atomic
create-if-absent at each sequence's fixed location and compare-and-swap for the
head. Initial genesis provisioning is separate; missing state is never initialised
by observation or publication. No provider adapter, credential acquisition,
resource provisioning, policy grant or CLI activation is supplied by this slice.

This is a trusted adapter contract, not proof that any store implements it.
[AWS conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
operate on current object state; deletion/delete markers can allow another write.
[AWS consistency](https://aws.amazon.com/s3/consistency/) does not establish
independent administration, retention or protection against privileged rollback.
Those require actual provider/IAM and custody evidence.

## Original publication

`ManagedRecoveryEpochPublisher.publishClosedEpoch` checks the current catalogue,
expected independent-head revision, actual closed control and current journal
bootstrap. It binds the full original closed-control value/revision, plan preimage,
control-location digest, journal/archive configuration digests and previous-head
preimage. Closed maintenance epochs must strictly increase; catalogue sequences
are contiguous. Skipped maintenance epochs are not represented as accounted for.

The original immutable entry ACK and exact readback precede head CAS. Control,
store and independent head are rechecked around publication. Original head ACK,
full catalogue readback and final control check are required to return success.
Lost entry or head ACKs remain unresolved. Fresh callers cannot fill or overwrite
an existing sequence, skip an orphan entry, recover an ACK or republish that same
closed epoch. No repair/takeover interface is provided.

## Observation and anchored composition

Observation follows exact entry pins back to the pinned genesis, validates every
plan against its original closed head and requires strictly increasing epochs.
It rejects a head older than the external checkpoint, an alternate checkpoint
entry, missing history, substituted versions and malformed or changed records.
Current-head reads bracket the traversal. Bounds are 10,000 entries, 64 KiB per
record and a five-minute operation budget; exceeding them refuses the observation.
Cancellation discards late responses without starting further work.

`ManagedCandidateCaptureJournal.inspectAnchoredCurrentRecovery` first observes
that catalogue, requires its latest control, journal and archive bindings to
match the actual components, then calls the existing recovery inspector using
that recorded epoch. It rereads catalogue and control afterwards. A source
rollback or head change that conflicts with the trusted catalogue/checkpoint
refuses; no stable observation is promoted into a lock or execution lease.

## Proof limits and remaining work

Unit composition uses real catalogue, publisher, control, journal and format-5
retirement components with modelled storage/provider/archive transports. It covers
multi-epoch lineage, checkpoint rollback/substitution, missing/corrupt originals,
concurrent publishers, original ACK loss, source/head drift and cancellation,
including cancellation after entry persistence but before a late ACK.
It is not native independent-store or real provider evidence.

A valid chain proves the observed recorded closed-epoch lineage, not every
maintenance attempt or tenant preservation/disposal decision. A stale external
checkpoint cannot rule out all provider rollback. Provider rollback exclusion,
independent custody, current tenant authority, complete history, source-host loss,
reconstructed ACK, execution, admission and reopening flags remain false.

Still required: the pinned provider reader/writer adapter with exact-version/KMS/
checksum and conditional-write evidence; actual independent IAM/genesis/checkpoint
custody and deletion/lifecycle/rollback exclusion; native multi-epoch/process loss
composition; current tenant authority and actual source-host-off, quarantined
application replacement and guarded reopening proof. No tenant or route opts in
automatically. Exact source/test/CI/VM state belongs in the private checkpoint.
