# Managed Storage database authority inventory

The bounded [capture preflight command](managed-capture-preflight.md) exposes
catalogue ACL compatibility observations without authorising capture or acquiring
locks. The broader inventory and actual lock-window contracts below remain
separate; a successful diagnostic does not replace them.

17 October 2026. Internal read-only discovery component, not an activated provider
adapter, operator command, permission fence or common database/file snapshot.

## Contract

`ManagedStorageDatabaseInventory` accepts a separately trusted database name/OID,
observer name/OID, capture-role name/OID and 1â€“16 exact schema/name/relation OIDs.
The supplied Prisma connection must independently verify the intended TLS host;
the catalogue identity checks do not establish provider/project identity.

`observe()` uses a bounded Repeatable Read transaction with READ ONLY set before
catalogue queries and pins the transaction-local search path to `pg_catalog`.
It verifies TLS, exact observer/session identity, database and
PostgreSQL 16. Different versions are deliberately unsupported until tested.
No caller SQL or inventoried routine is executed. No grant/revoke or role change
is made, and no document data, password/verifier, function body or request claim
is read.

The report contains:

- Up to 256 roles, including LOGIN, superuser, role/database creation, replication,
  BYPASSRLS and INHERIT attributes, including privileged custodians.
- Exact configured ordinary table identities, owners and RLS flags. Partitioned,
  inherited, missing or mismatched relations refuse instead of implying coverage.
- Effective SELECT and mutation/REFERENCES/TRIGGER privileges for each role/table,
  including any-column INSERT/UPDATE/REFERENCES. Table-level absence alone is not
  treated as absence of column authority.
- Up to 512 direct membership records with grantor and PostgreSQL 16 ADMIN,
  INHERIT and SET options. These records are not a computed complete attack graph.
- Up to 256 SECURITY DEFINER routines in non-system schemas, owners and every
  inventoried role with EXECUTE. Include routines conservatively without guessing
  their table dependencies or executing them. System-schema definers, invoker
  routines, extensions and external control-plane authority are not covered.

Every bounded query reads an extra row and refuses overflow; configured role/table
matrix cardinality is checked. Output binds configuration, identities and facts
with SHA-256. It never marks a grant change, held metadata window, least-privilege
capture credential, complete writer inventory, global quiescence or action
authority as established. The digest is observation integrity, not a trusted
provider signature or independently retained receipt.

PostgreSQL documents effective privilege functions, including column-level grants,
and the membership options:
[privilege inquiry functions](https://www.postgresql.org/docs/16/functions-info.html),
[membership catalogue](https://www.postgresql.org/docs/16/catalog-pg-auth-members.html).

## Executed coverage

The existing native TLS/disposable PostgreSQL regression now invokes this actual
component during the [grant/capture-window counterexamples](storage-grant-capture-window-proof.md).
It detects column-only INSERT, changes to SECURITY DEFINER EXECUTE, NOINHERIT
membership with explicit SET ROLE, owners and a still-writing superuser. Positive
SELECT and direct-write refusal are compared with the catalogue report. A separate
non-superuser observation checks that discovery does not need a superuser observer.
A hostile ambient search path with a user-defined privilege predicate cannot
mask the real grants, and the connection setting survives the local override.
It refuses wrong database/role/relation identities, duplicate relations,
partitioned relations and function-inventory overflow. Unit tests cover malformed
configuration, configuration mutation, sanitised failures, TLS/read-only checks
and unsupported versions before later catalogue reads.

## Remaining integration

A catalogue observation does not drain transactions, hold a capture window, stop
concurrent authority changes or close indirect write paths. Do not promote this
report into permission to capture, dispose, restore or reopen. Provider-supported
DB/Storage identity and release mapping, complete relations and indirect actor
coverage, a read-compatible interval and object-byte/cleanup/in-flight controls
remain required. Existing protocol9 positive controls are unchanged.

Supabase explicitly excludes Storage objects from database backups; metadata
capture alone cannot satisfy whole-backend recovery.
[Provider backup contract](https://supabase.com/docs/guides/platform/backups).
Continue from the [remaining writer/capture boundaries](managed-writer-capture-audit-2026-10-17.md).
