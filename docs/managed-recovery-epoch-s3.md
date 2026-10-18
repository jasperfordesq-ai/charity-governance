# S3 custody for managed recovery epochs

## Capabilities and configuration

`S3ManagedRecoveryEpochReader` and `S3ManagedRecoveryEpochWriter` implement the
[closed-epoch catalogue contracts](managed-recovery-epoch-catalogue.md) as separate
public capabilities. Reader instances expose no publication method. Both require
explicit credentials, installation, general-purpose bucket, owner account and
exact eu-west-1 KMS key ARN. No ambient endpoint/credential discovery, region
redirect, provider retry, resource grant or initialisation fallback is added.
The default SDK client is pinned to regional HTTPS with one attempt. Client
injection remains a trusted isolated-transport boundary.

Directory buckets, access-point/Object Lambda aliases, S3 Tables buckets and
Bucket Keys are unsupported. [AWS bucket-family rules](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html)
explain their reserved suffixes. The policy/configuration digest has a separate
S3 append-only-epoch domain; it cannot alias the generic maintenance head.

## Append-only logical head

Keys are fixed, not caller paths:

- `managed-maintenance/<installation>/recovery-epochs/entries/00001.json`
- `managed-maintenance/<installation>/recovery-epochs/heads/00000.json`
- Subsequent head slots use their exact contiguous sequence, through 10000.

Slot zero is a separately provisioned canonical genesis, whose digest/checkpoint
must be retained outside the inspected backup. The adapter never creates it.
Each head publication conditionally creates the next slot with `If-None-Match:*`.
Existing slots are never overwritten. Competing protocol publishers target the
same next entry/head slot, so one conditional creation wins. The writer checks
its expected original head before publication and rechecks its physical version
afterwards. This implements logical head compare-and-swap under the required
append-only provider policy; it is not a conditional PutObject against VersionId.

[AWS If-Match compares ETags](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html),
not physical version identities. This adapter does not use ETags as versions.
Its observed revision binds the real returned VersionId, object key/configuration,
ETag and body digest. Equal bytes/ETags with a changed VersionId refuse at the
read boundary. Provider deletion, unconditional copy/overwrite, lifecycle and
privileged rollback exclusion must still be enforced and verified independently.
A delete marker can permit another conditional create; append-only client code
does not prevent an independently privileged actor doing that.

## Original acknowledgements and reads

An original entry PUT ACK plus exact-version readback gives that writer instance
one head-publication attempt. Inspection, a fresh writer or a saved pin cannot
reconstruct it. Unknown entry/head PUT or exact-readback ACKs remain unresolved;
there is no retry, repair, orphan-slot skip or adoption path. A stored entry with
unknown ACK may block that sequence until an explicitly designed resolution.

All PUTs carry expected owner, full SHA-256, JSON content type, SSE-KMS key and
Bucket Keys disabled. Exact readback checks returned version, ETag, checksum,
bytes, canonical JSON and scoped record/plan shape. GETs require checksum mode,
correct KMS metadata and no delete marker, content encoding or composite checksum.
Entry reads use only the supplied exact version at the fixed sequence location.
Records are bounded to 64 KiB; each request/body has a 15-second deadline and a
complete operation has five minutes. Late responses are discarded on cancellation.

Head observation lists only the fixed heads prefix, with expected owner, no
filter/delimiter/start-after and at most 11 pages of 1000 keys. It rejects gaps,
foreign keys, duplicate/reordered rows, repeated tokens and incomplete pagination.
It reads the latest slot, rereads that exact version, repeats the entire listing,
and rereads the current latest version. Drift refuses; no partial listing becomes
a current head. [ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html)
and [GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)
define the underlying contracts. Stable boundaries are not a cross-object lock
or proof of all historical versions or unfiltered effective provider visibility.

## Executed proof and remaining gates

Unit composition uses actual AWS SDK signing/serialization and actual epoch,
control, journal and retirement classes with a MODELLED S3 HTTP transport and
archive verifier. It exercises two epochs, a fresh SDK reader, anchored format-5
inspection, all original PUT/readback ACK-loss stages, cold permission refusal,
concurrent publishers, 1001-slot pagination, repeated tokens/list drift, physical
version replacement, malformed metadata/bytes and cancellation after provider
acceptance. Direct KMS data-key generation is absent in that transport model;
this does not prove the real service-side SSE-KMS permission/operation mix.

No live account, bucket, object, role, key or policy was changed. This is not actual
provider IAM, independent genesis/checkpoint custody, native multi-epoch caller/
host loss or current tenant authority/reopening acceptance. The full goal remains
active; provider/current-authority/host-loss flags stay false. The adapter is an
explicit internal library and activates no route, tenant or operator workflow.
