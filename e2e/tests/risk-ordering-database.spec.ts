import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withDb, createVerifiedOwner } from '../helpers/db';
import { TEST_PASSWORD, uniqueEmail } from '../fixtures';
import { IS_DEPLOYED_QA } from '../env';

test.describe('Transactional risk evidence ordering', () => {
  test.skip(IS_DEPLOYED_QA, 'Requires the identity-bound disposable database.');

  test('populated upgrade and rollback preserve history and allocation high-water', async () => {
    const owner = await createVerifiedOwner({ email: uniqueEmail('ordering'), password: TEST_PASSWORD,
      name: 'Ordering Owner', organisationName: 'Ordering Charity' });
    const riskId = randomUUID();
    const upgrade = readFileSync(resolve(__dirname, '../../apps/api/prisma/migrations/20260930110000_transactional_risk_verification_order/migration.sql'), 'utf8');
    const rollback = readFileSync(resolve(__dirname, '../fixtures/risk-verification-order-rollback.sql'), 'utf8');
    await withDb(async client => {
      await client.query(`INSERT INTO "RiskRecord" ("id", "organisationId", "title", "category", "description", "likelihood", "impact", "mitigation", "updatedAt")
        VALUES ($1, $2, 'Ordering proof', 'GOVERNANCE', 'Disposable ordering proof', 1, 1, 'Test fixture', NOW())`, [riskId, owner.organisationId]);
      const insert = async () => {
        const result = await client.query(`INSERT INTO "RiskControlVerification" ("id", "organisationId", "riskId", "actorUserId", "controlReference", "state", "riskRevision", "reason")
          VALUES ($1, $2, $3, $4, 'TEST', 'WITHDRAWN', 1, 'Disposable ordering proof') RETURNING "sequence"`,
        [randomUUID(), owner.organisationId, riskId, owner.userId]);
        return result.rows[0].sequence as number;
      };
      const history = async () => (await client.query('SELECT to_jsonb(v) AS record FROM "RiskControlVerification" v WHERE "riskId"=$1 ORDER BY "sequence"', [riskId])).rows;
      let legacy = false;
      try {
        const first = await insert();
        await client.query(rollback);
        legacy = true;
        const second = await insert();
        expect(second).toBeGreaterThan(first);
        const original = await history();
        const reserved = second + 100;
        await client.query(`SELECT setval('"RiskControlVerification_sequence_seq"', $1, true)`, [reserved]);
        await client.query(upgrade);
        legacy = false;
        expect(await history()).toEqual(original);
        expect(await insert()).toBe(reserved + 1);
        const upgraded = await history();
        await client.query(rollback);
        legacy = true;
        expect(await history()).toEqual(upgraded);
        expect(await insert()).toBe(reserved + 2);
        await client.query(upgrade);
        legacy = false;
        expect(await insert()).toBe(reserved + 3);
        await expect(client.query('UPDATE "RiskControlVerification" SET "reason"=$1 WHERE "riskId"=$2', ['Should remain immutable', riskId])).rejects.toThrow();
      } finally {
        if (legacy) {
          await client.query('ROLLBACK');
          await client.query(upgrade);
        }
      }
    });
  });

  test('allocation rolls back, serializes concurrent callers, and is snapshot-visible', async () => {
    const before = await withDb(async client => {
      const row = await client.query('SELECT "value" FROM "RiskControlVerificationCounter" WHERE "id" = 1');
      await client.query('BEGIN');
      try {
        const allocated = await client.query('SELECT "RiskControlVerification_next_order"() AS value');
        expect(allocated.rows[0].value).toBe(row.rows[0].value + 1);
      } finally { await client.query('ROLLBACK'); }
      return row.rows[0].value as number;
    });
    const snapshot = await withDb(async reader => {
      await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const initial = await reader.query('SELECT "value" FROM "RiskControlVerificationCounter" WHERE "id" = 1');
        expect(initial.rows[0].value).toBe(before);
        const values = await Promise.all(Array.from({ length: 8 }, () => withDb(async writer => {
          const result = await writer.query('SELECT "RiskControlVerification_next_order"() AS value');
          return result.rows[0].value as number;
        })));
        expect(values.sort((a, b) => a - b)).toEqual(Array.from({ length: 8 }, (_, i) => before + i + 1));
        const unchanged = await reader.query('SELECT "value" FROM "RiskControlVerificationCounter" WHERE "id" = 1');
        expect(unchanged.rows[0].value).toBe(before);
        return values;
      } finally { await reader.query('ROLLBACK'); }
    });
    expect(snapshot).toHaveLength(8);
    await withDb(async client => {
      const current = await client.query('SELECT "value" FROM "RiskControlVerificationCounter" WHERE "id" = 1');
      expect(current.rows[0].value).toBe(before + 8);
      const sequences = await client.query("SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'");
      expect(sequences.rows[0].count).toBe(0);
    });
  });
});
