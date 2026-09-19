import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// On 2026-08-30 INVITE_LINK_REISSUED was added to the SecurityAuditEventType
// enum without widening SecurityAuditEvent_subject_check, the constraint that
// says which event types may be recorded and with what subject. Every reissue
// then failed at the database until 2026-09-19. This test pins the invariant
// that broke: whatever the *latest* definition of that constraint is, it must
// admit every value the enum can hold.

const prismaRoot = new URL('../../prisma/', import.meta.url);
const schema = readFileSync(new URL('schema.prisma', prismaRoot), 'utf8');

const securityAuditEventTypes = (): string[] => {
  const body = schema.match(/enum SecurityAuditEventType \{([\s\S]*?)\}/u)?.[1];
  assert.ok(body, 'enum SecurityAuditEventType not found in schema.prisma');
  return body
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/u, '').trim())
    .filter((line) => line.length > 0);
};

// Migrations apply in lexical order, so the last migration that (re)defines the
// constraint is the one the database actually enforces.
const latestCheckBody = (constraint: string): { migration: string; body: string } => {
  const marker = `CONSTRAINT "${constraint}" CHECK (`;
  const migrations = readdirSync(new URL('migrations/', prismaRoot), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let latest: { migration: string; body: string } | undefined;
  for (const migration of migrations) {
    const sql = readFileSync(new URL(`migrations/${migration}/migration.sql`, prismaRoot), 'utf8');
    const start = sql.indexOf(marker);
    if (start === -1) continue;

    // Walk to the parenthesis that closes the CHECK ( ... ) body.
    let depth = 0;
    let end = -1;
    for (let i = start + marker.length - 1; i < sql.length; i += 1) {
      if (sql[i] === '(') depth += 1;
      if (sql[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    assert.notEqual(end, -1, `${migration}: unbalanced CHECK body for ${constraint}`);
    latest = { migration, body: sql.slice(start, end + 1) };
  }
  assert.ok(latest, `no migration defines ${constraint}`);
  return latest;
};

test('every SecurityAuditEventType value is admitted by the live subject_check constraint', () => {
  const values = securityAuditEventTypes();
  assert.ok(values.length >= 13, `unexpectedly few enum values: ${values.length}`);

  const { migration, body } = latestCheckBody('SecurityAuditEvent_subject_check');
  const missing = values.filter((value) => !body.includes(`'${value}'::"SecurityAuditEventType"`));

  assert.deepEqual(
    missing,
    [],
    `SecurityAuditEventType value(s) ${missing.join(', ')} are not admitted by ` +
      `SecurityAuditEvent_subject_check as last defined in ${migration}. ` +
      'Any row of that type will fail at the database. Widen the constraint in a new migration.',
  );
});

test('the widening migration is idempotent so it can be applied by hand ahead of a deploy', () => {
  const sql = readFileSync(
    new URL(
      'migrations/20260919170000_widen_subject_check_for_invite_link_reissued/migration.sql',
      prismaRoot,
    ),
    'utf8',
  );
  const drop = sql.indexOf('DROP CONSTRAINT IF EXISTS "SecurityAuditEvent_subject_check"');
  const add = sql.indexOf('ADD CONSTRAINT "SecurityAuditEvent_subject_check" CHECK (');
  assert.notEqual(drop, -1, 'must DROP CONSTRAINT IF EXISTS before re-adding');
  assert.notEqual(add, -1, 'must re-ADD the constraint');
  assert.ok(drop < add, 'DROP must precede ADD');
  assert.match(sql, /'INVITE_LINK_REISSUED'::"SecurityAuditEventType"/u);
  // Reissue records an invitation, not a person: it must sit in the no-subject branch.
  assert.match(sql, /'INVITE_REVOKED'::"SecurityAuditEventType",\s*'INVITE_LINK_REISSUED'::"SecurityAuditEventType"/u);
});
