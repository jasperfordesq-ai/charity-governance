import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

/**
 * The shape of the client activity record, checked statically.
 *
 * The append-only behaviour itself is proved against a real database in the
 * live suite; what is checked here is that the migration still says what it is
 * meant to say. A table that quietly lost its trigger would otherwise keep
 * every test green while becoming editable by the party it records.
 */
const migration = readFileSync(
  new URL(
    "../../prisma/migrations/20260919230000_add_client_activity_event/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const schema = readFileSync(
  new URL("../../prisma/schema.prisma", import.meta.url),
  "utf8",
);

const require = createRequire(import.meta.url);
const { DISPOSABLE_DATABASE_RESET_TABLES } = require(
  "../../../../e2e/helpers/database-safety.cjs",
) as { DISPOSABLE_DATABASE_RESET_TABLES: readonly string[] };

test("the record is append-only in the database, not merely by convention", () => {
  assert.match(
    migration,
    /CREATE FUNCTION "reject_client_activity_mutation"\(\)/,
  );
  assert.match(
    migration,
    /CREATE TRIGGER "ClientActivityEvent_append_only"\s*\r?\n\s*BEFORE UPDATE OR DELETE ON "ClientActivityEvent"/,
    "both UPDATE and DELETE must be rejected; rejecting one is not append-only",
  );
  assert.match(migration, /ERRCODE = '55000'/);
});

test("a row cannot name a user from a different charity", () => {
  assert.match(
    migration,
    /FOREIGN KEY \("userId", "organisationId"\) REFERENCES "User"\("id", "organisationId"\)/,
    "the user reference is composite, as the audit table's is",
  );
});

test("the session is referenced by value, so the record outlives the session", () => {
  assert.doesNotMatch(
    migration,
    /REFERENCES "AuthSession"/,
    "a foreign key here would delete the evidence when the session expired",
  );
});

test("the migration carries nothing the blue-green gate blocks", () => {
  assert.doesNotMatch(migration, /SET NOT NULL/);
});

test("the table is cleared between isolated runs, or every run would fail closed", () => {
  assert.ok(
    DISPOSABLE_DATABASE_RESET_TABLES.includes("ClientActivityEvent"),
    "a table absent from the reset list makes the isolated stack refuse to start",
  );
});

test("the Prisma model matches the columns the migration creates", () => {
  const model = schema.match(/model ClientActivityEvent \{[\s\S]*?\n\}/)?.[0];
  assert.ok(model, "the model must exist in the schema");

  for (const field of [
    "organisationId",
    "userId",
    "sessionId",
    "clientKind",
    "accessLevel",
    "method",
    "routePattern",
    "resourceId",
    "statusCode",
    "requestId",
    "reason",
    "occurredAt",
  ]) {
    assert.ok(
      new RegExp(`\\n\\s+${field}\\s`).test(model),
      `${field} is in the migration but not in the model`,
    );
    assert.ok(
      migration.includes(`"${field}"`),
      `${field} is in the model but not in the migration`,
    );
  }

  // The reason a client gave for a write is optional; everything that
  // identifies the write is not.
  assert.match(model, /reason\s+String\?/);
  assert.match(model, /routePattern\s+String\b(?!\?)/);
  assert.match(model, /statusCode\s+Int\b(?!\?)/);
});
