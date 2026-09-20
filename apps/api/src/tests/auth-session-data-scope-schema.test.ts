import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The shape of the session's data scope.
 *
 * The scope decides whether a trustee's date of birth and home address may
 * reach a model. It used to be a flag in an AI client's configuration file;
 * these are the rules that make it a property of the session instead, and
 * they live in the database rather than in the code that reads it.
 */
const migration = readFileSync(
  new URL(
    "../../prisma/migrations/20260920090000_add_auth_session_data_scope/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

const schema = readFileSync(
  new URL("../../prisma/schema.prisma", import.meta.url),
  "utf8",
);

test("every existing session keeps seeing what it saw", () => {
  assert.match(
    migration,
    /ADD COLUMN "dataScope" "AuthSessionDataScope" NOT NULL DEFAULT 'FULL'/,
    "a default of WITHHELD would narrow every web session in place",
  );
});

test("a web session may not be narrowed by accident", () => {
  assert.match(
    migration,
    /CHECK \(\s*"clientKind" <> 'WEB'[\s\S]*?OR "dataScope" = 'FULL'/,
  );
});

test("the scope cannot be changed on a live session", () => {
  // Between the two guards: raising it on a row already in somebody's hands
  // would release personal data to a credential nobody re-authorised.
  assert.match(
    migration,
    /NEW\."dataScope" IS DISTINCT FROM OLD\."dataScope"/,
    "the update guard must refuse a change to the scope",
  );
});

test("a rotation that forgets the scope fails rather than widening the session", () => {
  // Rotation mints a new row every refresh. A successor without the scope
  // takes the column default, which is FULL — the widest failure there is,
  // and a silent one. The family guard is what turns it into a raised error.
  assert.match(migration, /existing_family_data_scope "AuthSessionDataScope"/);
  assert.match(
    migration,
    /existing_family_data_scope IS DISTINCT FROM NEW\."dataScope"/,
  );
});

test("the migration carries nothing the blue-green gate blocks", async () => {
  // Asked of the gate itself rather than re-implemented here with regular
  // expressions. A hand-written copy of its rules would have to be kept in
  // step with it, and the first version of this test failed on the migration's
  // own prose explaining which rules it was avoiding.
  const gate = (await import(
    // @ts-expect-error -- the deploy gate is plain JavaScript and ships no
    // declarations. Asking the real thing is worth more than a typed copy of
    // its rules that would drift away from it.
    "../../../../scripts/bluegreen/migration-gate.mjs"
  )) as {
    lintMigrationSql: (
      name: string,
      sql: string,
    ) => { blocked: unknown[]; warned: unknown[] };
  };

  const findings = gate.lintMigrationSql(
    "20260920090000_add_auth_session_data_scope",
    migration,
  );

  assert.deepEqual(
    findings.blocked,
    [],
    "a blocked migration cannot be deployed without an override",
  );
});

test("the Prisma model matches the column the migration creates", () => {
  const model = schema.match(/model AuthSession \{[\s\S]*?\n\}/)?.[0];
  assert.ok(model, "the model must exist in the schema");
  assert.match(model, /dataScope\s+AuthSessionDataScope\s+@default\(FULL\)/);
  assert.match(schema, /enum AuthSessionDataScope \{\s*\n\s*WITHHELD\s*\n\s*FULL\s*\n\}/);
});
