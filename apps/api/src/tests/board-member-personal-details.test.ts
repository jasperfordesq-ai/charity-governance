import assert from 'node:assert/strict';
import { test } from 'node:test';

// Set every env var the imported modules read at import/construction time, BEFORE imports.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'board-member-personal-details-test-secret';

const [
  { default: Fastify },
  { boardMemberRoutes },
  { signAccessToken },
] = await Promise.all([
  import('fastify'),
  import('../routes/board-members/index.js'),
  import('../utils/jwt.js'),
]);

function adminToken() {
  return `Bearer ${signAccessToken({ userId: 'u1', organisationId: 'org-1', role: 'ADMIN', sessionId: 'sess-1' })}`;
}

function activeSubscription() {
  return { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: new Date(Date.now() + 1_000_000_000) };
}

function authModels() {
  return {
    authSession: { findFirst: async () => ({ id: 'sess-1' }) },
    user: { findUnique: async () => ({ id: 'u1', organisationId: 'org-1', role: 'ADMIN', emailVerified: true }) },
    subscription: { findUnique: async () => activeSubscription() },
  };
}

// `dateOfBirth` is `DateTime @db.Date` in prisma/schema.prisma. For a DateTime column Prisma
// accepts a Date or a full ISO-8601 datetime string, but rejects a date-only string with
// PrismaClientValidationError — which the route turns into a 500. That asymmetry is the whole
// bug, so the fake enforces the same contract instead of accepting whatever it is handed.
const DATE_COLUMNS = [
  'appointedDate',
  'termEndDate',
  'conductSignedDate',
  'inductionDate',
  'dateOfBirth',
] as const;

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function assertPrismaDateColumns(operation: string, data: Record<string, unknown>) {
  for (const column of DATE_COLUMNS) {
    const value = data[column];
    if (value === undefined || value === null) continue;
    if (value instanceof Date) continue;
    if (typeof value === 'string' && ISO_DATETIME.test(value)) continue;
    throw new Error(
      `PrismaClientValidationError: Invalid \`prisma.boardMember.${operation}()\` invocation: `
      + `Argument \`${column}\`: Got invalid value '${String(value)}' on prisma.${operation}BoardMember. `
      + 'Provided String, expected DateTime.',
    );
  }
}

type Writes = {
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
};

const persistedMember = {
  id: 'bm-1',
  organisationId: 'org-1',
  name: 'Mary Boyle',
  role: 'Chair',
  appointedDate: new Date('2026-01-01T00:00:00.000Z'),
  termEndDate: null,
  conductSigned: false,
  conductSignedDate: null,
  inductionCompleted: false,
  inductionDate: null,
  dateOfBirth: null,
};

async function buildBoardApp() {
  const writes: Writes = {};
  const app = Fastify({ logger: false });

  const boardMember = {
    findMany: async () => [],
    count: async () => 0,
    create: async (args: { data: Record<string, unknown> }) => {
      assertPrismaDateColumns('create', args.data);
      writes.create = args.data;
      return { id: 'bm-1', ...args.data };
    },
    findFirst: async () => ({ ...persistedMember }),
    update: async (args: { data: Record<string, unknown> }) => {
      assertPrismaDateColumns('update', args.data);
      writes.update = args.data;
      return { ...persistedMember, ...args.data };
    },
    delete: async () => ({}),
  };

  const transaction = {
    boardMember,
    conflictRecord: { updateMany: async () => ({ count: 0 }) },
    $queryRaw: async () => [{ id: 'org-1' }],
  };

  app.decorate('prisma', {
    ...authModels(),
    ...transaction,
    $transaction: async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction),
  } as never);

  await app.register(boardMemberRoutes);
  return { app, writes };
}

// ── create path: validated personal-detail columns must actually be written ──

test('POST /board-members persists the validated personal-detail columns', async () => {
  const { app, writes } = await buildBoardApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { authorization: adminToken() },
      payload: {
        name: 'Mary Boyle',
        role: 'Chair',
        appointedDate: '2026-01-01',
        dateOfBirth: '1968-03-14',
        residentialAddress: '4 Anne Street, Dublin 2',
        otherDirectorships: 'Clondalkin Community Trust CLG',
        formerNames: 'Mary Nolan',
        appointmentKind: 'BOARD',
      },
    });

    assert.equal(res.statusCode, 201);

    const created = writes.create;
    assert.ok(created, 'the service must reach prisma.boardMember.create');

    // The schema accepts these five fields; dropping them hands the caller a 201 for data
    // that was never written.
    assert.ok(created.dateOfBirth instanceof Date, 'dateOfBirth must be written as a Date');
    assert.equal((created.dateOfBirth as Date).toISOString(), '1968-03-14T00:00:00.000Z');
    assert.equal(created.residentialAddress, '4 Anne Street, Dublin 2');
    assert.equal(created.otherDirectorships, 'Clondalkin Community Trust CLG');
    assert.equal(created.formerNames, 'Mary Nolan');
    assert.equal(created.appointmentKind, 'BOARD');
  } finally {
    await app.close();
  }
});

test('POST /board-members round-trips the persisted personal details to the caller', async () => {
  const { app } = await buildBoardApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { authorization: adminToken() },
      payload: {
        name: 'Mary Boyle',
        role: 'Chair',
        appointedDate: '2026-01-01',
        dateOfBirth: '1968-03-14',
      },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    const member = body.data ?? body;
    assert.ok(
      member.dateOfBirth,
      'a 201 must not claim to have saved a date of birth it dropped',
    );
    assert.equal(new Date(member.dateOfBirth as string).toISOString(), '1968-03-14T00:00:00.000Z');
  } finally {
    await app.close();
  }
});

test('POST /board-members omits personal-detail columns that were not supplied', async () => {
  const { app, writes } = await buildBoardApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { authorization: adminToken() },
      payload: { name: 'Mary Boyle', role: 'Chair', appointedDate: '2026-01-01' },
    });

    assert.equal(res.statusCode, 201);
    const created = writes.create;
    assert.ok(created, 'the service must reach prisma.boardMember.create');
    assert.equal(created.dateOfBirth, undefined);
    assert.equal(created.residentialAddress, undefined);
    assert.equal(created.otherDirectorships, undefined);
    assert.equal(created.formerNames, undefined);
    assert.equal(created.appointmentKind, undefined);
  } finally {
    await app.close();
  }
});

// ── update path: dateOfBirth must be converted like every other date column ──

test('PATCH /board-members/:id accepts a date-only dateOfBirth and writes it as a Date', async () => {
  const { app, writes } = await buildBoardApp();
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: '/bm-1',
      headers: { authorization: adminToken() },
      payload: { dateOfBirth: '1968-03-14' },
    });

    // The raw string reaches a DateTime column, Prisma rejects it, the route returns 500.
    assert.equal(res.statusCode, 200, 'a date-only dateOfBirth must not fail the update');

    const updated = writes.update;
    assert.ok(updated, 'the service must reach prisma.boardMember.update');
    assert.ok(updated.dateOfBirth instanceof Date, 'dateOfBirth must be converted to a Date');
    assert.equal((updated.dateOfBirth as Date).toISOString(), '1968-03-14T00:00:00.000Z');
  } finally {
    await app.close();
  }
});

test('PATCH /board-members/:id still accepts a full ISO datetime dateOfBirth', async () => {
  const { app, writes } = await buildBoardApp();
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: '/bm-1',
      headers: { authorization: adminToken() },
      payload: { dateOfBirth: '1968-03-14T00:00:00.000Z' },
    });

    assert.equal(res.statusCode, 200);
    const updated = writes.update;
    assert.ok(updated, 'the service must reach prisma.boardMember.update');
    assert.ok(updated.dateOfBirth instanceof Date, 'dateOfBirth must be converted to a Date');
    assert.equal((updated.dateOfBirth as Date).toISOString(), '1968-03-14T00:00:00.000Z');
  } finally {
    await app.close();
  }
});

test('PATCH /board-members/:id clears dateOfBirth when it is explicitly null', async () => {
  const { app, writes } = await buildBoardApp();
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: '/bm-1',
      headers: { authorization: adminToken() },
      payload: { dateOfBirth: null },
    });

    assert.equal(res.statusCode, 200);
    const updated = writes.update;
    assert.ok(updated, 'the service must reach prisma.boardMember.update');
    assert.equal(updated.dateOfBirth, null, 'an explicit null must clear the column, like termEndDate');
  } finally {
    await app.close();
  }
});

test('PATCH /board-members/:id leaves dateOfBirth untouched when it is absent', async () => {
  const { app, writes } = await buildBoardApp();
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: '/bm-1',
      headers: { authorization: adminToken() },
      payload: { name: 'Mary Boyle-Nolan' },
    });

    assert.equal(res.statusCode, 200);
    const updated = writes.update;
    assert.ok(updated, 'the service must reach prisma.boardMember.update');
    assert.equal(
      Object.prototype.hasOwnProperty.call(updated, 'dateOfBirth') && updated.dateOfBirth !== undefined,
      false,
      'an absent dateOfBirth must not be written',
    );
  } finally {
    await app.close();
  }
});
