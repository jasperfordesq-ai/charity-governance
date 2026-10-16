# Managed normal application runtime proof

The native gateway test now builds the actual gateway, compiled Next, API runner
and migration-runner Dockerfiles and exercises the API runner's default
`node dist/start.js` command. The final phase uses the normal route table.

## Configuration and isolation

Application containers are unprivileged, read-only and drop capabilities. Only
the gateway publishes a dynamically selected loopback port. Next, API and the
disposable PostgreSQL stay on the internal network. Docker children use the
verified local endpoint/runtime. Synthetic source labels and mesh identities
are test inputs, not release provenance or actual provider inventory.

The final API uses production Node/deployment mode, multiple organisations,
closed registration, manual-link email, no billing, local document storage and
required privileged MFA. Compiled web capability axes match. These are existing
supported choices: no CI smoke exception, disposable-E2E flag, fake Atlassian
endpoint or weakened validator is used. This proves the self-contained provider
configuration, not Resend, Stripe, Supabase, live Atlassian or public deployment.

The API image generates its enabled immutable root pin during its real build.
A synthetic root/group1000 secret volume is prepared before starting its normal
command and mounted read-only. Startup stages its own pinned server key.
Migration, role-probe and seed jobs receive only the public database CA; they
do not receive the API private key.

PostgreSQL has ephemeral owned data and a synthetic DNS-valid server certificate.
Local unix-socket administration handles only disposable setup. Application,
migration and role-probe connections use SCRAM and real verified TLS. The test
applies the complete migration chain and asserts the database count, reconciles
existing runtime grants and executes the actual post-migration role catalogue
probe from the API image. The normal API connects as cp_runtime.

## Normal application observations

The fixture creates two synthetic organisations, each with one active Owner,
an active subscription, Members and reviewed test documents. These are fixture
inputs, not real governance approvals. It checks through Caddy:

- Normal health; readiness refuses a missing key and accepts the exact
  capability, reporting database, recovery control, storage and build readiness.
- Real login and signed session cookies; Member auth-me succeeds.
- Member listing includes its reviewed file and excludes a restricted draft
  and the other charity's reviewed file.
- Exact reviewed bytes download for the owning tenant's Member. Both directions
  of cross-tenant access refuse, with a successful same-object control by its
  own tenant's Member.
- Compiled Next validates the real session through its restricted mTLS client.
- Owner login requires MFA enrolment; privileged API access refuses and Next
  directs the unenrolled Owner to the canonical security setup page.
- Application database sessions use TLS; readiness credentials are absent
  from API logs; normal shutdown succeeds.

Earlier phases still use synthetic echo routes for transport and fault probes.
The early echo web shares the first API fixture container. Do not describe that
phase as a complete container key-isolation audit.

## Application headers and transport identity

Normal readiness exposed blanket deletion of X-CharityPilot headers. The shared
policy now preserves exactly the defined readiness key, action-approval reference,
connector client marker, activity reason and reason encoding. Values remain
untrusted inputs checked by application middleware; preserving them grants no
user, organisation, approval or mesh role.

The gateway snapshots only those fields into request-local variables, deletes
proprietary headers and restores only present defined fields. An explicit Caddy
route preserves ordering. API and web independently apply the same allowlist.
Unknown proprietary headers and forged forwarded/role/address claims still
disappear. Mesh roles come exclusively from real certificates and private state.

A source-derived unit contract covers the application's request-header names.
Actual TLS/Caddy requests check preservation and forged-claim removal. Approval
and reason values are redacted from ordinary API log header containers; reasons
still enter their explicitly authorised activity audit. Caddy failed-TLS logs
exclude capability/query canaries. Startup logs identify the actual transport.

References: [Caddy route ordering](https://caddyserver.com/docs/caddyfile/directives/route),
[request headers](https://caddyserver.com/docs/caddyfile/directives/request_header),
[variable matchers](https://caddyserver.com/docs/caddyfile/matchers#vars-regexp).
The actual image test checks the generated configuration beyond syntax alone.

## Remaining evidence

This is local application evidence with synthetic data and keys. It provides
no public TLS edge, browser journey in this mode, real provider mount/IAM/custody,
issuance/rotation or independently administered recovery proof. Provider-backed
storage/mail/billing tests, verified end-user address policy, source provenance,
independent current authority and document bytes, physical source-host-off,
old-writer exclusion and safe reopening remain required. Existing private VM
evidence belongs to a different profile/version. The shape-only hosting blueprint
remains non-deployable.
