# Managed private web transport

The private Node/Next web service now uses the same canonical
[format2 mesh record](managed-service-mesh.md) as the gateway and API. The older
V1/HTTP scaffold is superseded. This implements and tests the transport; no
managed provider environment is activated by the change.

## Immutable image and runtime binding

Build the actual `apps/web/Dockerfile` with the full source SHA, canonical public
API and web origin, `public-production` mode and the non-secret
`NEXT_PUBLIC_CHARITYPILOT_MANAGED_WEB_BINDING_SHA256`. Only the fingerprint is
public; registry JSON and PEM material must never be public build arguments.
The image writes `/opt/charitypilot/managed-web-build.json` as root, mode0444,
before switching to node. An unconfigured legacy image has a disabled pin.

`loadManagedWebTls` reads this fixed file before Next prepares. An enabled pin
requires the exact shared registry, public compiled/runtime values, source,
Render private-service identity and port3003. Removing all runtime managed flags
from an enabled image is a startup refusal, not an HTTP fallback. API startup
uses the same protected image-pin reader and preserves this invariant.

Runtime variables include `CHARITYPILOT_MANAGED_PROVIDER=render`, exact canonical
`CHARITYPILOT_MANAGED_WEB_BINDING`, build source, Render service ID/type, public
origin/mode/fingerprint values, and `CHARITYPILOT_INTERNAL_API_URL` equal to the
registry's private HTTPS API origin.

## Protected identities

- `CHARITYPILOT_MANAGED_WEB_TLS_DIRECTORY`: issuer.pem, server.pem, server.key.
- `CHARITYPILOT_MANAGED_WEB_API_TLS_DIRECTORY`: issuer.pem, client.pem, client.key.

Each directory must satisfy the shared protected Linux reader: canonical,
outside application source, node-owned0700 directory and0400 single-link files,
held-directory/no-follow bounded descriptor reads. Do not substitute a provider's
shared-readable secret mount or relax the permissions. Private server and client
keys are distinct. Material is verified against the pinned CA, exact leaf DER,
validity, key match and intended certificate usage; server SAN must exactly
match its registry hostname without CN or wildcard fallback.

The web HTTPS listener requires TLS1.3 and the exact gateway client certificate.
It refuses unverified, resumed, expired or unpinned peers and wrong public Host
before Next dispatch. Forged forwarded/address/service-role claims are removed.
A service socket address does not establish the end-user address.

## Read-only server authentication check

Protected Next routes use `managedWebAuthMe`, not global fetch or a public-origin
fallback. Its Node HTTPS agent presents only the web client certificate, validates
CA, DNS and the exact API server leaf, requires TLS1.3 and disables TLS session
caching. Ordinary keepalive is allowed. API independently limits this identity
to exact GET `/api/v1/auth/me`; it grants no ordinary user/tenant authorisation.

Only selected auth cookies enter the call. There is no refresh, redirect follow
or retry. Total deadline is five seconds, response bytes are capped at65536 and
bodies are discarded. Only Retry-After and the MFA setup indicator are copied.
Existing proxy semantics distinguish200,401 and unavailable/throttled responses.
Clients and sockets are closed on shutdown. Missing or mismatched configuration
fails closed; legacy profiles retain their existing fetch and HTTP server paths.

## Verification and remaining gates

`test:managed-web-tls` proves real Node TLS gateway identity and refusal, header
stripping, image-pin canonicalisation and disabled/partial startup behaviour.
`test:managed-gateway` builds both the real gateway and compiled Next images and
runs them with the compiled API loader under synthetic certificates. It exercises
Next login/protected routes and the private auth check, image downgrade refusal,
API role observation and browser-asset exclusion of registry/certificate/private
origin canaries. The API routes are synthetic: this is not a complete production
business/provider boot or a real browser/public TLS test.

Actual provider setup, full production environment/provider boot, protected key
issuance/delivery/custody/rotation/revocation, verified end-user address handling,
independent recovery and source-host-loss/reopening evidence remain required.
The shape-only hosting blueprint remains non-deployable. No real certificate,
access grant, tenant policy, provider purge or deployment is implied.


## Optional provider secret-file staging

The normal entry point supports the service-scoped
[TLS delivery contract](managed-tls-delivery.md). It validates the pinned bundle
before creating protected runtime directories. Direct protected-directory input
remains available when this delivery selector is absent. Actual provider mount
permissions, key custody, issuance and complete rotation/recovery evidence remain
required; synthetic staging is not evidence that those gates have passed.


## Normal application phase superseding earlier transport-only limits

The native test now also builds the actual enabled API runner and boots its
normal command with the complete migrated TLS database and production validators.
It exercises real synthetic tenant sessions, Member byte access/isolation,
compiled Next authentication and required privileged MFA. This self-contained
provider configuration supplements the earlier synthetic-route phases above.
See [normal runtime proof](managed-application-runtime-proof.md), including the
application-header policy. External providers, public browser/edge, real key/IAM
custody, independent recovery and host-loss/reopening remain open.
