import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * Pins the hand-written shared union against the Prisma enum, in BOTH
 * directions.
 *
 * The union in `packages/shared` is not inferred from the schema — it is typed
 * out by hand, which is the same drift hazard `types/api.ts` has generally, and
 * it had drifted both ways at once. Three values the database could produce were
 * missing from the union, so a client narrowing on the type would silently fail
 * to handle events it was actually being sent; and one value in the union had no
 * counterpart in the database at all, so a `switch` could carry a branch that
 * could never run and would look like coverage to a reviewer.
 *
 * Both directions are asserted separately and with different messages, because
 * they are different mistakes with different fixes: a missing value means the
 * union needs extending, a phantom means either the union is wrong or a
 * migration was never written.
 *
 * Read from source rather than imported. The Prisma client's generated enum is
 * derived from the same schema file, so comparing against it would be comparing
 * the schema with itself; and `packages/shared`'s build output can be stale,
 * which would make this test pass against a type nobody is shipping.
 */

const REPO_ROOT = join(process.cwd(), '..', '..');

function prismaAuditEventValues(): string[] {
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
  const block = /enum SecurityAuditEventType \{([\s\S]*?)\n\}/.exec(schema);
  assert.ok(block, 'the SecurityAuditEventType enum must exist in the Prisma schema');
  return block[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line));
}

function sharedUnionValues(): string[] {
  const source = readFileSync(
    join(REPO_ROOT, 'packages', 'shared', 'src', 'types', 'api.ts'),
    'utf8',
  );
  const block = /export type SecurityAuditEventType =([\s\S]*?);/.exec(source);
  assert.ok(block, 'the SecurityAuditEventType union must exist in packages/shared');
  return [...block[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]);
}

test('the Prisma audit event enum was parsed, not silently matched as empty', () => {
  // Without this, a regex that stopped matching would make every assertion
  // below compare two empty sets and pass — the canary for this whole file.
  const values = prismaAuditEventValues();
  assert.ok(values.length >= 15, `expected the full enum, parsed ${values.length} values`);
  assert.ok(values.includes('MEMBER_SUSPENDED'));
  assert.ok(sharedUnionValues().length >= 15);
});

test('every Prisma audit event type is in the shared union', () => {
  const missing = prismaAuditEventValues().filter((value) => !sharedUnionValues().includes(value));
  assert.deepEqual(
    missing,
    [],
    'the database can produce these event types and the shared union cannot express them, so a ' +
      'client narrowing on the type will silently fail to handle them',
  );
});

test('the shared union invents no audit event type the database cannot produce', () => {
  const phantom = sharedUnionValues().filter((value) => !prismaAuditEventValues().includes(value));
  assert.deepEqual(
    phantom,
    [],
    'these values are in the shared union but not in the Prisma enum, so a switch on them ' +
      'carries a branch that can never run and reads as coverage',
  );
});

test('the integration lifecycle events a DPO needs are all present', () => {
  const values = prismaAuditEventValues();
  // Named individually rather than counted: a count would stay green if one
  // were renamed, and these are the questions the audit log exists to answer.
  for (const required of [
    'INTEGRATION_CONNECTED',
    'INTEGRATION_SITE_SELECTED',
    'INTEGRATION_DISCONNECTED',
    'INTEGRATION_PUBLISH_TARGET_CHANGED',
    'INTEGRATION_ENVIRONMENT_DECLARED',
    'INTEGRATION_REAUTHORISATION_REQUIRED',
    'DOCUMENT_PUBLICATION_DEAD_LETTERED',
    'CONFLUENCE_ERASURE_REQUESTED',
  ]) {
    assert.ok(values.includes(required), `${required} is missing from SecurityAuditEventType`);
  }
});

test('enum values are added in their own migration, never alongside a use of them', () => {
  const migration = readFileSync(
    join(
      process.cwd(),
      'prisma',
      'migrations',
      '20260921020000_add_integration_audit_events',
      'migration.sql',
    ),
    'utf8',
  );

  // PostgreSQL refuses to USE a newly added enum value in the transaction that
  // added it, and Prisma wraps each migration in one. A migration that added a
  // value and then wrote a row with it would fail on a fresh database and pass
  // on one where an earlier deploy had already added the value — working on the
  // machine of whoever wrote it, which is the worst failure shape there is.
  const statements = migration
    .split('\n')
    .map((line) => line.trim().replace(/--.*$/, '').trim())
    .filter((line) => line.length > 0);

  assert.ok(statements.length > 0, 'the migration must contain statements');
  for (const statement of statements) {
    assert.match(
      statement,
      /^ALTER TYPE "SecurityAuditEventType" ADD VALUE '[A-Z][A-Z0-9_]*';$/,
      `this migration must contain only ALTER TYPE ADD VALUE, found: ${statement}`,
    );
  }
});
