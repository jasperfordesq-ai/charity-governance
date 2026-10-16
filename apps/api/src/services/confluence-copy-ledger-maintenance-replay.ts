import type { Prisma, PrismaClient } from '@prisma/client';
import { readPublishedConfluenceCopyLedger } from './published-confluence-copy-ledger.js';
import { buildConfluenceCopyLedgerReconciliationPlan } from './confluence-copy-ledger-reconciliation.js';
import { validateRecoveryControl } from './recovery-operation-reservation.js';

/** Inactive invoker-owned maintenance delegate, not a host recovery entry point.
 * SQL requires suspension, table ownership, sole client, exact enabled guards,
 * durable WAL and fresh read-committed snapshots. Host isolation/source/custody
 * and four transport tables remain separate gates. Never reopen here.
 */
export async function replayConfluenceCopyLedgerRows(maintenancePrisma: PrismaClient, organisationId: string,
  binding: Parameters<typeof readPublishedConfluenceCopyLedger>[2],
  deps: { journal: Parameters<typeof readPublishedConfluenceCopyLedger>[0];
    control: Parameters<typeof readPublishedConfluenceCopyLedger>[1];
    keys: Parameters<typeof readPublishedConfluenceCopyLedger>[3]; objects: Parameters<typeof readPublishedConfluenceCopyLedger>[4] }) {
  try {
    if (binding.context.organisationId !== organisationId) throw new Error();
    const readRows = async (client: Pick<Prisma.TransactionClient,'$queryRaw'>) => {
      const result = await client.$queryRaw<Array<{ rows: Prisma.JsonValue }>>`
        SELECT public."ConfluenceCopyLedgerRecovery_rows"(${organisationId}) AS rows`;
      if (result.length !== 1 || result[0]!.rows === null) throw new Error();
      return result[0]!.rows;
    };
    const before = await readRows(maintenancePrisma);
    const observed = validateRecoveryControl(await deps.control.readControl());
    const archive = await readPublishedConfluenceCopyLedger(deps.journal,deps.control,binding,deps.keys,deps.objects);
    if (observed.revision !== archive.revision || observed.generation !== archive.entryGeneration || observed.digest !== archive.entryDigest) throw new Error();
    const plan = buildConfluenceCopyLedgerReconciliationPlan(binding.context,archive,before);
    return await maintenancePrisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL synchronous_commit = on`;
      const applied = await tx.$queryRaw<Array<{ inserted: number }>>`
        SELECT public."ConfluenceCopyLedgerRecovery_replay"(${organisationId},${JSON.stringify(before)}::jsonb,
          ${JSON.stringify(plan.inserts)}::jsonb) AS inserted`;
      if (applied.length !== 1 || applied[0]!.inserted !== plan.inserts.length) throw new Error();
      const after = await readRows(tx);
      const reconciled = buildConfluenceCopyLedgerReconciliationPlan(binding.context,archive,after);
      if (reconciled.requiresReplay) throw new Error();
      const current = validateRecoveryControl(await deps.control.readControl());
      if (JSON.stringify(current) !== JSON.stringify(observed)) throw new Error();
      return { scope: 'CONFLUENCE_EIGHT_TABLE_LEDGER_ONLY' as const, ledgerRowsReconciled: true as const,
        insertedRecords: applied[0]!.inserted, replayed: applied[0]!.inserted === 0,
        candidateDigest: plan.candidateDigest, generation: archive.entryGeneration, digest: archive.entryDigest,
        actionAuthorized: false as const, currentHistoryVerified: false as const,
        reopeningAuthorised: false as const, transportStateReconciled: false as const };
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 30000 });
  } catch {
    // Constraint errors may expose private records. Unknown commits must retry
    // from fresh independent evidence, never a saved proposal or bypass flag.
    throw new Error('Complete Confluence maintenance replay is unresolved; retry from fresh authenticated archive evidence');
  }
}
