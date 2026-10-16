import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { captureConfluenceCopyLocalLedgerInTransaction, prepareConfluenceCopyLocalLedger,
  CONFLUENCE_COPY_LEDGER_TABLES, CONFLUENCE_COPY_LEDGER_MAX_BYTES } from './confluence-copy-ledger-snapshot.js';
import { validateConfluenceExecutionLedgerLegacyRows } from './confluence-copy-ledger-validation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext } from './recovery-preparation-envelope.js';

export const CONFLUENCE_EXECUTION_LEDGER_V2_TABLES = Object.freeze([...CONFLUENCE_COPY_LEDGER_TABLES,
  'ConfluenceCopyExecutionClaim','ConfluenceCopyExecutionRequest','ConfluenceCopyExecutionOutcome'] as const);
const extraNames = CONFLUENCE_EXECUTION_LEDGER_V2_TABLES.slice(8);
const id=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), controlId=z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const hash=z.string().regex(/^[a-f0-9]{64}$/), evidence=z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/);
const time=z.string().datetime({precision:3}).refine(value=>new Date(value).toISOString()===value);
const reason=z.string().refine(value=>Array.from(value.trim()).length>=10 && Array.from(value.trim()).length<=500 && !/[\u0000-\u001f\u007f-\u009f]/.test(value));
const row=z.object({id,organisationId:controlId}).passthrough();
const schema=z.object({format:z.literal(2),kind:z.literal('CONFLUENCE_EXECUTION_LEDGER_V2'),
  installationId:controlId,organisationId:controlId,actorUserId:controlId,
  declaredSourceRevision:z.string().regex(/^[a-f0-9]{40}$/),writerEpoch:z.number().int().positive().max(2147483647),
  captureOperationId:controlId,capturedAt:time,tables:z.record(z.array(row).max(10000))}).strict();
const claimSchema=z.object({id,organisationId:controlId,permissionId:id,operationId:controlId,actorUserId:id,
  snapshotSha256:hash,evidenceRef:evidence,reason,phase:z.literal('QUARANTINED'),providerIOAuthorised:z.literal(false),claimedAt:time}).strict();
const requestSchema=z.object({id,organisationId:controlId,claimId:id,requestKey:controlId,actorUserId:id,
  action:z.enum(['TRASH','PURGE']),evidenceRef:evidence,reason,phase:z.literal('QUARANTINED'),providerIOAuthorised:z.literal(false),preparedAt:time}).strict();
const outcomeSchema=z.object({id,organisationId:controlId,requestId:id,requestOutcome:z.enum(['ACKNOWLEDGED','REFUSED','UNRESOLVED']),
  reportingBasis:z.literal('APPLICATION_REPORT'),automaticRetryAllowed:z.literal(false),providerAbsenceVerified:z.literal(false),
  allCopiesVerified:z.literal(false),providerIOAuthorised:z.literal(false),reportedAt:time,
  recordedByDatabaseRole:z.string().min(1).max(63).refine(value=>!/[\u0000-\u001f\u007f-\u009f]/.test(value))}).strict();
function canonical(raw:unknown):string {
  const visit=(value:unknown):unknown=>Array.isArray(value)?value.map(visit):value!==null&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a===b?0:1).map(([key,item])=>[key,visit(item)])):value;
  return JSON.stringify(visit(raw));
}
const digest=(body:string)=>createHash('sha256').update(body,'utf8').digest('hex');
function unique(values:string[]) { if(new Set(values).size!==values.length) throw new Error(); }

/** Original rows only. Historical structure is not evidence of live authority,
 * verified provider response, independent freshness or complete transport state. */
export function prepareConfluenceExecutionLedgerV2(raw:unknown,rawContext:RecoveryEnvelopeContext) {
  try {
    const wire=JSON.stringify(raw);if(Buffer.byteLength(wire,'utf8')>CONFLUENCE_COPY_LEDGER_MAX_BYTES)throw new Error();
    const context=validateRecoveryEnvelopeContext(rawContext),ledger=schema.parse(JSON.parse(wire));
    if(ledger.installationId!==context.installationId||ledger.organisationId!==context.organisationId
      ||ledger.declaredSourceRevision!==context.sourceRevision||ledger.writerEpoch!==context.writerEpoch
      ||ledger.captureOperationId!==context.operationId)throw new Error();
    if(Object.keys(ledger.tables).length!==11||CONFLUENCE_EXECUTION_LEDGER_V2_TABLES.some(name=>!Object.hasOwn(ledger.tables,name)))throw new Error();
    for(const group of Object.values(ledger.tables)) {
      unique(group.map(value=>value.id));if(group.some(value=>value.organisationId!==ledger.organisationId))throw new Error();
    }
    const legacy=prepareConfluenceCopyLocalLedger({format:1,kind:'CONFLUENCE_COPY_LOCAL_LEDGER_V1',installationId:ledger.installationId,
      organisationId:ledger.organisationId,actorUserId:ledger.actorUserId,declaredSourceRevision:ledger.declaredSourceRevision,capturedAt:ledger.capturedAt,
      tables:Object.fromEntries(CONFLUENCE_COPY_LEDGER_TABLES.map(name=>[name,ledger.tables[name]]))});
    validateConfluenceExecutionLedgerLegacyRows(legacy.body,context);
    const byId=(name:string)=>new Map(ledger.tables[name]!.map(value=>[value.id,value]));
    const permissions=byId('ConfluenceRetainedCopyPermission'),reviews=byId('ConfluenceRetainedCopyReview'),scopes=byId('ConfluenceSyntheticCopyScope');
    const checkAuthorityAt=(permissionId:string,at:string)=>{
      const permission=permissions.get(permissionId);if(!permission)throw new Error();
      const review=reviews.get(id.parse(permission.reviewId)),scope=scopes.get(id.parse(permission.scopeId));
      if(!review||!scope||at<time.parse(permission.issuedAt)||at>=time.parse(permission.expiresAt)
        ||at<time.parse(scope.registeredAt)||at>=time.parse(scope.expiresAt)||at>=time.parse(review.expiresAt)||at>ledger.capturedAt)throw new Error();
      for(const [name,key,target] of [['ConfluenceRetainedCopyPermissionWithdrawal','permissionId',permissionId],
        ['ConfluenceRetainedCopyReviewWithdrawal','reviewId',review.id]] as const) {
        if(ledger.tables[name]!.some(value=>value[key]===target&&time.parse(value.occurredAt)<at))throw new Error();
      }
      return permission;
    };
    const claims=ledger.tables.ConfluenceCopyExecutionClaim!.map(value=>claimSchema.parse(value));
    unique(claims.map(value=>value.permissionId));unique(claims.map(value=>value.operationId));
    for(const claim of claims)if(checkAuthorityAt(claim.permissionId,claim.claimedAt).snapshotSha256!==claim.snapshotSha256)throw new Error();
    const claimIds=new Map(claims.map(value=>[value.id,value]));
    const requests=ledger.tables.ConfluenceCopyExecutionRequest!.map(value=>requestSchema.parse(value));
    unique(requests.map(value=>value.requestKey));unique(requests.map(value=>JSON.stringify([value.claimId,value.action])));
    for(const request of requests) {
      const claim=claimIds.get(request.claimId);
      if(!claim||request.actorUserId!==claim.actorUserId||request.preparedAt<claim.claimedAt)throw new Error();
      checkAuthorityAt(claim.permissionId,request.preparedAt);
    }
    const requestIds=new Map(requests.map(value=>[value.id,value]));
    const outcomes=ledger.tables.ConfluenceCopyExecutionOutcome!.map(value=>outcomeSchema.parse(value));unique(outcomes.map(value=>value.requestId));
    for(const outcome of outcomes) {
      const request=requestIds.get(outcome.requestId);
      if(!request||outcome.reportedAt<request.preparedAt||outcome.reportedAt>ledger.capturedAt)throw new Error();
    }
    const body=canonical(ledger);if(Buffer.byteLength(body,'utf8')>CONFLUENCE_COPY_LEDGER_MAX_BYTES)throw new Error();
    return {body,digest:digest(body),ledger,executionHistoryIncluded:true as const,actionAuthorized:false as const,
      independentlyPreserved:false as const,currentHistoryVerified:false as const,reopeningAuthorised:false as const,transportStateReconciled:false as const};
  } catch {throw new Error('Invalid or over-capacity Confluence execution ledger V2');}
}

/** Confidential read-only capture; declarations need host attestation. */
export async function captureConfluenceExecutionLedgerV2(prisma:PrismaClient,organisationId:string,actorUserId:string,rawContext:RecoveryEnvelopeContext) {
  try {
    return await prisma.$transaction(tx=>captureConfluenceExecutionLedgerV2InTransaction(tx,organisationId,actorUserId,rawContext),
      {isolationLevel:'RepeatableRead',maxWait:5000,timeout:30000});
  } catch {throw new Error('Confluence execution ledger V2 capture is unresolved; preserve existing evidence');}
}

/** Internal delegate. Caller owns Repeatable Read and any durable capture write.
 * This is a consistent MVCC snapshot, not independently current authority. */
export async function captureConfluenceExecutionLedgerV2InTransaction(tx:Prisma.TransactionClient,organisationId:string,actorUserId:string,rawContext:RecoveryEnvelopeContext) {
  const context=validateRecoveryEnvelopeContext(rawContext);if(context.organisationId!==organisationId)throw new Error();
      const old=await captureConfluenceCopyLocalLedgerInTransaction(tx,organisationId,actorUserId,
        {installationId:context.installationId,declaredSourceRevision:context.sourceRevision});
      const legacy=JSON.parse(old.body) as {tables:Record<string,unknown>;[key:string]:unknown};
      const sizes=await tx.$queryRaw<Array<{name:string;count:bigint;bytes:bigint}>>(Prisma.join(extraNames.map(name=>Prisma.sql`
        SELECT ${name}::text AS name,count(*) AS count,coalesce(sum(octet_length(to_jsonb(t)::text)),0)::bigint AS bytes
        FROM ${Prisma.raw(`public."${name}"`)} t WHERE "organisationId"=${organisationId}`),' UNION ALL '));
      if(sizes.length!==3||new Set(sizes.map(value=>value.name)).size!==3||sizes.some(value=>!extraNames.some(name=>name===value.name)
        ||value.count<0n||value.count>10000n||value.bytes<0n)
        ||sizes.reduce((sum,value)=>sum+value.bytes,BigInt(Buffer.byteLength(old.body,'utf8')))>120n*1024n*1024n)throw new Error();
      const query={where:{organisationId},orderBy:{id:'asc' as const},take:10001};
      const groups=await Promise.all([tx.confluenceCopyExecutionClaim.findMany(query),tx.confluenceCopyExecutionRequest.findMany(query),tx.confluenceCopyExecutionOutcome.findMany(query)]);
      for(const [index,group]of groups.entries())if(group.length>10000||BigInt(group.length)!==sizes.find(value=>value.name===extraNames[index])?.count)throw new Error();
      const tables={...legacy.tables,...Object.fromEntries(extraNames.map((name,index)=>[name,groups[index]]))};
      return prepareConfluenceExecutionLedgerV2({...legacy,format:2,kind:'CONFLUENCE_EXECUTION_LEDGER_V2',writerEpoch:context.writerEpoch,
        captureOperationId:context.operationId,tables},context);

}
