# Product governance decisions

Decision date: 16 October 2026.

## Authority and acceptance

CharityPilot is a product for multiple organisations. The software owner has
delegated product and engineering decisions to the implementation agent.
An external reviewer's participation is optional; a further reviewer response
is not a release prerequisite. Record external observations accurately without
claiming a reviewer approved a release they have not reviewed.

Product acceptance requires demonstrated behaviour against the requirements,
reviewed code, exact-version checks and appropriate deployment/provider proof.
Keep synthetic approvals clearly distinct from real governance acts. Product
design decisions do not create Board resolutions or adopt policies for every
customer. Organisation Owners can adopt their own settings through the audited
controls; the product must provide usable recommendations rather than require
each customer to design the feature from scratch.

## Managed internal service authentication

Use mutual TLS and distinct, exactly pinned gateway/web client certificates for
managed internal API connections. The private web credential is limited to its
read-only auth-me check. Do not trust the entire regional provider network or
arbitrary forwarded client-address claims. Actual service-key custody, immutable
deployment binding, revocation and end-user address verification remain required.
Existing HTTP-only managed prototypes are not eligible for activation under
this decision. This is a product engineering choice under delegated authority;
it neither provisions provider resources nor adopts a tenant governance policy.
See [managed API peer transport](managed-api-peer-transport.md).

## Record access and lifecycle

- New and unassessed documents are restricted. Member disclosure requires an
  explicit assessment and an exact reviewed file; changing bytes invalidates
  the basis for that disclosure.
- Keep the existing structural lifecycle and accountable ownership controls.
  Group category decisions where authority and evidence permit. A record review
  backlog is not a requirement for a new Board resolution for each file.
- Preserve removal, retention, disclosure and legal/currentness decisions as
  separate facts. A historical classification does not establish legal accuracy
  or permission to erase the record.

## Draft removal and recovery recommendation

Recommend individual removal review and 30 days of recovery after authorised
removal for eligible unheld drafts without linked evidence. This is a recovery
recommendation, not a statutory retention period. The Owner can change it.

The recommendation is an explicit form preset, not an automatically active
policy. Selecting it makes no API write. Saving a proposal and approving a
policy remain separate actions. The recommendation is limited to Vault drafts;
it must not silently populate complaint, external-copy or backup policies.

The recovery deadline does not initiate permanent purge. Preserve the existing
separate disposal authority, hold checks, exact-file safeguards and copy evidence.
An expired recovery period must not be presented as proof that every copy has
been erased. Recovery remains restricted and preserves audit history.

References checked on the decision date:

- [Google Drive](https://support.google.com/drive/answer/14933051?hl=en):
  30 days in Trash.
- [Notion](https://www.notion.com/help/custom-data-retention-settings):
  30-day default with configurable enterprise retention settings.
- [SharePoint](https://support.microsoft.com/en-us/sharepoint/admin/restore-deleted-items-from-the-site-collection-recycle-bin):
  93 days from original deletion, shared across recycle-bin stages.

These are comparative product behaviours, not legal authority or evidence that
CharityPilot provides those services' recovery guarantees. The differing periods
support a configurable choice. CharityPilot retains separate purge safeguards
because it holds governance evidence and preservation decisions.

The [ICO's storage-limitation guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-principles/a-guide-to-the-data-protection-principles/storage-limitation/)
also explains that there is no universal retention period for all personal data.
This supports keeping purpose-specific record retention separate from a product's
recovery convenience setting; it is not jurisdiction-specific approval of a
customer's schedule.

## Reporting

Keep the full internal report limited to authorised privileged users. A minimised
report is a separate, explicitly labelled output based on an immutable approved
snapshot; synthetic snapshot tests establish product behaviour without recording
an invented real Board approval. A customer with no approved snapshot should
receive a clear explanation and a synthetic sample, not a false approved report.

Continue field-level minimisation tests and rendered-output checks. Recipient
approval for a particular disclosure remains separate from availability of the
feature. An external reviewer need not approve each product test fixture.

## Historical security events

Where retained evidence cannot attribute historical replay events, preserve that
uncertainty. Record engineering investigation results, observed repairs and their
proof limits. Do not invent a benign cause, erase events, or mark a tenant risk
verified solely because new source tests pass. Further diagnostics must have a
bounded purpose and retention setting.

## Recovery and provider work

The product must recover to a safe state with current preservation/disposal
authority, or quarantine uncertain operations. Exact restoration of every internal
transport identifier is not a universal availability requirement. Missing original
commit evidence must remain unknown; a quarantined/manual reconciliation path is
acceptable when it cannot authorise stale writes, repeated erasure or unsafe
reopening. Do not manufacture lost immutable rows.

Managed whole-backend hosting and independently held usable recovery information
remain required outcomes. A same-host disposable restore is engineering evidence,
not physical-host-loss resilience. Provider selection, costed operating plan,
accountable key custody and host-off/replacement proof are separate work items;
external reviewer availability does not prevent preparing or implementing the
chosen product contract. Supplier spend, legal acceptance and new access grants
still require the corresponding authority.

## Execution order

1. Deliver and verify the recommended draft-policy path and synthetic recovery.
2. Verify reporting with synthetic snapshots and explicit field/output assertions.
3. Implement supported synthetic Confluence permission/execution and uncertainty
   handling using the reviewed quarantine contract, followed by authorised real
   sandbox observations.
4. Complete the costed whole-backend deployment and independent recovery path,
   then perform the required provider and host-loss demonstrations.

Existing production/security invariants remain applicable. Keep implementation,
CI, actual deployment, provider observation and external review as distinct
evidence states. Do not require an unavailable reviewer to close engineering
work, and do not claim unperformed independent acceptance.


## Synthetic retained-copy review form

Recommend 30 minutes of explicit synthetic-review validity, editable from 1 to 60
minutes in the Owner form, within the separate maintenance scope's one-hour
ceiling. This is a short engineering review window; it is not a retention period
or a grant of provider authority. The API still requires explicit review times;
no tenant policy or scope is automatically created by displaying the preset.

Show source retention separately from external-copy disposal. After an uncertain
review save, preserve the attempted reference/reviewer/time and permit receipt
inspection without automatically submitting another review. A receipt or a
matching digest cannot by itself activate erasure.

## Further platform research and transport implementation

The 16 October source check of [Render private networking](https://render.com/docs/private-network)
confirms that private connectivity is shared among services in the same workspace
and region. That reachability is not sufficient application identity. Retain the
chosen mutual TLS boundary and distinct gateway/web credentials; do not use
private DNS or network location as authorisation.

[Microsoft Purview retention](https://learn.microsoft.com/en-us/purview/retention)
separates retention, deletion and policy precedence. This supports CharityPilot's
existing decision to keep recovery convenience, preservation obligations and
permanent disposal authority separate. It does not adopt a schedule for a tenant.

The software-owner delegation is sufficient for these engineering choices.
Further Nikita participation remains optional; evidence gaps must be closed by
appropriate tests and observations rather than an assumed reviewer approval.

## 17 October continuation under delegated authority

The software-owner delegation remains the authority for product defaults and
engineering choices across organisations. Another response from the original
reviewer is optional. Use executable acceptance criteria and dated evidence to
finish engineering work; do not turn a missing reviewer into a technical blocker.

The further official-source check supports the existing choices:

- [Microsoft Purview disposition review](https://learn.microsoft.com/en-us/purview/disposition)
  separates pending review from the final decision to permanently delete.
  CharityPilot therefore keeps disposal authority separate from a recovery deadline.
- [Atlassian's cloud shared-responsibility model](https://developer.atlassian.com/developer-guide/cloud-shared-responsibility-model/)
  distinguishes platform and application responsibilities. CharityPilot owns its
  access defaults, enforced workflows and verification; customers adopt settings
  for their records through those controls.
- [Amazon S3 Object Lock](https://aws.amazon.com/s3/features/object-lock/)
  protects object versions under chosen retention modes. This supports independent
  evidence preservation, but a hash or synthetic SDK test does not establish
  actual locked retention, separate custody or a successful recovery.

Proceed with the durable credential baseline and original-observation retention
in [maintenance protocol4](durable-credential-read-baseline.md). Its exact
source/attempt/epoch/plan binding and acknowledged save-before-revocation barrier
are engineering choices under this delegation. Complete the remaining actual
write/capability fencing, common capture, restoration and provider/host-loss proof
in the agreed sequence. Do not require a fresh human decision to implement or
test those product contracts with synthetic data.

## Signing-key and capability maintenance

Use a separately reviewed asymmetric current signing key and exact previous-key
revocation for managed maintenance; do not implicitly create, promote or rotate
an active issuer. Keep the original provider acknowledgements separate from
fresh metadata observations. The [signing-key primitive](supabase-signing-key-control.md)
implements that narrow contract with no real-provider activation.

Do not infer Storage capability closure from Auth key metadata, ordinary API-key
refusal or nominal token expiry. Identify the actual Storage token issuer and
provider release and test issued capabilities directly before closing that gate.
In-flight commits, privileged capture credentials and external management actors
remain separate fencing requirements. This is an engineering decision under
delegated software ownership; no new reviewer or tenant-policy decision is needed
to implement and exercise the synthetic workflow.

## Managed S3 maintenance evidence

The closed maintenance policy keeps Supabase S3 disabled. The
[S3 capability probe](s3-capability-proof.md) tests an originally working key,
presigned PUT and multipart session through the actual SDK; it does not delete
keys or prove all sessions drained. Require native feature-specific data-path
responses, separate direct/gateway scopes and retained REST controls.

Do not enable an already-disabled S3 service or issue fresh credentials to create
a working baseline. Implement a distinct current-feature-exclusion observation
for that condition, with exact provider/route/endpoint evidence. Current disabled
state must never be labelled historical never-enabled or past credential
revocation. Actual supplier activation/authority remains a separate gate.

The distinct [current feature-boundary component](s3-current-feature-boundary-proof.md) is now implemented locally. It uses both endpoint profiles and real metadata-adapter reads with synthetic transports. Parent mode selection, mandatory fresh post-closure proof and actual provider evidence remain open; this establishes no tenant retention or disclosure policy.

Original S3 URL/UploadId [combined custody](s3-capability-custody.md) now composes locally with the active SDK probe. Keep historical inspection separate from execution acknowledgement, and isolate each endpoint/credential cohort in storage. Actual provider/IAM proof and complete parent integration remain required.

The [configured working S3 cohort](managed-s3-capability-cohort.md) is implemented locally. Require both endpoints for every configured reviewed key, preserve original acknowledgements and never infer complete issuer inventory. The already-disabled branch requires its own fresh PRE/POST evidence; no empty-cohort exemption is permitted.

The [durable current-disabled S3 branch](durable-s3-current-feature-evidence.md) requires fresh PRE and POST evidence without enabling S3 or issuing credentials. It cannot claim historical exclusion or replace originally working capability proof. Further common mode/coordinator integration remains required.

The [common S3 mode selector](managed-s3-maintenance-evidence.md) now requires a declared mode and binds actual metadata configuration. It cannot guess a mode or silently fall back after failed evidence. Mandatory default coordinator/control-head integration remains required.
