# Original outcome custody transfer

18 October 2026. Internal component for the independent custody-process handoff.
The default source runner still uses its existing process-local outcome writer.
There is no new operator command or activation flag.

## Authority and lifetime

`ManagedDaemonIntentCustody.createOwnerOutcomeTransfer` requires the original
live request, service, intent and owner acknowledgements. It consumes the same
one-shot slot as `createOwnerOutcomeWriter`; the two cannot be issued together.
Current header, intent and owner pins must still match. Failed or repeated issue
cannot be retried into another grant.

The frozen issuer exposes `take`, `claim` and `abandon` functions. Ordinary JSON
serialization of that handle contains no private payload. `take` returns one
bounded private ticket; it must travel only over protected same-host stdin/IPC.
The ticket contains existing SDK writer credentials, original record bindings,
a random nonce and an absolute deadline in the original host's monotonic clock.
Never log it, store it in a file, include it in a command line, or archive it as
recovery evidence. It is not a provider-scoped role or a new IAM grant.

The original issuer must still be live when it consumes the exact nonce and
ticket digest. The receiving adapter must authenticate the actual original
custody child, source revision, user, boot and invocation before asking the
issuer to claim. Saved records cannot answer this live challenge. After a
successful claim, the receiving process can retain its writer independently
of the source context. Its authority ends at the original 120-second deadline;
activation, retries or process startup cannot extend that deadline. This is a
same-host handoff, not a portable clock or replacement-host recovery token.

The frozen common-candidate context checks the original closed head/window
before and after issuing, taking or claiming. Failed checks abandon the issuer.
Abandonment prevents a new claim; it does not revoke an already activated
writer in another process. The receiving writer has its own local revocation
and expiry. Unknown claim acknowledgement must not trigger a second handoff.

## Receiving and retaining an outcome

`acceptOwnerOutcomeTransfer` requires an explicit trusted live-claim callback.
There is no default callback and no caller-selectable CLI shortcut. The callback
must use the original authenticated private transport; returning success from
saved metadata is not an implementation of that requirement.

Before any provider read, the receiver consumes that claim. It then verifies
the original header, intent and owner versions and local intent bytes using the
existing SDK store. Credential resolution, claim and provider reads are bounded.
Only one publish attempt is permitted. Publication retains the existing
conditional PUT, checksum, original owner/intent pairing and exact-version
readback checks. An accepted write with lost readback acknowledgement remains
independently inspectable and cannot be retried or replaced. The receiver closes
its owned SDK client on failure, completion, expiry or local revocation.

The result still grants no source-response ACK, daemon finality, cleanup,
historical completeness, tenant authority, archive admission or reopening.

## Verification and unfinished work

API regressions cover original-only issue, opaque handles, one-time claims,
tampered tickets, source closure before claim, post-claim source closure,
deadline preservation, stalled credential/claim resolution and accepted-write
ACK loss. These are component tests, not proof of an independent live process.
Exact source/test/deployment results are recorded in the private checkpoint.

The private claim socket component is described below. The actual custody user
service, original kernel authentication, outcome delivery and source-runner
integration remain unfinished.
Before activation, prove actual issuer SIGKILL after receiver readiness, outcome
retention by the surviving receiver, claim/response loss refusal and receiver
loss quarantine. Keep runtime credentials out of Docker workers and outcome
artifacts. Actual provider IAM and independent physical-host-loss recovery
acceptance remain separate required gates.

## Private claim channel component

`scripts/managed-outcome-claim-channel.mjs` creates an exclusive owner-only Unix
socket directory. The original caller binds one expected receiver input digest
before any connection is accepted. The packet carries only the original ticket
nonce/digest, job/source/receiver identity, a channel capability and a fresh
exchange nonce. It carries neither the private ticket nor cloud credentials.

A mandatory trusted verifier callback runs before and after consuming the
original live claim. Missing verification, changed identity, wrong capability,
wrong scope, timeout or lost acknowledgement refuses the channel. No second
attempt can revive it. The parent reports an acknowledgement as sent; only the
receiving client can report observing the exact nonce-bound reply. Neither
observation means the SDK writer is ready or a daemon request may run.

Both sides check monotonic deadlines directly. A synchronous kernel verifier
cannot postpone a timer callback and thereby consume an expired claim; the
deadline is checked before/after verification, before claim and before ACK.

Cleanup applies only to the original directory inode and expected socket name;
uncertain pending callbacks preserve the directory. No unit, PID, Docker object
or other job is removed. The service adapter must close the channel explicitly.

Linux native socket regressions use a test verifier and prove transport ordering,
privacy and failure handling only. The callback is not selectable by packet or
CLI input, has no permissive default, and must be wired to actual original
kernel/source verification before runtime use. The current source runner does
not use this channel yet. An independently managed custody process and its
provider-backed parent-death proof remain unfinished.
