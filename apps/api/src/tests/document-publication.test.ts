import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { DISPOSABLE_DATABASE_RESET_TABLES } = require(
  '../../../../e2e/helpers/database-safety.cjs',
) as { DISPOSABLE_DATABASE_RESET_TABLES: readonly string[] };

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');

const migrationsDirectory = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
const migrationDirectoryName = readdirSync(migrationsDirectory)
  .filter((entry) => entry.endsWith('_add_document_publication'))
  .sort()
  .at(-1);
assert.ok(
  migrationDirectoryName,
  'a hand-written <timestamp>_add_document_publication migration must exist',
);
const migration = readFileSync(
  new URL(`../../prisma/migrations/${migrationDirectoryName}/migration.sql`, import.meta.url),
  'utf8',
);

// The follow-up migration that makes the publish worker's create-then-attach
// window expressible: `cloudId` and `pageId` recorded while `publishedAt` is
// still null. Loaded separately, and applied after the table exists, because
// the two files say different things and a proof that ran only the first would
// be proving a shape production no longer has.
const targetWindowDirectoryName = readdirSync(migrationsDirectory)
  .filter((entry) => entry.endsWith('_publication_target_window'))
  .sort()
  .at(-1);
assert.ok(
  targetWindowDirectoryName,
  'a hand-written <timestamp>_publication_target_window migration must exist',
);
const targetWindowMigration = readFileSync(
  new URL(`../../prisma/migrations/${targetWindowDirectoryName}/migration.sql`, import.meta.url),
  'utf8',
);

// PostgreSQL silently truncates an identifier at 63 bytes, and Prisma truncates
// its derived names to the same limit. A longer name only *appears* to match the
// migration text and shows up later as permanent drift.
const POSTGRES_IDENTIFIER_LIMIT = 63;

// Digest-pinned to the same image the repository already approves for real
// migration proofs (scripts/postgres-backup.mjs).
const POSTGRES_IMAGE = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';

function modelBlock(source: string, model: string): string {
  const match = source.match(new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm'));
  assert.ok(match, `schema.prisma must declare model ${model}`);
  return match[1];
}

const publicationModel = modelBlock(schema, 'DocumentPublication');

// The reliability engine this row copies. Listed once and asserted field by
// field, so a field dropped from the copy fails on its own line.
const RELIABILITY_FIELDS: ReadonlyArray<[field: string, declaration: RegExp]> = [
  ['state', /^\s*state\s+DocumentPublicationState\s+@default\(PENDING\)\s*$/m],
  ['attempts', /^\s*attempts\s+Int\s+@default\(0\)\s*$/m],
  ['lastError', /^\s*lastError\s+String\?\s*$/m],
  ['lastAttemptAt', /^\s*lastAttemptAt\s+DateTime\?\s*$/m],
  ['nextAttemptAt', /^\s*nextAttemptAt\s+DateTime\?\s+@default\(now\(\)\)\s*$/m],
  ['claimedAt', /^\s*claimedAt\s+DateTime\?\s*$/m],
  ['deadLetteredAt', /^\s*deadLetteredAt\s+DateTime\?\s*$/m],
  ['terminalReason', /^\s*terminalReason\s+DocumentPublicationTerminalReason\?\s*$/m],
  ['alertClaimToken', /^\s*alertClaimToken\s+String\?\s*$/m],
  ['alertClaimedAt', /^\s*alertClaimedAt\s+DateTime\?\s*$/m],
  ['alertedAt', /^\s*alertedAt\s+DateTime\?\s*$/m],
  ['processedAt', /^\s*processedAt\s+DateTime\?\s*$/m],
];

// Where the bytes went. cloudId lives on the row rather than being resolved
// later: a charity may reconnect to a DIFFERENT site and still be owed erasure
// from the first, so the row has to remember.
const PUBLICATION_FIELDS: ReadonlyArray<[field: string, declaration: RegExp]> = [
  ['cloudId', /^\s*cloudId\s+String\?\s*$/m],
  ['spaceId', /^\s*spaceId\s+String\?\s*$/m],
  ['pageId', /^\s*pageId\s+String\?\s*$/m],
  ['attachmentId', /^\s*attachmentId\s+String\?\s*$/m],
  ['pageTitle', /^\s*pageTitle\s+String\?\s*$/m],
  ['publishedAt', /^\s*publishedAt\s+DateTime\?\s*$/m],
];

const EXPECTED_INDEXES: ReadonlyArray<{
  name: string;
  unique: boolean;
  columns: readonly string[];
  attribute: string;
}> = [
  {
    name: 'DocumentPublication_documentId_provider_key',
    unique: true,
    columns: ['documentId', 'provider'],
    attribute: '@@unique([documentId, provider])',
  },
  {
    name: 'DocumentPublication_organisationId_idx',
    unique: false,
    columns: ['organisationId'],
    attribute: '@@index([organisationId])',
  },
  {
    name: 'DocumentPublication_state_nextAttemptAt_claimedAt_createdAt_idx',
    unique: false,
    columns: ['state', 'nextAttemptAt', 'claimedAt', 'createdAt'],
    attribute: '@@index([state, nextAttemptAt, claimedAt, createdAt])',
  },
  {
    // Prisma would derive a 69-byte name here and truncate it. Naming it
    // explicitly keeps the schema and the migration textually identical.
    name: 'DocumentPublication_state_alert_deadLetteredAt_idx',
    unique: false,
    columns: ['state', 'alertedAt', 'alertClaimedAt', 'deadLetteredAt'],
    attribute:
      '@@index([state, alertedAt, alertClaimedAt, deadLetteredAt], map: "DocumentPublication_state_alert_deadLetteredAt_idx")',
  },
  {
    name: 'DocumentPublication_organisationId_state_deadLetteredAt_idx',
    unique: false,
    columns: ['organisationId', 'state', 'deadLetteredAt'],
    attribute: '@@index([organisationId, state, deadLetteredAt])',
  },
  {
    name: 'DocumentPublication_provider_state_nextAttemptAt_idx',
    unique: false,
    columns: ['provider', 'state', 'nextAttemptAt'],
    attribute: '@@index([provider, state, nextAttemptAt])',
  },
];

test('the publication state and terminal-reason enums are pinned exhaustively, retired state included', () => {
  // Exact-shape, not membership: an accidental extra value anywhere in either
  // block — including one slipped in ahead of RETIRED's doc comment — must
  // fail this test. This one test owns the whole pin for both enums, on
  // purpose: splitting an exact-shape check from a membership check across
  // two tests leaves the exhaustive guarantee living only as an undocumented
  // pairing between them, and a future reader who deletes the apparent
  // duplicate would silently remove the only exhaustive check left.
  //
  // A published document whose CharityPilot record has been deleted keeps
  // naming its Confluence page rather than being erased or discarded: an
  // ordinary deletion removes our record and our reference only, and
  // destroying the source is a separate, explicitly authorised action. RETIRED
  // is how the state machine says that. Comment lines inside the enum block
  // (RETIRED's) are stripped so this pins the value list, not the
  // documentation prose around it.
  const stateBlock = schema.match(/enum DocumentPublicationState \{([^}]*)\}/)?.[1] ?? '';
  const stateValues = stateBlock
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'));
  assert.deepEqual(stateValues, ['PENDING', 'DEAD_LETTER', 'PROCESSED', 'RETIRED']);

  const terminalReasons = schema.match(/enum DocumentPublicationTerminalReason \{([\s\S]*?)\}/);
  assert.ok(terminalReasons, 'schema.prisma must declare DocumentPublicationTerminalReason');
  const declared = terminalReasons[1].split('\n').map((line) => line.trim()).filter(Boolean);
  // One reason per permanent condition the publish failure mapping names, plus
  // the exhausted-retries reason the backoff engine itself produces.
  assert.deepEqual(declared, [
    'MAX_ATTEMPTS_EXHAUSTED',
    'PERMANENT_CONNECTION_UNAVAILABLE',
    'PERMANENT_PERMISSION_DENIED',
    'PERMANENT_CONFLICT_UNRESOLVED',
    'PERMANENT_CONTENT_PROPERTY_REJECTED',
    'PERMANENT_TARGET_REF_REJECTED',
  ]);
});

test('the publication row copies the DocumentStorageDeletion reliability shape field by field', () => {
  const deletionModel = modelBlock(schema, 'DocumentStorageDeletion');
  for (const [field, declaration] of RELIABILITY_FIELDS) {
    assert.match(
      publicationModel,
      declaration,
      `DocumentPublication must copy the ${field} reliability field`,
    );
    assert.match(
      deletionModel,
      new RegExp(`^\\s*${field}\\s`, 'm'),
      `${field} must be a field the reliability engine already has, not an invention`,
    );
  }
});

test('the publication row records where the bytes went', () => {
  for (const [field, declaration] of PUBLICATION_FIELDS) {
    assert.match(publicationModel, declaration, `DocumentPublication must record ${field}`);
  }
  assert.match(publicationModel, /^\s*organisationId\s+String\s*$/m);
  assert.match(publicationModel, /^\s*documentId\s+String\s*$/m);
  assert.match(publicationModel, /^\s*provider\s+String\s+@default\("confluence"\)\s*$/m);
});

test('one document and provider can only ever carry one publication', () => {
  assert.ok(
    publicationModel.includes('@@unique([documentId, provider])'),
    'the unique pair is what stops two enqueues becoming two Confluence pages',
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "DocumentPublication_documentId_provider_key" ON "DocumentPublication"\("documentId", "provider"\);/,
  );
});

test('the publication row outlives the document it mirrors, so it carries no foreign key', () => {
  // A cascading relation to Document would delete the pageId at the exact moment
  // the dual-erasure path needs it to enqueue the Confluence erasure.
  assert.doesNotMatch(publicationModel, /@relation/);
  assert.doesNotMatch(migration, /FOREIGN KEY/);
});

test('the publication migration is atomic and purely additive', () => {
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.match(migration, /CREATE TABLE "DocumentPublication"/);
  assert.match(migration, /CREATE TYPE "DocumentPublicationState"/);
  assert.match(migration, /CREATE TYPE "DocumentPublicationTerminalReason"/);
  for (const forbidden of [/\bDROP\b/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bUPDATE\s+"/i]) {
    assert.doesNotMatch(migration, forbidden);
  }
  // The only table this migration may touch is the one it creates.
  const touched = new Set(
    [...migration.matchAll(/(?:CREATE TABLE|ALTER TABLE|INSERT INTO)\s+"([A-Za-z0-9_]+)"/g)].map(
      (match) => match[1],
    ),
  );
  assert.deepEqual([...touched], ['DocumentPublication']);
});

test('every identifier the publication migration creates survives 63-byte truncation', () => {
  const identifiers = [
    ...migration.matchAll(
      /(?:CREATE (?:UNIQUE )?INDEX|CONSTRAINT|CREATE TABLE|CREATE TYPE)\s+"([A-Za-z0-9_]+)"/g,
    ),
  ].map((match) => match[1]);
  assert.ok(identifiers.length > 0, 'the migration must create named objects');
  for (const identifier of identifiers) {
    assert.ok(
      Buffer.byteLength(identifier) <= POSTGRES_IDENTIFIER_LIMIT,
      `${identifier} is ${Buffer.byteLength(identifier)} bytes; PostgreSQL would truncate it to ${POSTGRES_IDENTIFIER_LIMIT}`,
    );
  }
});

test('the migration creates exactly the indexes the schema declares, under the same names', () => {
  const created = [
    ...migration.matchAll(
      /CREATE (UNIQUE )?INDEX "([A-Za-z0-9_]+)" ON "DocumentPublication"\(([^)]*)\);/g,
    ),
  ].map((match) => ({
    unique: Boolean(match[1]),
    name: match[2],
    columns: match[3].split(',').map((column) => column.trim().replace(/"/g, '')),
  }));
  assert.deepEqual(
    created.map((index) => index.name).sort(),
    EXPECTED_INDEXES.map((index) => index.name).sort(),
  );
  for (const expected of EXPECTED_INDEXES) {
    assert.ok(
      Buffer.byteLength(expected.name) <= POSTGRES_IDENTIFIER_LIMIT,
      `${expected.name} would be truncated by PostgreSQL`,
    );
    assert.ok(
      publicationModel.includes(expected.attribute),
      `schema.prisma must declare ${expected.attribute}`,
    );
    const actual = created.find((index) => index.name === expected.name);
    assert.ok(actual, `migration must create ${expected.name}`);
    assert.equal(actual.unique, expected.unique, `${expected.name} uniqueness must match`);
    assert.deepEqual(actual.columns, [...expected.columns], `${expected.name} columns must match`);
  }
});

test('the target-window migration is atomic and touches only the publication table', () => {
  assert.match(targetWindowMigration, /^BEGIN;/);
  assert.match(targetWindowMigration, /COMMIT;\s*$/);
  // It replaces one CHECK constraint and nothing else. A DROP of anything that
  // holds data — a table, a column, an index — would be a different migration
  // than the one this test permits.
  assert.doesNotMatch(targetWindowMigration, /\bDROP\s+(?!CONSTRAINT\b)/i);
  for (const forbidden of [/\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bUPDATE\s+"/i]) {
    assert.doesNotMatch(targetWindowMigration, forbidden);
  }
  const touched = new Set(
    [...targetWindowMigration.matchAll(/ALTER TABLE\s+"([A-Za-z0-9_]+)"/g)].map((match) => match[1]),
  );
  assert.deepEqual([...touched], ['DocumentPublication']);
});

test('the disposable E2E reset inventory lists the publication table exactly once', () => {
  assert.equal(
    DISPOSABLE_DATABASE_RESET_TABLES.filter((table) => table === 'DocumentPublication').length,
    1,
  );
});

function docker(args: string[], input?: string, timeout = 30_000) {
  return spawnSync('docker', args, { input, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
}

function assertDockerSuccess(result: ReturnType<typeof docker>, operation: string): void {
  assert.equal(
    result.status,
    0,
    `${operation} failed: ${(result.stderr || result.stdout || result.error?.message || 'unknown error').slice(0, 1000)}`,
  );
}

function psql(container: string, sql: string, expectedSuccess = true) {
  const result = docker(
    [
      'exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-Atq',
    ],
    sql,
    30_000,
  );
  if (expectedSuccess) assertDockerSuccess(result, 'PostgreSQL fixture command');
  else assert.notEqual(result.status, 0, 'a statement the publication table must refuse succeeded');
  return result;
}

async function waitForPostgres(container: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = docker(
      ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
      undefined,
      5_000,
    );
    if (ready.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail('Disposable PostgreSQL 16 fixture did not become ready');
}

async function removeDisposableContainer(container: string): Promise<void> {
  docker(['rm', '--force', container], undefined, 20_000);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const residue = docker(
      ['ps', '--all', '--filter', `name=^/${container}$`, '--format', '{{.ID}}'],
      undefined,
      10_000,
    );
    if (!residue.stdout.trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail('Disposable PostgreSQL cleanup left container residue');
}

const insertPublication = (input: {
  id: string;
  documentId: string;
  organisationId?: string;
  provider?: string;
}) => `
  INSERT INTO "DocumentPublication" ("id", "organisationId", "documentId"${input.provider ? ', "provider"' : ''})
  VALUES ('${input.id}', '${input.organisationId ?? 'org-1'}', '${input.documentId}'${input.provider ? `, '${input.provider}'` : ''});
`;

test(
  'real PostgreSQL 16 publication table starts pending and refuses a second publication of one document',
  { timeout: 300_000 },
  async () => {
    const dockerAvailable = docker(['version', '--format', '{{.Server.Version}}'], undefined, 60_000);
    assertDockerSuccess(dockerAvailable, 'Docker availability check for the publication proof');
    const container = `charitypilot-document-publication-${randomUUID()}`;
    const start = docker(
      [
        'run', '--detach', '--rm', '--name', container,
        '--env', 'POSTGRES_PASSWORD=document-publication-fixture-only',
        POSTGRES_IMAGE,
      ],
      undefined,
      120_000,
    );
    assertDockerSuccess(start, 'Disposable PostgreSQL 16 startup');

    try {
      await waitForPostgres(container);
      // The migration must stand on its own: it creates a table with no foreign
      // keys, so an empty database is the whole of its prerequisites.
      psql(container, migration);
      // Then the follow-up that opens the create-then-attach window. Applied in
      // order, exactly as `migrate deploy` applies them.
      psql(container, targetWindowMigration);

      psql(container, insertPublication({ id: 'pub-1', documentId: 'doc-1' }));
      const defaults = psql(
        container,
        `SELECT "state" || '|' || "attempts" || '|' || "provider" || '|'
             || ("nextAttemptAt" IS NOT NULL) || '|' || ("claimedAt" IS NULL) || '|'
             || ("publishedAt" IS NULL) || '|' || ("processedAt" IS NULL)
         FROM "DocumentPublication" WHERE "id" = 'pub-1';`,
      );
      assert.equal(defaults.stdout.trim(), 'PENDING|0|confluence|true|true|true|true');

      // The load-bearing constraint: a retried enqueue cannot become a second page.
      psql(container, insertPublication({ id: 'pub-2', documentId: 'doc-1' }), false);
      // Not even from another tenant claiming the same document id.
      psql(
        container,
        insertPublication({ id: 'pub-3', documentId: 'doc-1', organisationId: 'org-2' }),
        false,
      );
      // A different provider, and a different document, are separate publications.
      psql(container, insertPublication({ id: 'pub-4', documentId: 'doc-1', provider: 'sharepoint' }));
      psql(container, insertPublication({ id: 'pub-5', documentId: 'doc-2' }));
      const surviving = psql(container, `SELECT count(*) FROM "DocumentPublication";`);
      assert.equal(surviving.stdout.trim(), '3');

      // The copied state machine stays fail-closed against a direct-SQL
      // regression. Each statement violates exactly one constraint, so a
      // constraint weakened on its own shows up as its own failure.
      const forbidden = [
        // attempts_nonnegative
        `UPDATE "DocumentPublication" SET "attempts" = -1 WHERE "id" = 'pub-1';`,
        // lastError_bounded
        `UPDATE "DocumentPublication" SET "lastError" = repeat('x', 501) WHERE "id" = 'pub-1';`,
        // alert_claim_consistent, both directions
        `UPDATE "DocumentPublication" SET "alertClaimToken" = 'token' WHERE "id" = 'pub-1';`,
        `UPDATE "DocumentPublication" SET "alertClaimedAt" = CURRENT_TIMESTAMP WHERE "id" = 'pub-1';`,
        // state_consistent: a PENDING row may not carry terminal evidence
        `UPDATE "DocumentPublication" SET "deadLetteredAt" = CURRENT_TIMESTAMP WHERE "id" = 'pub-1';`,
        // state_consistent: a PENDING row always has a next attempt, or the
        // outbox would never pick it up again and it would stall invisibly
        `UPDATE "DocumentPublication" SET "nextAttemptAt" = NULL WHERE "id" = 'pub-1';`,
        // state_consistent: a dead letter must say when it was dead-lettered
        `UPDATE "DocumentPublication" SET "state" = 'DEAD_LETTER', "attempts" = 1, "nextAttemptAt" = NULL, "terminalReason" = 'MAX_ATTEMPTS_EXHAUSTED' WHERE "id" = 'pub-1';`,
        // state_consistent: a dead letter needs a reason
        `UPDATE "DocumentPublication" SET "state" = 'DEAD_LETTER', "attempts" = 1, "nextAttemptAt" = NULL, "deadLetteredAt" = CURRENT_TIMESTAMP WHERE "id" = 'pub-1';`,
        // state_consistent: a dead letter must name the attempt that produced it
        `UPDATE "DocumentPublication" SET "state" = 'DEAD_LETTER', "attempts" = 0, "nextAttemptAt" = NULL, "deadLetteredAt" = CURRENT_TIMESTAMP, "terminalReason" = 'MAX_ATTEMPTS_EXHAUSTED' WHERE "id" = 'pub-1';`,
        // state_consistent: PROCESSED is not reachable without a processedAt
        `UPDATE "DocumentPublication" SET "state" = 'PROCESSED', "attempts" = 1, "nextAttemptAt" = NULL, "publishedAt" = CURRENT_TIMESTAMP, "cloudId" = 'c', "pageId" = 'p' WHERE "id" = 'pub-1';`,
        // publication_target_consistent: a site with no page on it. This is
        // refused by the *pairing* rule -- `("pageId" IS NULL) = ("cloudId" IS
        // NULL)` -- and not by the published-row rule further down, which never
        // gets a say because the pairing rule has already failed. The
        // published-row rule has its own statement below.
        `UPDATE "DocumentPublication" SET "state" = 'PROCESSED', "attempts" = 1, "nextAttemptAt" = NULL, "processedAt" = CURRENT_TIMESTAMP, "publishedAt" = CURRENT_TIMESTAMP, "cloudId" = 'cloud-1' WHERE "id" = 'pub-1';`,
        // publication_target_consistent: published, but nothing says where.
        // The only row that reaches this rule is one whose ids are *both*
        // null, which the pairing rule is happy with -- and a DEAD_LETTER row
        // is where it is reachable, because that branch of state_consistent
        // says nothing at all about `publishedAt`.
        `UPDATE "DocumentPublication" SET "state" = 'DEAD_LETTER', "attempts" = 1, "nextAttemptAt" = NULL, "deadLetteredAt" = CURRENT_TIMESTAMP, "terminalReason" = 'MAX_ATTEMPTS_EXHAUSTED', "publishedAt" = CURRENT_TIMESTAMP WHERE "id" = 'pub-1';`,
        // publication_target_consistent: an untrimmed id is refused HERE rather
        // than dead-lettering the erasure later, after the Irish copy is gone.
        `UPDATE "DocumentPublication" SET "state" = 'PROCESSED', "attempts" = 1, "nextAttemptAt" = NULL, "processedAt" = CURRENT_TIMESTAMP, "publishedAt" = CURRENT_TIMESTAMP, "cloudId" = 'cloud-1', "pageId" = ' page-1 ' WHERE "id" = 'pub-1';`,
        // publication_target_consistent: a page id names nothing without the
        // site it lives on, and a site names nothing without the page.
        `UPDATE "DocumentPublication" SET "pageId" = 'page-1' WHERE "id" = 'pub-1';`,
        `UPDATE "DocumentPublication" SET "cloudId" = 'cloud-1' WHERE "id" = 'pub-1';`,
        // publication_target_consistent: an untrimmed id is refused during the
        // create-then-attach window too, not only once published — the whole
        // point is that the erasure parser never meets one.
        `UPDATE "DocumentPublication" SET "cloudId" = 'cloud-1', "pageId" = ' page-1 ' WHERE "id" = 'pub-1';`,
        // publication_target_consistent: an empty id addresses nothing, and
        // btrim('') = '' would otherwise let it through. Pinned on both ids:
        // the pairing rule means a row always carries the two together, so
        // either column alone could rot without the other noticing.
        `UPDATE "DocumentPublication" SET "cloudId" = '', "pageId" = 'page-1' WHERE "id" = 'pub-1';`,
        `UPDATE "DocumentPublication" SET "cloudId" = 'cloud-1', "pageId" = '' WHERE "id" = 'pub-1';`,
        // publication_target_consistent: and the untrimmed-id refusal on both
        // ids too, for the same reason. `parseConfluenceErasureTarget` refuses
        // an untrimmed `cloudId` at the application boundary; this is the
        // database saying so independently, which is what makes the two a
        // defence in depth rather than one check written twice.
        `UPDATE "DocumentPublication" SET "cloudId" = ' cloud-1 ', "pageId" = 'page-1' WHERE "id" = 'pub-1';`,
        // publication_target_consistent: an attachment hangs from a page
        `UPDATE "DocumentPublication" SET "attachmentId" = 'att-1' WHERE "id" = 'pub-1';`,
      ];
      for (const statement of forbidden) {
        psql(container, statement, false);
      }

      // The create-then-attach window, which the publish worker cannot survive
      // a crash without: the page is recorded the moment it exists, with
      // `publishedAt` still null because nothing has been attached to it yet.
      // A row that could not say this would have to re-derive the page from a
      // search on the next attempt — and a search that has not yet seen a page
      // created seconds ago sends the worker to the deliberately
      // non-idempotent `createPage`, which is how one board resolution becomes
      // two pages.
      psql(
        container,
        `UPDATE "DocumentPublication"
         SET "cloudId" = 'cloud-1', "spaceId" = 'space-1', "pageId" = 'page-1',
             "pageTitle" = 'Board Minutes', "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = 'pub-1';`,
      );
      const attaching = psql(
        container,
        `SELECT "state" || '|' || ("publishedAt" IS NULL) || '|' || "cloudId" || '|' || "pageId"
         FROM "DocumentPublication" WHERE "id" = 'pub-1';`,
      );
      assert.equal(attaching.stdout.trim(), 'PENDING|true|cloud-1|page-1');

      // A legitimate terminal publication is still permitted, and it is the row
      // that remembers the site the bytes went to.
      psql(
        container,
        `UPDATE "DocumentPublication"
         SET "state" = 'PROCESSED', "attempts" = 1, "lastAttemptAt" = CURRENT_TIMESTAMP,
             "nextAttemptAt" = NULL, "claimedAt" = NULL, "processedAt" = CURRENT_TIMESTAMP,
             "publishedAt" = CURRENT_TIMESTAMP, "cloudId" = 'cloud-1', "spaceId" = 'space-1',
             "pageId" = 'page-1', "attachmentId" = 'att-1', "pageTitle" = 'Board Minutes',
             "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = 'pub-1';`,
      );
      const published = psql(
        container,
        `SELECT "state" || '|' || "cloudId" || '|' || "pageId" FROM "DocumentPublication" WHERE "id" = 'pub-1';`,
      );
      assert.equal(published.stdout.trim(), 'PROCESSED|cloud-1|page-1');

      // A dead letter must carry its reason and the attempt that produced it.
      psql(
        container,
        `UPDATE "DocumentPublication"
         SET "state" = 'DEAD_LETTER', "attempts" = 1, "lastAttemptAt" = CURRENT_TIMESTAMP,
             "lastError" = 'no live Confluence connection', "nextAttemptAt" = NULL,
             "claimedAt" = NULL, "deadLetteredAt" = CURRENT_TIMESTAMP,
             "terminalReason" = 'PERMANENT_CONNECTION_UNAVAILABLE', "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = 'pub-5';`,
      );
      psql(
        container,
        `UPDATE "DocumentPublication" SET "terminalReason" = NULL WHERE "id" = 'pub-5';`,
        false,
      );

      // The alert claim is only ever taken on a dead letter, which is the one
      // state whose branch says nothing about the alert fields — so these two
      // statements can be refused by alert_claim_consistent and nothing else.
      psql(
        container,
        `UPDATE "DocumentPublication" SET "alertClaimToken" = 'token' WHERE "id" = 'pub-5';`,
        false,
      );
      psql(
        container,
        `UPDATE "DocumentPublication" SET "alertClaimedAt" = CURRENT_TIMESTAMP WHERE "id" = 'pub-5';`,
        false,
      );
      psql(
        container,
        `UPDATE "DocumentPublication"
         SET "alertClaimToken" = 'token', "alertClaimedAt" = CURRENT_TIMESTAMP,
             "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = 'pub-5';`,
      );
    } finally {
      await removeDisposableContainer(container);
    }
  },
);
