import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'search-route-test-secret';

const [{ default: Fastify }, { searchRoutes }, { SEARCHABLE, SEARCH_TYPES }, { signAccessToken }] =
  await Promise.all([
    import('fastify'),
    import('../routes/search/index.js'),
    import('../services/search.service.js'),
    import('../utils/jwt.js'),
  ]);

type Scope = 'WITHHELD' | 'FULL';

const authorization = `Bearer ${signAccessToken({
  userId: 'u1',
  organisationId: 'org-1',
  role: 'ADMIN',
  sessionId: 'sess-1',
})}`;

const TRUSTEE = {
  id: 'bm-1',
  organisationId: 'org-1',
  name: 'Bridget Ahern',
  role: 'Chair',
  email: 'chair@example.ie',
  residentialAddress: '4 Kelly Street, Galway',
  formerNames: null,
  otherDirectorships: null,
  appointedDate: new Date('2024-01-01'),
};

const CONFLICT = {
  id: 'cr-1',
  organisationId: 'org-1',
  minuteReference: 'BM-2026-02-11 item 4',
  trusteeName: 'Bridget Ahern',
  matter: 'Her firm tendered for the roof works',
  nature: 'Financial',
  actionTaken: 'Withdrew from the vote',
  decision: null,
  dateDeclared: new Date('2026-02-11'),
};

const ACT = {
  id: 'act-1',
  organisationId: 'org-1',
  reference: 'BM-2026-02-11',
  title: 'Board meeting February 2026',
  statutoryBasis: null,
  notes: 'Bridget Ahern left the room for item 4.',
  actDate: new Date('2026-02-11'),
};

/**
 * A standing-in database that filters the way Postgres would: each delegate
 * applies the `where` it is given, so a query that searches the wrong columns
 * returns the wrong rows here too.
 */
function prismaWith(rows: Partial<Record<string, Record<string, unknown>[]>>) {
  const calls: { delegate: string; where: Record<string, unknown> }[] = [];

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    for (const [key, condition] of Object.entries(where)) {
      if (key === 'OR') {
        const any = (condition as Record<string, unknown>[]).some((clause) => matches(row, clause));
        if (!any) return false;
        continue;
      }
      if (condition !== null && typeof condition === 'object' && 'contains' in condition) {
        const value = row[key];
        const needle = String((condition as { contains: unknown }).contains).toLowerCase();
        if (typeof value !== 'string' || !value.toLowerCase().includes(needle)) return false;
        continue;
      }
      if (row[key] !== condition) return false;
    }
    return true;
  };

  const delegate = (name: string) => ({
    findMany: async ({ where, take }: { where: Record<string, unknown>; take: number }) => {
      calls.push({ delegate: name, where });
      return (rows[name] ?? []).filter((row) => matches(row, where)).slice(0, take);
    },
  });

  const prisma: Record<string, unknown> = { __calls: calls };
  for (const type of SEARCH_TYPES) prisma[SEARCHABLE[type].delegate] = delegate(SEARCHABLE[type].delegate);
  prisma.organisation = { findUnique: async () => ({ complexity: 'SIMPLE' }) };
  prisma.subscription = {
    findUnique: async () => ({ plan: 'ESSENTIALS', status: 'ACTIVE', trialEndsAt: null }),
  };
  return { prisma, calls };
}

async function buildApp(rows: Parameters<typeof prismaWith>[0], dataScope: Scope = 'WITHHELD') {
  const { prisma, calls } = prismaWith(rows);
  const app = Fastify({ logger: false });

  app.decorate('prisma', {
    ...prisma,
    authSession: { findFirst: async () => ({ id: 'sess-1' }) },
    user: {
      findUnique: async () => ({
        id: 'u1',
        organisationId: 'org-1',
        role: 'ADMIN' as const,
        emailVerified: true,
      }),
    },
  } as never);

  // The guard the real auth middleware would have set from the session row.
  app.addHook('preHandler', async (request) => {
    request.authSession = {
      id: 'sess-1',
      familyId: 'fam-1',
      clientKind: 'MCP_CONNECTOR',
      accessLevel: 'READ',
      dataScope,
    };
  });

  await app.register(searchRoutes, { prefix: '/api/v1/search' });
  return { app, calls };
}

function get(app: Awaited<ReturnType<typeof buildApp>>['app'], query: string) {
  return app.inject({ method: 'GET', url: `/api/v1/search${query}`, headers: { authorization } });
}

test('a search finds a trustee by name and hands back a reference to read', async () => {
  const { app } = await buildApp({ boardMember: [TRUSTEE] });
  try {
    const response = await get(app, '?q=Ahern&types=BoardMember');

    assert.equal(response.statusCode, 200);
    const body = response.json().data;
    assert.equal(body.data.length, 1);
    assert.deepEqual(
      { type: body.data[0].type, field: body.data[0].field, ref: body.data[0].ref },
      { type: 'BoardMember', field: 'name', ref: 'charitypilot://board-member/bm-1' },
    );
    assert.equal(body.data[0].title, 'Bridget Ahern');
  } finally {
    await app.close();
  }
});

// The property the whole design turns on: a hit is itself an answer, so a
// withheld field must not be matched, not merely not returned.
test('a closed gate does not match a trustee’s home address', async () => {
  const { app, calls } = await buildApp({ boardMember: [TRUSTEE] });
  try {
    const response = await get(app, '?q=Kelly Street&types=BoardMember');

    assert.deepEqual(response.json().data.data, []);
    const clauses = calls[0]!.where.OR as Record<string, unknown>[];
    const columns = clauses.map((clause) => Object.keys(clause)[0]);
    assert.deepEqual(columns, ['name', 'role'], 'only the safe columns may be queried at all');
  } finally {
    await app.close();
  }
});

test('an open gate matches the same address and says which field it was', async () => {
  const { app } = await buildApp({ boardMember: [TRUSTEE] }, 'FULL');
  try {
    const hit = (await get(app, '?q=Kelly Street&types=BoardMember')).json().data.data[0];

    assert.equal(hit.field, 'residentialAddress');
    assert.match(hit.snippet, /Kelly Street/);
  } finally {
    await app.close();
  }
});

test('a closed gate cannot find a trustee through a conflict record or a minute', async () => {
  const { app } = await buildApp({ conflictRecord: [CONFLICT], governingAct: [ACT] });
  try {
    const body = (await get(app, '?q=Bridget')).json().data;

    assert.deepEqual(body.data, [], 'a name must not be findable by any route while withheld');
    assert.match(String(body.note), /withholds personal data/);
  } finally {
    await app.close();
  }
});

test('an open gate finds the same trustee in both, and names each record usefully', async () => {
  const { app } = await buildApp({ conflictRecord: [CONFLICT], governingAct: [ACT] }, 'FULL');
  try {
    const hits = (await get(app, '?q=Bridget')).json().data.data;
    const byType = Object.fromEntries(hits.map((hit: { type: string }) => [hit.type, hit]));

    assert.equal(byType.ConflictRecord.title, 'Bridget Ahern');
    assert.equal(byType.ConflictRecord.field, 'trusteeName');
    assert.equal(byType.GoverningAct.field, 'notes');
    assert.equal(byType.GoverningAct.title, 'Board meeting February 2026');
  } finally {
    await app.close();
  }
});

test('a search never leaves the caller’s charity', async () => {
  const { app, calls } = await buildApp({
    boardMember: [TRUSTEE, { ...TRUSTEE, id: 'bm-2', organisationId: 'org-2' }],
  });
  try {
    const hits = (await get(app, '?q=Ahern&types=BoardMember')).json().data.data;

    assert.deepEqual(hits.map((hit: { id: string }) => hit.id), ['bm-1']);
    assert.equal(calls[0]!.where.organisationId, 'org-1');
  } finally {
    await app.close();
  }
});

test('the Governance Code is searched without a charity, because it belongs to nobody', async () => {
  const { app, calls } = await buildApp({
    governanceStandard: [
      { id: 'std-1', code: '1.1', title: 'Identify the purpose', isCore: true, sortOrder: 1 },
    ],
  });
  try {
    const hits = (await get(app, '?q=purpose&types=GovernanceStandard')).json().data.data;

    assert.equal(hits[0].ref, 'charitypilot://standard/std-1');
    assert.equal(calls[0]!.where.organisationId, undefined);
    assert.equal(calls[0]!.where.isCore, true, 'an ESSENTIALS plan sees the core standards only');
  } finally {
    await app.close();
  }
});

test('a query that is only wildcards is refused rather than matching everything', async () => {
  const { app } = await buildApp({ boardMember: [TRUSTEE] });
  try {
    for (const q of ['%', '%%%', '_', 'a', '  ']) {
      const response = await get(app, `?q=${encodeURIComponent(q)}`);
      assert.equal(response.statusCode, 400, `"${q}" must be refused`);
    }
  } finally {
    await app.close();
  }
});

test('an unknown kind is refused rather than quietly ignored', async () => {
  const { app } = await buildApp({ boardMember: [TRUSTEE] });
  try {
    const response = await get(app, '?q=Ahern&types=Payroll');

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'VALIDATION_ERROR');
  } finally {
    await app.close();
  }
});

test('a kind that hit its limit says so, so a caller knows to narrow the search', async () => {
  const many = Array.from({ length: 6 }, (_, index) => ({
    ...TRUSTEE,
    id: `bm-${index}`,
    name: `Ahern Number ${index}`,
  }));
  const { app } = await buildApp({ boardMember: many });
  try {
    const body = (await get(app, '?q=Ahern&types=BoardMember&limit=3')).json().data;

    assert.equal(body.data.length, 3);
    assert.deepEqual(body.truncated, ['BoardMember']);
  } finally {
    await app.close();
  }
});

test('the response says which kinds were looked in, and the scope it looked under', async () => {
  const { app } = await buildApp({});
  try {
    const body = (await get(app, '?q=anything')).json().data;

    assert.equal(body.dataScope, 'WITHHELD');
    assert.deepEqual(body.searched, SEARCH_TYPES, 'every kind has at least one safe column');
    assert.deepEqual(body.truncated, []);
  } finally {
    await app.close();
  }
});

test('a caller cannot widen its own scope through the query string', async () => {
  const { app, calls } = await buildApp({ boardMember: [TRUSTEE] });
  try {
    const body = (
      await get(app, '?q=Kelly Street&types=BoardMember&dataScope=FULL')
    ).json().data;

    assert.equal(body.dataScope, 'WITHHELD');
    assert.deepEqual(body.data, []);
    const columns = (calls[0]!.where.OR as Record<string, unknown>[]).map(
      (clause) => Object.keys(clause)[0],
    );
    assert.ok(!columns.includes('residentialAddress'));
  } finally {
    await app.close();
  }
});

// Every column this service is willing to quote back must be one the
// connector's own field policy calls safe for the same model. Asserted here
// rather than trusted, because the two lists are maintained apart.
test('no column the closed gate searches is one the field policy withholds', async () => {
  // Imported through a computed specifier from the connector's build rather
  // than by a static path: the two packages compile separately, and a static
  // import would put the connector's sources inside this one's root.
  const built = new URL('../../../../mcp/dist/field-policy.js', import.meta.url).href;
  let WITHHELD_FIELDS: Record<string, readonly string[]>;
  try {
    ({ WITHHELD_FIELDS } = (await import(built)) as {
      WITHHELD_FIELDS: Record<string, readonly string[]>;
    });
  } catch {
    // Loud rather than skipped. This is the one assertion that the API and
    // the connector agree about what personal data is, and a version of it
    // that quietly passes when the connector is not built is worse than none.
    assert.fail(
      'The connector is not built, so this could not be checked. Run `npm run build` in mcp/.',
    );
  }

  for (const type of SEARCH_TYPES) {
    const withheld = new Set(WITHHELD_FIELDS[type] ?? []);
    for (const field of SEARCHABLE[type].safeFields) {
      assert.ok(
        !withheld.has(field),
        `${type}.${field} is searched while the gate is closed but is withheld from a read`,
      );
    }
  }
});
