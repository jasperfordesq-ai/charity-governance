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

export function pendingRecord(overrides: Record<string, unknown> = {}) {
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
  };
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
    findMany: async (args: { where: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
      finds.push(args);
      if (args.where.state === 'PENDING') return row.state === 'PENDING' ? [{ ...row }] : [];
      if (args.where.state === 'DEAD_LETTER') return row.state === 'DEAD_LETTER' ? [{ ...row }] : [];
      return [];
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      if (args.where.id !== row.id || args.where.state !== row.state) return null;
      if (Object.hasOwn(args.where, 'claimedAt') && args.where.claimedAt !== row.claimedAt) return null;
      return { ...row };
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
