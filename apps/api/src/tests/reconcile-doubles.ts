/**
 * Minimal stand-ins for the reconcile job's collaborators, for tests whose
 * subject is something else.
 *
 * These exist because `runProductionSchedulerOnce` now runs the reconcile pass
 * too, so every test of the scheduler as a whole has to supply one — and a test
 * about deadline reminders should not have to describe a Confluence estate to
 * say what it means. What each double does is therefore "nothing, visibly":
 * an empty tenant list, a reconciler that is never called, and counters a
 * caller can assert on when it does care.
 *
 * They are NOT a substitute for the reconciler's own tests. Nothing here
 * exercises a page read, a rate limit or the dormancy sweep; that is
 * `confluence-reconcile.service.test.ts`'s job.
 */
import type {
  ConfluenceReconciler,
  DocumentPublicationRemoteState,
  ReconcilablePublication,
  RemoteStateReading,
} from '../services/confluence-reconcile.service.js';

/** A Prisma stand-in with an empty Confluence estate. */
export function emptyIntegrationEstate(): never {
  return {
    organisationIntegration: {
      async findMany() {
        return [];
      },
      async updateMany() {
        return { count: 0 };
      },
    },
  } as never;
}

export type ReconcileRunnerCalls = {
  claims: Array<{ organisationId: string; limit: number; minAgeMs: number }>;
  recorded: Array<{
    publicationId: string;
    reading: RemoteStateReading;
    previousState: DocumentPublicationRemoteState | null;
  }>;
  orphanSweeps: number;
};

export function recordingReconcileRunner(claims: ReconcilablePublication[] = []) {
  const calls: ReconcileRunnerCalls = { claims: [], recorded: [], orphanSweeps: 0 };
  return {
    calls,
    runner: {
      async claimPublicationsForReconcile(input: {
        organisationId: string;
        limit: number;
        minAgeMs: number;
      }): Promise<ReconcilablePublication[]> {
        calls.claims.push(input);
        return claims.filter((row) => row.organisationId === input.organisationId);
      },
      async recordRemoteState(
        publicationId: string,
        reading: RemoteStateReading,
        previousState: DocumentPublicationRemoteState | null,
      ): Promise<boolean> {
        calls.recorded.push({ publicationId, reading, previousState });
        return true;
      },
      async retireOrphanedPublications(): Promise<{ retired: number; deleted: number }> {
        calls.orphanSweeps += 1;
        return { retired: 0, deleted: 0 };
      },
    },
  };
}

/**
 * A reconciler that fails the test if it is ever called.
 *
 * Deliberately not a silent no-op. A scheduler test that accidentally grew a
 * tenant would otherwise pass while quietly exercising the real path.
 */
export const unreachableReconciler: ConfluenceReconciler = async () => {
  throw new Error('the reconciler was called by a test that declared an empty estate');
};
