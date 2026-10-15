import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { lockOrganisationForUpdate } from './organisation-lock.js';
import { readConfluenceCopyDecisionHistory } from './confluence-copy-decision-history.js';
import { prepareConfluenceCopyRecoveryFacts, type ConfluenceCopyRecoveryFacts } from './confluence-copy-recovery-facts.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import type { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import type { RecoveryDataKeys } from './recovery-preparation-envelope.js';
import type { ConfluenceCopyRecoveryObjects } from './confluence-copy-recovery-envelope.js';

const names = ['reviews','scopes','permissions','reviewWithdrawals','permissionWithdrawals'] as const;
type Name = typeof names[number];
const record = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  organisationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/) }).passthrough();
const schema = z.object({ reviews: z.array(record).max(10000), scopes: z.array(record).max(10000),
  permissions: z.array(record).max(10000), reviewWithdrawals: z.array(record).max(10000),
  permissionWithdrawals: z.array(record).max(10000) }).strict();
type Rows = z.infer<typeof schema>;
type History = Awaited<ReturnType<typeof readConfluenceCopyDecisionHistory>>;
const digest = (body: string) => createHash('sha256').update(body,'utf8').digest('hex');
function canonical(value: unknown): string {
  const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered)
    : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a < b ? -1 : a === b ? 0 : 1).map(([k,item]) => [k,ordered(item)])) : v;
  return JSON.stringify(ordered(value));
}
function parseRows(raw: unknown): Rows {
  try {
    const wire = JSON.stringify(raw);
    if (Buffer.byteLength(wire,'utf8') > 128 * 1024 * 1024) throw new Error();
    const rows = schema.parse(JSON.parse(wire));
    for (const name of names) rows[name].sort((a,b) => a.id < b.id ? -1 : a.id === b.id ? 0 : 1);
    return rows;
  } catch { throw new Error('Invalid or over-capacity local Confluence decision rows'); }
}

/** A proposed insert-only reconciliation, never a restore permission/executor.
 * Do not delete local-only evidence or overwrite any differing immutable row. */
export function buildConfluenceCopyReconciliationPlan(organisationId: string, history: History, raw: unknown) {
  if (history.scope !== 'CONFLUENCE_DECISION_STATES_ONLY' || !history.confluencePayloadsVerified) {
    throw new Error('Confluence reconciliation requires authenticated decision history');
  }
  const rows = parseRows(raw), expected: Record<Name,Map<string,Record<string,unknown>>> = {
    reviews: new Map(), scopes: new Map(), permissions: new Map(), reviewWithdrawals: new Map(), permissionWithdrawals: new Map() };
  for (const state of history.latestStates) {
    let prepared;
    try { prepared = prepareConfluenceCopyRecoveryFacts(JSON.parse(state.body)); }
    catch { throw new Error('Invalid Confluence reconciliation history facts'); }
    const facts = JSON.parse(prepared.body) as ConfluenceCopyRecoveryFacts;
    if (prepared.body !== state.body || prepared.digest !== state.digest || facts.organisationId !== organisationId
      || facts.review.id !== state.reviewId || facts.operationId !== state.operationId) throw new Error('Confluence reconciliation history binding mismatch');
    for (const [name,value] of [['reviews',facts.review],['scopes',facts.scope],['permissions',facts.permission],
      ['reviewWithdrawals',facts.reviewWithdrawal],['permissionWithdrawals',facts.permissionWithdrawal]] as const) {
      if (!value) continue;
      const old = expected[name].get(value.id);
      if (old && canonical(old) !== canonical(value)) throw new Error('Confluence reconciliation history reuses immutable IDs');
      expected[name].set(value.id,value);
    }
  }
  const inserts: Array<{ table: Name; record: Record<string,unknown> }> = [];
  let matching = 0;
  for (const name of names) {
    const seen = new Set<string>();
    for (const local of rows[name]) {
      if (local.organisationId !== organisationId || seen.has(local.id)) throw new Error('Confluence reconciliation local scope or identity mismatch');
      seen.add(local.id);
      const remote = expected[name].get(local.id);
      if (!remote) throw new Error('Local Confluence evidence is absent from independent history; preserve and reconcile it');
      if (canonical(local) !== canonical(remote)) throw new Error('Local Confluence evidence contradicts immutable independent history');
      matching++;
    }
    for (const [id,value] of [...expected[name]].sort(([a],[b]) => a < b ? -1 : a === b ? 0 : 1)) {
      if (!seen.has(id)) inserts.push({ table: name, record: value });
    }
  }
  const candidate = { format: 1, organisationId, scope: history.scope,
    head: { generation: history.generation, digest: history.digest, revision: history.revision },
    localRowsDigest: digest(canonical(rows)), matchingRecords: matching, inserts };
  return { ...candidate, candidateDigest: digest(canonical(candidate)), requiresReplay: inserts.length > 0,
    actionAuthorized: false as const, currentHistoryVerified: false as const, reopeningAuthorised: false as const };
}

/** Owner-scoped, read-only inspection. An operator restore coordinator and
 * historical SQL executor are separate; no routine app write guard is relaxed. */
export async function inspectConfluenceCopyReconciliation(prisma: PrismaClient, organisationId: string, actorUserId: string,
  deps: { journal: RecoveryAuthorityJournal; control: RecoveryControlStore; keys: RecoveryDataKeys;
    objects: Pick<ConfluenceCopyRecoveryObjects,'readConfluenceCopyState'> }, allowedKeyIds: readonly string[]) {
  const load = async (tx: Prisma.TransactionClient) => {
    await lockOrganisationForUpdate(tx,organisationId);
    await tx.$queryRaw`SELECT id FROM public."User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
    const actor = await tx.user.findFirst({ where: { id: actorUserId, organisationId, role: 'OWNER', lifecycleStatus: 'ACTIVE' }, select: { id: true } });
    const charity = await tx.organisation.findFirst({ where: { id: organisationId, lifecycleStatus: 'ACTIVE' }, select: { id: true } });
    if (!actor || !charity) throw new Error('Confluence reconciliation inspection requires active charity Owner');
    // Check server-side wire size before materialising potentially large JSON
    // reviews. Eight MiB headroom covers SQL/API timestamp representation drift.
    const sizes = await tx.$queryRaw<Array<{ kind: string; count: bigint; bytes: bigint }>>`
      SELECT 'reviews' AS kind,count(*) AS count,coalesce(sum(octet_length(to_jsonb(t)::text)),0) AS bytes FROM public."ConfluenceRetainedCopyReview" t WHERE "organisationId"=${organisationId}
      UNION ALL SELECT 'scopes',count(*),coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM public."ConfluenceSyntheticCopyScope" t WHERE "organisationId"=${organisationId}
      UNION ALL SELECT 'permissions',count(*),coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM public."ConfluenceRetainedCopyPermission" t WHERE "organisationId"=${organisationId}
      UNION ALL SELECT 'reviewWithdrawals',count(*),coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM public."ConfluenceRetainedCopyReviewWithdrawal" t WHERE "organisationId"=${organisationId}
      UNION ALL SELECT 'permissionWithdrawals',count(*),coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM public."ConfluenceRetainedCopyPermissionWithdrawal" t WHERE "organisationId"=${organisationId}`;
    if (sizes.length !== 5 || new Set(sizes.map(s => s.kind)).size !== 5
      || sizes.some(s => !names.includes(s.kind as Name) || s.count < 0n || s.count > 10000n || s.bytes < 0n)
      || sizes.reduce((sum,s) => sum + s.bytes,0n) > 120n * 1024n * 1024n) {
      throw new Error('Local Confluence decision rows exceed bounded reconciliation capacity');
    }
    const query = { where: { organisationId }, orderBy: { id: 'asc' as const }, take: 10001 };
    const [reviews,scopes,permissions,reviewWithdrawals,permissionWithdrawals] = await Promise.all([
      tx.confluenceRetainedCopyReview.findMany(query),tx.confluenceSyntheticCopyScope.findMany(query),
      tx.confluenceRetainedCopyPermission.findMany(query),tx.confluenceRetainedCopyReviewWithdrawal.findMany(query),
      tx.confluenceRetainedCopyPermissionWithdrawal.findMany(query) ]);
    return parseRows({ reviews,scopes,permissions,reviewWithdrawals,permissionWithdrawals });
  };
  const before = await prisma.$transaction(load, { isolationLevel: 'ReadCommitted' });
  const history = await readConfluenceCopyDecisionHistory(deps.journal,deps.control,deps.keys,deps.objects,allowedKeyIds);
  const after = await prisma.$transaction(load, { isolationLevel: 'ReadCommitted' });
  if (canonical(before) !== canonical(after)) throw new Error('Local Confluence decisions changed during independent verification');
  const current = validateRecoveryControl(await deps.control.readControl());
  if (current.organisationId !== organisationId || current.revision !== history.revision) throw new Error('Confluence control changed during reconciliation inspection');
  return buildConfluenceCopyReconciliationPlan(organisationId,history,after);
}
