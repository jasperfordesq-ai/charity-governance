# Risk verification ordering and consistent recovery

Status: candidate verified in disposable PostgreSQL; exact-release CI backup
proof and live deployment remain required.

Risk verification history keeps its existing unique integer `sequence` cursor.
Historical evidence and cursor values are not rewritten. A migration-owned
singleton counter allocates new values through the database column default,
in the same transaction as the inserted evidence. Existing application clients
omit the field and continue to use that default.

PostgreSQL sequences are non-MVCC and do not roll back with their transaction
([PostgreSQL isolation documentation](https://www.postgresql.org/docs/16/transaction-iso.html)).
The read-only snapshot-bound recovery proof deliberately refuses such state.
The transactional counter resolves that incompatibility without relaxing the
backup verifier. Both the counter and audit rows are ordinary snapshot data.

## Upgrade and operational effects

The migration holds an exclusive evidence-table lock with a ten-second lock
timeout. It seeds the counter above both recorded evidence and the previous
allocator's high-water value, changes the default and removes the unreferenced
sequence atomically. It does not alter or delete evidence. Lock acquisition
failure aborts the migration; it is not permission to bypass deployment gates.

Concurrent allocations serialize on one counter row. This is suitable for
low-volume governance evidence; monitor contention if that workload changes.
Missing or exhausted counters fail closed. No runtime path reseeds one from
partial history. The integer limit is unchanged. Do not interpret allocation
gaps as missing evidence or claim gapless numbering.

## Rollback and verification

Application-image rollback retains the compatible forward schema. The SQL in
`e2e/fixtures/risk-verification-order-rollback.sql` is a disposable regression
fixture, not an operator recovery command. It tests restoring the prior
allocator without changing evidence or reusing committed numbers. Returning
to that schema also returns the old snapshot-proof limitation.

The managed database test covers populated upgrade, rollback, another upgrade,
unchanged historical records, continued allocation above the old high-water,
append-only rejection, transaction rollback, eight concurrent allocators and
repeatable-read snapshot visibility. The test harness preserves this
migration-owned singleton while resetting disposable application data.

Passing those checks is not backup/restore evidence or production acceptance.
The canonical CI backup proof, exact deployment and post-deploy checks remain
release gates. Supported private-host recovery procedures remain unchanged.
