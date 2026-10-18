# Retired control-key canary read comparison

## Scope — 18 October 2026

`SupabaseRetiredControlReadProof` is an internal GET-only component. It compares
one configured modern secret key with a separately supplied, cryptographically
verified custom-role JWT reader on the same pre-existing synthetic canary.
It creates no canary and changes no key, role, file, policy or provider setting.

The bucket is exactly `charitypilot-recovery-canaries`; paths must remain below
`charitypilot-recovery-canary/<installation>/`, with bounded segments and no
traversal, encoded separators, backslash or control characters. Both readers
must see the exact private bucket and expected text/plain bytes, size and hash.
The JWT reader is pinned by configuration digest, project, installation, subject
and declared SQL role/OID. A legacy key cannot be supplied as that positive
reader. The retired key is pinned by ID and SHA-256; raw credentials stay in
private fields and never appear in evidence or errors.

The baseline reads JWT → configured secret → JWT successfully. Verification
checks that bounded canonical baseline, then reads JWT → retired-key GET → JWT.
Only HTTP 401 or 403 for the exact retired-key canary object GET can count.
Both surrounding JWT reads must still match the original private canary, and
both local JWT verification records must agree. Redirects, 404, throttling,
server errors, still-readable keys, missing/changed positive controls and JWT
expiry refuse the comparison. Provider error bodies are cancelled, not parsed.
A caller abort or bounded deadline rejects stalled requests; late responses
cannot trigger a later positive read or produce evidence.

The result proves **the tested synthetic canary GET refusal only**, under the
configured credential view and local public-key trust. It does not establish
provider-wide key revocation, write rejection, deployed/current signing keys,
SQL role authority or privilege interval, unfiltered object visibility,
in-flight request drainage, whole-Storage quiescence or action authority.
Those flags remain false. Baseline acknowledgement verification also remains
false: caller-supplied JSON/hash alone cannot establish original durable custody.

## Format-12 custody integration

An explicitly configured format-12 coordinator now pins the public comparison
descriptor and version-2 retirement configuration. Formats 9–11 keep their
existing behaviour. The sequence is:

1. Obtain the original conditional retirement-intent ACK before any baseline
   credential GET. A fresh caller conflicts on that same intent before probing.
2. Read the canary baseline with both configured credentials and persist it in
   the separate immutable `capture-control-read-baseline.json` object. Its exact
   version, checksum and original ACK must be known before DELETE.
3. Perform the one original named-key DELETE, verify the bracketing canary GET
   refusal, and retain a version-2 retirement report pinning both original
   intent and canary-baseline records.
4. Preserve distinct unresolved outcomes for unknown intent, baseline, DELETE
   and report ACKs, or failed comparison. Saved reads never permit replay.

Public-data-only validators now check the exact configuration/reader digest,
canary, baseline, declared role, signing-key fingerprint, times and observation
hash. Historical inspection can use the public descriptor and saved records
without the retired secret or an active/expired original JWT object. It checks
the saved signature-verification record; it does not reverify a discarded token's
signature or recover an original ACK. Current key absence is a separate metadata
observation; current canary comparison is not replayed by cold inspection.

Still required: carry these retirement, baseline and comparison pins through a
new common-candidate/request/report, canonical source, job, archive and current
cold-reader binding. Existing capture formats and current candidate discovery
explicitly refuse formats 11 and 12. Actual provider propagation/current signing
keys, role/project authority, independent IAM and physical-host-loss proof also
remain open. No route or tenant automatically opts into format 12.
Synthetic tests use real asymmetric JWT signatures and the actual capture
reader implementation, with modelled HTTP transports. They are not live
Supabase permission, propagation, signer-currency, independent-IAM or physical
host-loss acceptance. Exact source/tests/CI/deployment state is recorded privately.

## Provider design references

Supabase's [custom Storage role example](https://supabase.com/docs/guides/storage/schema/custom-roles) supplies the JWT through Authorization directly to StorageClient. Its [self-hosted authentication guide](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys) explicitly describes Storage accepting requests without an API key. These support investigating this transport design; neither attests the actual hosted project's gateway, deployed signing key, SQL permissions or post-retirement behaviour. Those still require direct approved-target tests.

## 18 October integration update

Plan 12 now uses [candidate format 5 and original-record cold discovery](managed-retired-control-common-candidate.md). This supersedes earlier pending-integration notes above. Plan 11 remains refused. Actual native format-5 execution and provider/current-authority/host-loss acceptance remain open.
