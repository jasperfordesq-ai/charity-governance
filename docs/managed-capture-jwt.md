# Explicit custom-role JWT capture (18 October 2026)

The internal `SupabaseRecoveryCapture` component now accepts a separate,
versioned `SUPABASE_CAPTURE_CUSTOM_ROLE_JWT_V1` authentication configuration.
This is an engineering component; no application route or scheduled job enables
it. Existing server-key configuration and transport keep their original behavior.

## Trust and lifetime

The caller supplies a public ES256 P-256 or RS256 2048–4096-bit JWK, exact key ID,
project, subject and dedicated SQL role name/OID. The component verifies the
signature, exact project issuer, authenticated audience, subject, role and a
maximum ten-minute lifetime. It rejects private keys, shared-secret algorithms,
key URLs, extra or duplicate claims and noncanonical JSON. Only the minimal
claims iss/aud/sub/role/iat/exp and optional nbf are supported; this is not a
parser for arbitrary ordinary Auth sessions. No signer, refresh or JWKS fetch
runs in the worker. Both wall time and a pinned monotonic deadline bound reads
and visitor cancellation. Credentials are private fields and excluded from JSON.

Requests use Bearer authentication, the fixed project HTTPS origin and no apikey
fallback. The configuration digest has a new version, and results use
`SUPABASE_READ_ROLE_CANDIDATE_CAPTURE_V1`. The legacy maintenance registry and
archive schema refuse this new mode until its distinct authorization protocol
and guarded privilege interval are implemented.

## Evidence limits

A verified signature means trust against the supplied public key. It does not
prove that the provider currently accepts that key, that the SQL OID belongs to
the token role, or that grants stayed fixed throughout capture. Reports explicitly
keep those claims false. RLS may hide rows; stable repeated reads do not prove
complete bucket visibility, global writer exclusion or restore authority.

The SQL role observer is a separate bounded observation. The native composition
test verifies a real asymmetric JWT, uses its role in actual TLS PostgreSQL
transactions, reads through RLS and checks SQLSTATE 42501 on mutation. Its HTTP
transport is a synthetic provider model, not hosted Supabase Storage.

Provider configuration must separately cover SELECT/RLS for both bucket metadata
and objects, actual deployed Storage behavior, current signing-key authority,
unfiltered visibility and an unchanged privilege interval. No provider role,
policy or key is provisioned by this component. See [SQL role boundaries and
provider sources](managed-capture-read-role-boundary.md).
