## 17 October: native Storage grant/capture-window evidence

Read [Storage grant and capture-window proof](storage-grant-capture-window-proof.md).
Native TLS PostgreSQL counterexamples now cover in-flight commits after table
REVOKE, column/function/SET ROLE authority, observed lock/drain ordering and a
read-compatible SHARE window. Positive reads and precise 42501 refusals passed.
This is synthetic SQL evidence, not a hosted Storage fence or completed common
capture. Actual provider contract, object-byte/background writers and full
privileged actor coverage remain open. Full delegated goal remains active.

# Remaining managed writer and capture boundaries

17 October 2026. Bounded source/provider-contract audit after protocol9 S3
integration. This is not complete provider inventory, hosted assurance or DPO
acceptance. No cloud permissions, policies, keys or real records were changed.

## Current source and missing evidence

| Boundary | Evidence now present | What remains unproven |
| --- | --- | --- |
| Reviewed modern API keys | Original read/write controls, exact registry closure and retained positive controls | Retained capture/control key write authority and every external credential holder |
| Reviewed signed capabilities | Original encrypted upload/TUS custody, trusted issuer checks, revocation and native refusal reports | Current issuer/session issuance, all other JWT/capability families and actual hosted issuer/release |
| S3 | Mandatory protocol9 original-baseline/fresh-report barrier; both configured working and explicit current-disabled modes | Complete issuer inventory, unknown multipart/in-flight effects and all control-plane actors |
| Candidate file capture | Repeated inventory/byte checks with credential-bound configuration and quarantine-only output | Global snapshot point, unfiltered visibility, provider identity/privilege and read-only credential authority |
| Database/application fence | Real PostgreSQL role/session/password and native coordinator proof under synthetic provider transports | A common whole-backend capture boundary with all file/control-plane/in-flight writers excluded |

## Retained server credential is still a writer risk

Current [provider API-key guidance](https://supabase.com/docs/guides/getting-started/api-keys)
identifies modern server secret keys with `service_role`, which bypasses RLS.
Table grants are checked separately and can deny access; a restrictive RLS policy
alone cannot establish a read-only secret key. [Storage access-control guidance](https://supabase.com/docs/guides/storage/security/access-control)
also describes service-key bypass. These are general provider contracts, not
attestation of this project's actual grants or deployed Storage implementation.

The source deliberately retains a server key for successful post-closure read
and write controls. That proves those controls work and prevents generic outage
from masquerading as credential exclusion. It does not exclude the control key
itself as a writer. The candidate capture class makes read operations, including
semantic read-only POST listing, while the credential can still have additional
write authority outside those calls. Do not relabel it least-privileged because
its request implementation is read-only.

## Concrete source correction: credential-bound candidate provenance

`SupabaseRecoveryCapture` now requires a declared credential UUID and SHA-256,
checks the supplied secret matches before HTTP, and uses configuration format2 /
SUPABASE_PRIVATE_CAPTURE_CREDENTIAL_BOUND_V2. Its digest therefore cannot alias
between different supplied keys or credential declarations for the same bucket.
The credential-read proof passes its already validated registry entry to each
canary reader. The encrypted archive integration supplies the exact declared
capture binding as well. No bare unbound legacy constructor fallback is accepted.

Candidate output records the credential ID/hash, read-only request mode and
conservative privileged-server-key capability classification. Hash matching is
explicitly true; provider identity verification, privilege verification, writer
exclusion, whole-storage quiescence and action authority remain false. A declared
ID/hash is not a verified provider registry receipt. No raw key enters the result
or digest input serialisation. Existing archive/restore formats and original
historical receipts are not rewritten.

## Current signing key is not an issuer shutdown

The signing-control registry retains a current key while revoking reviewed old
keys. [Supabase signing-key guidance](https://supabase.com/docs/guides/auth/signing-keys)
describes continued issuance for signed-in sessions and distinguishes rotation
from revocation. A previous-key refusal cannot establish that a current issuer,
refresh/session path or externally retained token can no longer write. Nor does
JWKS absence alone prove a particular data-path refusal; local caches may retain
keys. Actual auth configuration, issuer inventory and originally working
JWT/session data paths still require scoped evidence. Do not assume the live
project uses, or does not use, user-session Auth without verifying its settings.

## Next engineering work

Before admitting a common database/files set as complete, identify a supported
read-only capture identity or provider export lane and verify actual authority,
not just request behaviour. Inspect the current Storage backend role-selection,
SQL grant/function/ownership and auth configuration contracts before building a
capture privilege fence. It must cover every retained writer and preserve the
positive controls needed for earlier refusal proofs; applying RLS alone to a
BYPASSRLS role is insufficient.

In parallel with that design, retain explicit JWT/session/other-capability,
in-flight, management-actor and hosted release/IAM requirements. Stable repeated
reads cannot exclude an A-to-B-to-A write or a delayed previously dispatched
operation. Common capture, orphan/pending cleanup, independent catalogue/current
preservation-disposal authority, full application quarantine restore and actual
provider/source-host-off/guarded reopening remain in the full goal. Further
personal Nikita review is optional under software-owner delegation; this audit
creates no new reviewer or login dependency.
