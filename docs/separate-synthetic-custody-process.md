# Separate synthetic custody process

17 October 2026. This is an opt-in native integration test, not a cloud provider or production deployment.

The existing common encrypted-custody fixture normally keeps its synthetic S3 objects and KMS secrets in the source process. The new selector moves that fixture into a separate owner process. Source clients retain no backend object/key map. They still use the real SDK signing/serialization and CharityPilot crypto/archive classes, through a bounded loopback-only test transport.

The test owner starts and holds the service before launching any source process. Its capability descriptor is retained in a protected temporary directory and is not passed on command lines or printed. The service accepts only synthetic credentials, the existing synthetic account/bucket/key configuration and the two expected AWS SDK request shapes. It never sends requests to AWS. Each fixture session retains its original isolated test backend semantics; sessions are not evidence of real provider namespaces or IAM isolation.

The complete real TLS PostgreSQL/source/restore/common-custody test runs with this service. A separate caller-loss test then stops its original source during actual work. The service remains owned by the outer driver. Source client shutdown does not delete its objects or wipe its keys.

After both source processes terminate, a new reader receives a separate read-only recovery capability. It learns fixture sessions and uses SDK LIST/GET to discover root metadata and exact versions. It also checks the retained service-record bytes from the last killed source, without manufacturing a root or acknowledgement for that incomplete attempt. It invokes the actual archived-set MAC/decrypt/interval/index/object verifier for completed roots. It must make no new writes or data keys, and all results remain quarantine-only with no execution authority. The owner then stops the service; further reads must fail without cached fallback. Structured reader results use a dedicated IPC channel, separate from SDK diagnostics.

The service derives roles from separate capability values, never a caller-supplied role. Recovery permits discovery/statistics, S3 GET/LIST and KMS Decrypt/VerifyMac against the fixture's known key scope. It rejects registration, fault controls, writes, new data keys and signing before invoking the backend. VerifyMac also requires a key already established by the original signer, so the legacy fixture cannot lazily create a MAC key on a recovery read. The native test sends mutation requests with the recovery capability, checks unchanged counters, then exercises successful owner controls using the same SDK requests. The cold verifier receives only the recovery descriptor. These are fixture-protocol checks, not a real AWS IAM policy or proof of operating-system credential isolation between processes using the same host user.

Run on the existing non-root Linux synthetic test host with the current API build and normal local Docker/kernel prerequisites:

```sh
CHARITYPILOT_TEST_SEPARATE_CUSTODY=1 node --test scripts/synthetic-custody-process.native.test.mjs
```

The internal `CHARITYPILOT_TEST_CUSTODY_SESSION_FILE` selector is created by that driver; it is not a product provider setting. The ordinary cohort continues to use its existing local fixture unless explicitly selected. The driver owns all temporary child/service resources and cleans them after terminal observation. Exact source/run evidence belongs to the private checkpoint.

## Limits

The selected successful native maintenance scenario now issues its original
READY creation and subsequent conditional control transitions through the
separate keeper's SDK transport. No head is copied after source loss. Its eight
separate archive sessions retain one-shot fixture links to that original control
session. After the source terminates, the recovery-only cold process runs the
current recovery inspector against that retained control and each original
candidate catalogue, using the actual archive crypto verifier. It must verify
two available roots and retain six incomplete/unknown cases as unresolved. The
genuinely killed caller also retains its original control and linked incomplete
candidate, adding a ninth current inspection and a seventh unresolved outcome.
The other fault scenarios still use their existing local control fixtures.
The links/epoch floor remain test-owner trust, not authenticated real provider
authority or physical-host independence. Exact native results belong privately.

The keeper is a volatile process on the same test host. Its session registry and capability are fixture-owner trust, not an independent provider authority or authenticated current tenant decision head. Discovering and MAC-verifying a historical root does not establish that it is current or permit reopening. This test cannot prove persistence after keeper restart, provider IAM/key custody, source-VM loss, current retention/disposal replay or production readiness. Those remain explicit requirements of the full goal.

Provider activation is separately unapproved; standard AWS credentials/profile were absent on the inspected workstation. No paid resource, account, terms, access grant or charity-data transfer is inferred from this test or the software-owner delegation.
