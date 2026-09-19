import {
  createErasureDispatcher,
  createSupabaseEraser,
  type ErasureDispatcher,
} from '../services/document-erasure.js';

/**
 * Shared fakes for the document-storage deletion pipeline unit suites.
 *
 * Not a `*.test.ts` file on purpose: `npm test` globs `dist/tests/*.test.js`,
 * so these helpers are imported, never run as a suite of their own.
 *
 * When a field is added to `DocumentStorageDeletionRecord`, add it to
 * `pendingRecord()` here, or every test that uses this fake silently exercises
 * a row shape the production code no longer sees.
 */

/**
 * Project a fixture row through a Prisma `select`, the way the real client
 * does.
 *
 * This exists because of a defect class the review ledger has now recorded
 * eight times: a fake written as `findFirst: async () => ({ … })` ignores its
 * arguments, so it hands back every field the fixture happens to carry —
 * including fields the production `select` does not ask for. Delete
 * `provider: true` from a `select` in production code and the suite stays
 * green, because the double supplies `provider` anyway; in production the
 * field is `undefined` and a guard or a response column silently breaks.
 *
 * Honouring `select` here is what retires the class: a field missing from a
 * `select` is missing from the row the test sees, exactly as in production.
 * Selecting a field the fixture does not define throws rather than yielding
 * `undefined`, so a fabricated row shape fails loudly instead of quietly.
 */
export function applyPrismaSelect<T extends Record<string, unknown>>(
  row: T,
  args?: { select?: Record<string, unknown> } | null,
): Partial<T> {
  const select = args?.select;
  if (!select) return { ...row };

  const projected: Record<string, unknown> = {};
  for (const [field, wanted] of Object.entries(select)) {
    if (!wanted) continue;
    if (!Object.hasOwn(row, field)) {
      throw new Error(
        `Prisma select asked for "${field}", which this fixture row does not define. ` +
          'Add it to the fixture rather than letting the double invent the row shape.',
      );
    }
    projected[field] = row[field];
  }
  return projected as Partial<T>;
}

/**
 * The full row shape of `DocumentStorageDeletion`, stated once. Declared
 * rather than inferred so that an override (`terminalReason`, a dead-letter
 * `nextAttemptAt: null`, a Confluence `provider`) stays assignable to the same
 * type as the default row — otherwise every call site infers its own literal
 * types and the factory stops being usable as one shared shape.
 */
export type DocumentStorageDeletionRow = {
  id: string;
  organisationId: string;
  storagePath: string;
  provider: string;
  targetRef: string | null;
  state: string;
  attempts: number;
  claimedAt: Date | null;
  nextAttemptAt: Date | null;
  deadLetteredAt: Date | null;
  terminalReason: string | null;
  alertClaimToken: string | null;
  alertClaimedAt: Date | null;
  alertedAt: Date | null;
  lastError: string | null;
  lastAttemptAt: Date | null;
  processedAt: Date | null;
  createdAt: Date;
};

export function pendingRecord(overrides: Record<string, unknown> = {}): DocumentStorageDeletionRow {
  return {
    id: 'deletion-1',
    organisationId: 'org-1',
    storagePath: 'org-1/policy.pdf',
    provider: 'supabase',
    targetRef: null,
    state: 'PENDING',
    attempts: 0,
    claimedAt: null,
    nextAttemptAt: new Date('2026-07-11T11:00:00.000Z'),
    deadLetteredAt: null,
    terminalReason: null,
    alertClaimToken: null,
    alertClaimedAt: null,
    alertedAt: null,
    lastError: null,
    lastAttemptAt: null,
    processedAt: null,
    createdAt: new Date('2026-07-11T10:00:00.000Z'),
    ...overrides,
  } as DocumentStorageDeletionRow;
}

/**
 * A dead-lettered row. The same shape as `pendingRecord()`, in the state the
 * recovery job and the administrator listing actually read.
 */
export function deadLetterRecord(overrides: Record<string, unknown> = {}): DocumentStorageDeletionRow {
  return pendingRecord({
    state: 'DEAD_LETTER',
    attempts: 5,
    nextAttemptAt: null,
    lastError: 'name=StorageApiError status=503 message=temporarily unavailable',
    lastAttemptAt: new Date('2026-07-11T11:00:00.000Z'),
    deadLetteredAt: new Date('2026-07-11T11:00:00.000Z'),
    terminalReason: 'MAX_ATTEMPTS_EXHAUSTED',
    alertedAt: new Date('2026-07-11T11:05:00.000Z'),
    ...overrides,
  });
}

export function buildFallbackPrisma(initial: ReturnType<typeof pendingRecord>) {
  let row = { ...initial };
  const finds: Array<{
    where: Record<string, unknown>;
    orderBy?: unknown;
    take?: number;
  }> = [];
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const delegate = {
    findMany: async (args: {
      where: Record<string, unknown>;
      orderBy?: unknown;
      take?: number;
      select?: Record<string, unknown>;
    }) => {
      finds.push(args);
      if (args.where.state === 'PENDING') {
        return row.state === 'PENDING' ? [applyPrismaSelect(row, args)] : [];
      }
      if (args.where.state === 'DEAD_LETTER') {
        return row.state === 'DEAD_LETTER' ? [applyPrismaSelect(row, args)] : [];
      }
      return [];
    },
    findFirst: async (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
      if (args.where.id !== row.id || args.where.state !== row.state) return null;
      if (Object.hasOwn(args.where, 'claimedAt') && args.where.claimedAt !== row.claimedAt) return null;
      return applyPrismaSelect(row, args);
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      updates.push(args);
      if (
        args.where.id &&
        args.where.id !== row.id &&
        !(typeof args.where.id === 'object' && args.where.id !== null &&
          Array.isArray((args.where.id as { in?: unknown }).in) &&
          ((args.where.id as { in: unknown[] }).in).includes(row.id))
      ) return { count: 0 };
      if (args.where.state && args.where.state !== row.state) return { count: 0 };
      if (typeof args.where.attempts === 'number' && args.where.attempts !== row.attempts) return { count: 0 };
      if (Object.hasOwn(args.where, 'claimedAt') && args.where.claimedAt !== row.claimedAt) return { count: 0 };
      if (args.where.alertClaimToken && args.where.alertClaimToken !== row.alertClaimToken) return { count: 0 };
      row = { ...row, ...args.data };
      return { count: 1 };
    },
  };
  return {
    prisma: {
      documentStorageDeletion: delegate,
      documentStorageDeletionRecovery: { create: async () => ({ id: 'recovery-1' }) },
    },
    finds,
    updates,
    row: () => row,
  };
}

/**
 * The production Supabase wiring, so a test that only cares about the deleter
 * still goes through the real dispatcher and the real Supabase adapter.
 */
export function supabaseDispatcher(
  deleteFile: (organisationId: string, storagePath: string, signal?: AbortSignal) => Promise<void>,
): ErasureDispatcher {
  return createErasureDispatcher({ supabase: createSupabaseEraser(deleteFile) });
}
