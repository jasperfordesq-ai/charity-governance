import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import { captureConfluenceCopyLocalLedger, prepareConfluenceCopyLocalLedger,
  CONFLUENCE_COPY_LEDGER_TABLES as tables } from './confluence-copy-ledger-snapshot.js';
import { validateConfluenceCopyLedgerRows } from './confluence-copy-ledger-validation.js';
import { readPublishedConfluenceCopyLedger } from './published-confluence-copy-ledger.js';
import { validateRecoveryControl } from './recovery-operation-reservation.js';
import type { RecoveryEnvelopeContext } from './recovery-preparation-envelope.js';

type Published = Pick<Awaited<ReturnType<typeof readPublishedConfluenceCopyLedger>>,
  'body' | 'archiveAtObservedHead' | 'ledgerRowsVerified' | 'entryGeneration' | 'entryDigest' | 'envelopeDigest' | 'revision'>;
type Table = typeof tables[number];
const order: readonly Table[] = [tables[0],tables[2],tables[3],tables[1],tables[4],tables[5],tables[6],tables[7]];
const hash = (value: string) => createHash('sha256').update(value,'utf8').digest('hex');
function canonical(value: unknown): string {
  const visit = (v: unknown): unknown => Array.isArray(v) ? v.map(visit)
    : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a < b ? -1 : a === b ? 0 : 1)
      .map(([key,item]) => [key,visit(item)])) : v;
  return JSON.stringify(visit(value));
}

/** Pure proposal builder. Published flags are not authentication: callers must
 * use the reader/coordinator below, never accept a submitted archive as proof.
 * No overwrite/deletion, SQL replay, transport recovery or authority is emitted.
 */
export function buildConfluenceCopyLedgerReconciliationPlan(context: RecoveryEnvelopeContext, archive: Published, rawLocalTables: unknown) {
  if (archive.archiveAtObservedHead !== true || archive.ledgerRowsVerified !== true
    || !Number.isSafeInteger(archive.entryGeneration) || archive.entryGeneration < 1
    || !/^[a-f0-9]{64}$/.test(archive.entryDigest) || !/^[a-f0-9]{64}$/.test(archive.envelopeDigest)
    || typeof archive.revision !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(archive.revision)) throw new Error('Invalid Confluence archive observation');
  const remote = validateConfluenceCopyLedgerRows(archive.body,context).ledger;
  // Metadata is a validation frame only. Local rows can be an incomplete old
  // subset, so validate shape/tenant/identity without inventing missing parents.
  const local = prepareConfluenceCopyLocalLedger({ ...remote, tables: rawLocalTables }).ledger.tables;
  const inserts: Array<{ table: Table; record: Record<string,unknown> }> = [];
  let matchingRecords = 0;
  for (const name of order) {
    local[name]!.sort((a,b) => a.id < b.id ? -1 : a.id === b.id ? 0 : 1);
    const expected = new Map(remote.tables[name]!.map(row => [row.id,row]));
    const seen = new Set<string>();
    for (const row of local[name]!) {
      const original = expected.get(row.id);
      if (!original) throw new Error('Local Confluence evidence is absent from the archive; preserve and reconcile it');
      if (!isDeepStrictEqual(row,original)) throw new Error('Local Confluence evidence contradicts the archive; preserve original records');
      seen.add(row.id); matchingRecords++;
    }
    const missing = [...expected.values()].filter(row => !seen.has(row.id));
    missing.sort((a,b) => name === tables[5] && a.factsRevision !== b.factsRevision
      ? Number(a.factsRevision) - Number(b.factsRevision) : a.id < b.id ? -1 : a.id === b.id ? 0 : 1);
    for (const record of missing) inserts.push({ table: name, record });
  }
  const candidate = { format: 1, scope: 'CONFLUENCE_EIGHT_TABLE_LEDGER_ONLY' as const,
    installationId: context.installationId, organisationId: context.organisationId,
    archiveBodyDigest: hash(archive.body), envelopeDigest: archive.envelopeDigest,
    head: { generation: archive.entryGeneration, digest: archive.entryDigest, revision: archive.revision },
    localRowsDigest: hash(canonical(local)), matchingRecords, inserts };
  return { ...candidate, candidateDigest: hash(canonical(candidate)), requiresReplay: inserts.length > 0,
    actionAuthorized: false as const, currentHistoryVerified: false as const,
    reopeningAuthorised: false as const, transportStateReconciled: false as const };
}

/** Internal active-Owner inspection only. Reuses bounded locked eight-table
 * database reads around fresh full-prefix authentication. No provider writer,
 * maintenance replay, restored-host isolation or reopening is supplied here.
 */
export async function inspectConfluenceCopyLedgerReconciliation(prisma: PrismaClient, organisationId: string, actorUserId: string,
  binding: Parameters<typeof readPublishedConfluenceCopyLedger>[2],
  deps: { journal: Parameters<typeof readPublishedConfluenceCopyLedger>[0];
    control: Parameters<typeof readPublishedConfluenceCopyLedger>[1];
    keys: Parameters<typeof readPublishedConfluenceCopyLedger>[3]; objects: Parameters<typeof readPublishedConfluenceCopyLedger>[4] }) {
  try {
    if (binding.context.organisationId !== organisationId) throw new Error();
    const predecessor = validateRecoveryControl(binding.observedControl);
    const load = async () => {
      const snapshot = await captureConfluenceCopyLocalLedger(prisma,organisationId,actorUserId,
        { installationId: binding.context.installationId, declaredSourceRevision: binding.context.sourceRevision });
      return prepareConfluenceCopyLocalLedger(JSON.parse(snapshot.body)).ledger.tables;
    };
    const before = await load();
    const archive = await readPublishedConfluenceCopyLedger(deps.journal,deps.control,binding,deps.keys,deps.objects);
    const after = await load();
    if (!isDeepStrictEqual(before,after)) throw new Error();
    const current = validateRecoveryControl(await deps.control.readControl());
    if (current.installationId !== binding.context.installationId || current.organisationId !== organisationId
      || current.writerId !== predecessor.writerId || current.writerEpoch !== binding.context.writerEpoch
      || current.revision !== archive.revision || current.generation !== archive.entryGeneration || current.digest !== archive.entryDigest) throw new Error();
    return buildConfluenceCopyLedgerReconciliationPlan(binding.context,archive,after);
  } catch { throw new Error('Complete Confluence ledger reconciliation is unresolved; preserve original local and independent evidence'); }
}
