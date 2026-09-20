import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

/**
 * The shape of the approval record.
 *
 * This row is the only thing standing between an agent and a deletion, so the
 * rules that make it single-use and short-lived are asserted here rather than
 * left to the code that reads it.
 */
/**
 * The table as the pair of migrations leaves it.
 *
 * The second one renames the session column to the session FAMILY column,
 * after the live suite showed that an approval bound to a single session row
 * is dead before anyone can type a password: rotation mints a new row on every
 * refresh. Both files are read together because together they are the table.
 */
const migration = [
  "20260920000000_add_auth_action_approval",
  "20260920010000_approval_binds_to_session_family",
  "20260920050000_add_approval_resource_id",
]
  .map((name) =>
    readFileSync(
      new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url),
      "utf8",
    ),
  )
  .join("\n");
const schema = readFileSync(
  new URL("../../prisma/schema.prisma", import.meta.url),
  "utf8",
);

const require = createRequire(import.meta.url);
const { DISPOSABLE_DATABASE_RESET_TABLES } = require(
  "../../../../e2e/helpers/database-safety.cjs",
) as { DISPOSABLE_DATABASE_RESET_TABLES: readonly string[] };

test("only one live approval can exist per session and request", () => {
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "AuthActionApproval_live_digest_key"[\s\S]*?WHERE "consumedAt" IS NULL/,
    "without this an agent could collect several approvals for the same action "
      + "from one distracted person and spend them one after another",
  );
});

test("an approval cannot be consumed before it was approved", () => {
  assert.match(
    migration,
    /CHECK \("consumedAt" IS NULL OR "approvedAt" IS NOT NULL\)/,
  );
});

test("an approval cannot be granted after it has expired", () => {
  assert.match(
    migration,
    /CHECK \("approvedAt" IS NULL OR "approvedAt" <= "expiresAt"\)/,
  );
});

test("the approval is bound to a session family, which survives rotation", () => {
  assert.match(migration, /"sessionId" TEXT NOT NULL/, "created under the old name");
  assert.match(
    migration,
    /RENAME COLUMN "sessionId" TO "sessionFamilyId"/,
    "a session row lasts fifteen minutes; an approval has to outlive that",
  );
  assert.match(
    migration,
    /RENAME TO "AuthActionApproval_sessionFamilyId_requestDigest_idx"/,
  );
});

test("a row cannot name a user from a different charity", () => {
  assert.match(
    migration,
    /FOREIGN KEY \("userId", "organisationId"\) REFERENCES "User"\("id", "organisationId"\)/,
  );
});

test("the migration carries nothing the blue-green gate blocks", () => {
  assert.doesNotMatch(migration, /SET NOT NULL/);
});

test("an approval records which record it is about", () => {
  assert.match(migration, /ALTER TABLE "AuthActionApproval"\s+ADD COLUMN "resourceId" TEXT;/);
  assert.match(schema, /model AuthActionApproval \{[\s\S]*?resourceId\s+String\?/);
});

test("the table is cleared between isolated runs", () => {
  assert.ok(DISPOSABLE_DATABASE_RESET_TABLES.includes("AuthActionApproval"));
});

test("the Prisma model matches the columns the migration creates", () => {
  const model = schema.match(/model AuthActionApproval \{[\s\S]*?\n\}/)?.[0];
  assert.ok(model, "the model must exist in the schema");

  for (const field of [
    "organisationId",
    "userId",
    "sessionFamilyId",
    "requestDigest",
    "summary",
    "method",
    "routePattern",
    "expiresAt",
    "approvedAt",
    "consumedAt",
  ]) {
    assert.ok(
      new RegExp(`\\n\\s+${field}\\s`).test(model),
      `${field} is in the migration but not in the model`,
    );
    assert.ok(migration.includes(`"${field}"`), `${field} is in the model but not the migration`);
  }

  assert.match(model, /approvedAt\s+DateTime\?/, "an unapproved approval is the normal state");
  assert.match(model, /consumedAt\s+DateTime\?/);
  assert.match(model, /expiresAt\s+DateTime\b(?!\?)/, "every approval expires");
});
