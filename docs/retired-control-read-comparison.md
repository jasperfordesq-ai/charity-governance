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

## Integration still required

The component is not wired into format-11 retirement, current coordinator
inspection or capture. Their current metadata-only refusal flags stay false.
Before that integration:

1. Version and pin the probe's public configuration in the retirement policy.
2. A fresh original conditional retirement intent ACK must precede any baseline
   credential GET. Do not run baseline first on a fresh caller: after a prior
   retirement that would replay the old secret's positive-control probe.
3. Retain the resulting canary baseline in a separate immutable, exact-version
   artifact and obtain its original ACK before DELETE. The existing request and
   report guard cannot substitute for that additional evidence.
4. After the original DELETE ACK, verify the bracketing comparison and retain
   its report together with the exact original baseline pin. Unknown intent,
   baseline, DELETE or report ACK must retain distinct unresolved outcomes.
5. Provide strict public-data-only baseline/report validators for cold readers.
   Historical inspection must not instantiate an expired original JWT, require
   the retired secret, refresh credentials or reconstruct an original ACK.
6. Carry the resulting retirement/credential evidence into the new capture,
   source-job, archive and cold-reader binding. Existing capture formats cannot
   silently imply that coverage.

Synthetic tests use real asymmetric JWT signatures and the actual capture
reader implementation, with modelled HTTP transports. They are not live
Supabase permission, propagation, signer-currency, independent-IAM or physical
host-loss acceptance. Exact source/tests/CI/deployment state is recorded privately.

## Provider design references

Supabase's [custom Storage role example](https://supabase.com/docs/guides/storage/schema/custom-roles) supplies the JWT through Authorization directly to StorageClient. Its [self-hosted authentication guide](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys) explicitly describes Storage accepting requests without an API key. These support investigating this transport design; neither attests the actual hosted project's gateway, deployed signing key, SQL permissions or post-retirement behaviour. Those still require direct approved-target tests.
