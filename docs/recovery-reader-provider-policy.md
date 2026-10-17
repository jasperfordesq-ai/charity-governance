# Recovery reader provider policy

17 October 2026. Local review preparation for the independent-recovery provider
gate. No provider resource, role, trust policy, credential, permission, charge or
tenant policy is created or changed by this command.

`node scripts/recovery-reader-policy.mjs --stdin` accepts one JSON configuration:
`accountId`, `bucket`, `installationId`, `storageKeyArn`, `dataKeyArn`,
`indexMacKeyArn`, `rootMacKeyArn`, and `s3BucketKeyEnabled: false`. Use an approved
general-purpose bucket and four different key ARNs in the same `eu-west-1`
account. It returns a review envelope containing `policy`, its compact-JSON
SHA-256, and false provider-validation/resource/access flags. The envelope itself
is not an IAM policy; its `policy` member is the proposed dedicated role inline
policy. This is not a permissions-boundary or STS session-policy artifact.

The role is for controlled whole-installation recovery, potentially including
several organisations. It is not a Member role or a disclosure/export permission.
Its credentials must be held outside the source host. The configuration contains
resource identifiers, never access keys, secrets or tokens. Input is bounded to
8 KiB; invalid input is refused without echoing its contents. Nothing is fetched
from ambient AWS profiles or from the network.

## Proposed authority

- List only `business-data/<installation>/` and
  `managed-maintenance/<installation>/`; read objects and exact object versions
  only within those prefixes, owned by the configured account.
- Decrypt the storage key through regional S3 only, with caller account and
  object-ARN encryption context restricted to those paths. Bucket Keys are
  deliberately unsupported because they use a bucket-level context.
- Permit S3-mediated `GenerateDataKey` on that same storage key and under those
  same constraints. Direct generation is denied. The current GetObject API
  reference lists both KMS operations; the SSE-KMS guide describes downloads
  using Decrypt alone. Actual checksum-enabled downloads must settle the observed
  operation mix before activation. Do not grant application-key generation to
  make a failed read pass.
- Decrypt the application backup data key only for this installation and the
  existing document/database backup purposes. Verify MACs with the two dedicated
  original index/root keys. HMAC message contents have no IAM encryption context;
  those MAC keys must be dedicated to this installation. A generated policy
  cannot verify existing key usage or establish historical/current authority.
- Explicitly deny all other actions, other read resources, other keys, and
  missing/wrong contexts. This includes writes, deletes, signing, grants, role
  changes, and assuming another role, even if another policy broadly allows them.

Do not attach this restrictive policy to an administrator or application writer.
An independent administrator must approve the exact dedicated role, trust,
credentials, key policies and bucket protections. Existing AWS denies can prevent
legitimate reads. Source writer fencing, immutability and current authenticated
decision history require separate controls; none is established by this file.

## Verification and activation gates

Local tests exercise the generated statements against a bounded evaluator of
the exact operators used, including a simulated broad external grant and missing
request context. They also check wildcard/policy-variable injection, cross-key,
account/region substitution, Bucket Key refusal, maximum supported identifier
lengths and CLI refusal. This is not the AWS IAM simulator, Access Analyzer or
real provider evidence. No claim of effective deployed IAM permissions follows.

Before any authorised activation:

1. Validate the exact `policy` with AWS Access Analyzer. Confirm the dedicated
   role's total inline policies fit the 10,240-character aggregate quota. The
   output need not fit the smaller managed-policy or session-policy quota.
2. Review role trust, key policies, bucket owner/region, versioning, Bucket Keys
   disabled for the actual versions, independent custody, source-writer
   separation, budget and applicable terms. Creating/granting these is not
   authorised by generating a file.
3. With authorised synthetic objects, prove the reader can discover and read
   exact checksum-enabled versions, decrypt existing backups and verify original
   MACs. Prove equivalent owner controls work, then prove reader writes, direct
   key generation, signing, cross-installation reads and escalation fail.
4. Run source-host-off replacement recovery, freshness/current-history checks,
   old-writer fencing and quarantined application restore. Reopening requires its
   explicit current authority. A readable historical archive is insufficient.

Exact local execution evidence and provider decisions belong in the ignored
roadmap/checkpoint. The full product and independent-recovery goal remains open.

## Official references checked 17 October 2026

- [S3 API permissions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html)
- [S3 owner-account conditions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/amazon-s3-policy-keys.html)
- [GetObject permissions and checksum mode](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)
- [SSE-KMS permissions and encryption context](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html)
- [KMS conditions](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html)
- [IAM explicit denies and resource/session grants](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html)
- [IAM role inline-policy quotas](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html)
