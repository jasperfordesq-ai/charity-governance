import type { Prisma, PrismaClient } from '@prisma/client';
import type { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import type { RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryControl } from './recovery-operation-reservation.js';
import type { RecoveryDataKeys } from './recovery-preparation-envelope.js';
import type { ConfluenceCopyRecoveryObjects } from './confluence-copy-recovery-envelope.js';
import { readConfluenceCopyDecisionHistory } from './confluence-copy-decision-history.js';
import { buildConfluenceCopyReconciliationPlan } from './confluence-copy-reconciliation.js';

/** Internal owner-client delegate, not an operator entry point or runtime route.
 * The supported host coordinator must attest isolation, source, destination and
 * separate maintenance credentials. SQL additionally enforces real table-owner,
 * suspension, sole-client and guard/constraint boundaries. Never reopen here.
 */
export async function replayConfluenceCopyDecisionRows(maintenancePrisma: PrismaClient, organisationId: string,
  deps: { journal: RecoveryAuthorityJournal; control: RecoveryControlStore; keys: RecoveryDataKeys;
    objects: Pick<ConfluenceCopyRecoveryObjects,'readConfluenceCopyState'> }, allowedKeyIds: readonly string[]) {
  try {
    const readRows = async (client: Pick<Prisma.TransactionClient,'$queryRaw'>) => {
      const result = await client.$queryRaw<Array<{ rows: Prisma.JsonValue }>>`
        SELECT public."ConfluenceCopyRecovery_rows"(${organisationId}) AS rows`;
      if (result.length !== 1 || result[0]!.rows === null) throw new Error('Invalid maintenance snapshot');
      return result[0]!.rows;
    };
    const before = await readRows(maintenancePrisma);
    const history = await readConfluenceCopyDecisionHistory(deps.journal,deps.control,deps.keys,deps.objects,allowedKeyIds);
    const plan = buildConfluenceCopyReconciliationPlan(organisationId,history,before);
    return await maintenancePrisma.$transaction(async tx => {
      const applied = await tx.$queryRaw<Array<{ inserted: number }>>`
        SELECT public."ConfluenceCopyRecovery_replay"(${organisationId},${JSON.stringify(before)}::jsonb,
          ${JSON.stringify(plan.inserts)}::jsonb) AS inserted`;
      if (applied.length !== 1 || applied[0]!.inserted !== plan.inserts.length) throw new Error('Maintenance replay count mismatch');
      const after = await readRows(tx);
      const reconciled = buildConfluenceCopyReconciliationPlan(organisationId,history,after);
      if (reconciled.requiresReplay) throw new Error('Maintenance replay is incomplete');
      const current = validateRecoveryControl(await deps.control.readControl());
      if (current.organisationId !== organisationId || current.revision !== history.revision) {
        throw new Error('Independent history changed during maintenance replay');
      }
      return { scope: 'CONFLUENCE_DECISION_ROWS_ONLY' as const, decisionRowsReconciled: true as const,
        insertedRecords: applied[0]!.inserted, replayed: applied[0]!.inserted === 0,
        candidateDigest: plan.candidateDigest, generation: history.generation, digest: history.digest,
        actionAuthorized: false as const, currentHistoryVerified: false as const, reopeningAuthorised: false as const };
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 30000 });
  } catch {
    // Database constraint errors may include complete governance records. A
    // failed/unknown commit must be retried from fresh evidence, never resumed
    // from an untrusted saved plan or exposed as a raw database error.
    throw new Error('Confluence maintenance replay is unresolved; retry from fresh independent history');
  }
}
