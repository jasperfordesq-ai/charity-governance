# Capture SQL role boundary

18 October 2026. Internal read-only catalogue check. No live role, JWT, provider
grant, policy or migration is created or changed by this component.

## Decision and provider contract

Use an explicitly reviewed custom role for a future least-privilege capture lane.
Keep the existing privileged server-key lane for its current canary controls;
read-only requests alone do not establish read-only credential authority.

Supabase documents [custom Storage roles](https://supabase.com/docs/guides/storage/schema/custom-roles)
and role-scoped bucket reads. Its example includes membership in `anon`; this
boundary deliberately requires direct SELECT grants with no outgoing membership,
so inherited or switchable write authority cannot be hidden in that example.
An incoming grant allowing the authenticator to select the custom role is a
different direction and does not by itself make that role a member of another.

The reviewed public Storage source is commit
`c826a70ac6e6f56d3e6033ccb164fb1ff5282570`. Its
[JWT plugin](https://github.com/supabase/storage/blob/c826a70ac6e6f56d3e6033ccb164fb1ff5282570/src/http/plugins/jwt.ts)
verifies incoming tokens, and its
[transaction scope](https://github.com/supabase/storage/blob/c826a70ac6e6f56d3e6033ccb164fb1ff5282570/src/internal/database/postgres/scope.ts)
sets the selected role and request claims locally. Its
[private download handler](https://github.com/supabase/storage/blob/c826a70ac6e6f56d3e6033ccb164fb1ff5282570/src/http/routes/object/getObject.ts)
uses the request context for private-object lookup; the public bucket branch has
different authority. This is source-contract research, not proof of the hosted
project's deployed release or effective JWT identity. Generated server S3 keys
are also broad credentials according to [S3 authentication](https://supabase.com/docs/guides/storage/s3/authentication).

## Implemented observation

`ManagedStorageDatabaseInventory.observeCaptureRoleBoundary()` uses the existing
bounded, TLS-checked PostgreSQL 16 Repeatable Read / READ ONLY observation. All
facts and additional authority checks share that transaction. It requires:

- Exact configured capture role name/OID, NOLOGIN, NOINHERIT and no superuser,
  role/database creation, replication or BYPASSRLS attribute.
- No membership with the capture role as member, including NOINHERIT SET ROLE
  paths. Incoming memberships do not pass through this test as outgoing ones.
- SELECT on each configured ordinary RLS-enabled relation, with no effective
  table or column mutation, TRUNCATE, REFERENCES or TRIGGER privilege.
- No ownership of a database, schema, relation or routine, or effective database
  CREATE / schema CREATE privilege. System schemas are included in this check.
- No executable non-system SECURITY DEFINER routine from the bounded inventory,
  and no executable SECURITY DEFINER routine hidden in system schemas.

The new result binds the original inventory digest and additional authority facts
under its own observation digest. Existing `observe()` output remains a plain
inventory. No passwords, token bodies or function bodies are read; no inventoried
routine is executed. Failures are sanitised and grant no authority.

## Proof limits and next integration

`configuredCaptureSqlReadOnlyObserved` describes the predicates returned by the
bounded catalogue observation. Effective permission lookups are not a lock on
concurrent DCL; this does not establish an atomic privilege interval. The result still reports false for provider-token role verification,
full bucket visibility, capture-credential read-only verification, all-writer
inventory, global quiescence and action authority. It is not a held privilege
fence: an administrator can change grants during or after the observation.
`privilegeIntervalHeld` and `privilegeChangesExcluded` remain explicitly false.

This does not prove RLS row coverage, arbitrary invoker-routine/external effects,
provider control-plane exclusion, JWT issuer shutdown, in-flight drainage,
object-byte immutability, current independent authority or host-loss recovery.
Other roles, including privileged controls, may still write. The existing capture
class still accepts its original credential-bound server key; this check does not
silently replace its authentication model.

Next join a cryptographically verified, explicitly configured custom-role JWT to
this exact SQL identity and a guarded unchanged privilege interval, then prove
actual authenticated list/download visibility plus write refusals against the
reviewed provider release. Keep any JWT signing root outside the capture worker.
Actual provider setup, new grants, spend and tenant disclosure require their own
authority; this source work does not perform them.

Unit counterexamples and disposable TLS PostgreSQL execution cover the SQL
boundary. Exact revisions and executed results are recorded privately; a test
definition or provider documentation alone is not acceptance evidence.
