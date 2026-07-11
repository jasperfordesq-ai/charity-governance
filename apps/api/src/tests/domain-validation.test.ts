import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDomainInvariantWrite } from '../utils/domain-validation.js';
import { AppError } from '../utils/errors.js';

const CONSTRAINTS = [
  'BoardMember_term_chronology_check',
  'BoardMember_conduct_signed_date_equivalence_check',
  'BoardMember_induction_date_equivalence_check',
  'FundraisingRecord_date_chronology_check',
  'AnnualReportReadiness_filed_date_required_check',
] as const;

for (const constraint of CONSTRAINTS) {
  test(`maps the known ${constraint} constraint to a safe validation response`, async () => {
    await assert.rejects(
      () => runDomainInvariantWrite(async () => {
        throw {
          code: 'P2004',
          meta: {
            database_error: `new row violates check constraint "${constraint}"`,
          },
        };
      }),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true);
        const appError = error as AppError;
        assert.equal(appError.statusCode, 400);
        assert.equal(appError.code, 'VALIDATION_ERROR');
        assert.equal(appError.message, 'Validation failed');
        assert.equal(JSON.stringify(appError.details).includes(constraint), false);
        return true;
      },
    );
  });
}

test('maps direct PostgreSQL driver check metadata for a known constraint', async () => {
  await assert.rejects(
    () => runDomainInvariantWrite(async () => {
      throw {
        code: '23514',
        constraint: 'BoardMember_term_chronology_check',
      };
    }),
    (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR',
  );
});

test('maps a known constraint from non-enumerable driver-adapter cause metadata', async () => {
  const driverAdapterError = new Error('Adapter failed');
  Object.defineProperty(driverAdapterError, 'cause', {
    enumerable: false,
    value: {
      originalCode: '23514',
      originalMessage: 'violates check constraint "FundraisingRecord_date_chronology_check"',
    },
  });

  await assert.rejects(
    () => runDomainInvariantWrite(async () => {
      throw {
        code: 'P2004',
        meta: { driverAdapterError },
      };
    }),
    (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR',
  );
});

test('maps only allowlisted constraints from the actual Prisma unknown-request connector wrapper', async () => {
  const known = Object.assign(
    new Error(
      'ConnectorError(QueryError(PostgresError { code: "23514", message: "violates check constraint \\"BoardMember_term_chronology_check\\"" }))',
    ),
    { name: 'PrismaClientUnknownRequestError' },
  );
  await assert.rejects(
    () => runDomainInvariantWrite(async () => { throw known; }),
    (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR',
  );

  const unknown = Object.assign(
    new Error(
      'ConnectorError(QueryError(PostgresError { code: "23514", message: "violates check constraint \\"BoardMember_term_chronology_check_unrelated\\"" }))',
    ),
    { name: 'PrismaClientUnknownRequestError' },
  );
  await assert.rejects(
    () => runDomainInvariantWrite(async () => { throw unknown; }),
    (error: unknown) => error === unknown,
  );
});

test('rethrows unknown constraints and unrelated database errors unchanged', async () => {
  const errors = [
    {
      code: 'P2004',
      meta: { database_error: 'new row violates check constraint "Unknown_constraint"' },
    },
    {
      code: 'P2003',
      meta: { database_error: 'BoardMember_term_chronology_check' },
    },
    {
      code: 'P2004',
      message: 'BoardMember_term_chronology_check',
      meta: {},
    },
    {
      code: 'P2004',
      meta: {
        database_error: 'new row violates check constraint "BoardMember_term_chronology_check_unrelated"',
      },
    },
  ];

  for (const original of errors) {
    await assert.rejects(
      () => runDomainInvariantWrite(async () => { throw original; }),
      (error: unknown) => error === original,
    );
  }
});
