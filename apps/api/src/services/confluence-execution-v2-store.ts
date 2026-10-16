import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Prisma,PrismaClient,ConfluenceCopyLedgerCapture,ConfluenceCopyLedgerCandidate } from '@prisma/client';
import { lockOrganisationForUpdate } from './organisation-lock.js';
import { captureConfluenceExecutionLedgerV2InTransaction,prepareConfluenceExecutionLedgerV2 } from './confluence-execution-ledger-v2.js';
import { sealConfluenceExecutionArchiveV2,openConfluenceExecutionArchiveV2,CONFLUENCE_EXECUTION_ARCHIVE_V2_MAX_ENVELOPE_BYTES } from './confluence-execution-archive-v2.js';
import { validateRecoveryEnvelopeContext,type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { validateRecoveryControl } from './recovery-operation-reservation.js';
const input=z.object({context:z.unknown().transform(validateRecoveryEnvelopeContext),observedControl:z.unknown().transform(validateRecoveryControl)}).strict();
const flags={actionAuthorized:false as const,currentHistoryVerified:false as const,reopeningAuthorised:false as const,
 independentlyPreserved:false as const,transportStateReconciled:false as const};
const digest=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
function binding(raw:unknown) {
 const value=input.parse(raw),c=value.context,h=value.observedControl;
 if(c.installationId!==h.installationId||c.organisationId!==h.organisationId||c.writerEpoch!==h.writerEpoch
  ||h.activeOperation!==null||h.generation>=10000)throw new Error();return value;
}
async function owner(tx:Prisma.TransactionClient,organisationId:string,actorUserId:string) {
 await lockOrganisationForUpdate(tx,organisationId);
 await tx.$queryRaw`SELECT id FROM public."User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
 const actor=await tx.user.findFirst({where:{id:actorUserId,organisationId,role:'OWNER',lifecycleStatus:'ACTIVE'},select:{id:true}});
 const org=await tx.organisation.findFirst({where:{id:organisationId,lifecycleStatus:'ACTIVE'},select:{id:true}});
 if(!actor||!org)throw new Error();
}
export function validateStoredExecutionV2Capture(row:ConfluenceCopyLedgerCapture) {
 try {
  const checked=binding({context:row.context,observedControl:row.observedControl});
  const prepared=prepareConfluenceExecutionLedgerV2(JSON.parse(row.facts),checked.context);
  if(prepared.body!==row.facts||prepared.digest!==row.factsDigest||checked.context.operationId!==row.operationId
   ||checked.context.organisationId!==row.organisationId||prepared.ledger.actorUserId!==row.actorUserId
   ||prepared.ledger.capturedAt!==row.capturedAt.toISOString()||row.recordedAt<row.capturedAt)throw new Error();
  return{id:row.id,body:row.facts,digest:row.factsDigest,binding:checked,durableCaptureRecorded:true as const,...flags};
 }catch{throw new Error('Invalid original Confluence execution V2 capture');}
}
/** Exact original and declared binding persist before any encryption/upload.
 * Retrying an existing identity never recaptures later source rows. */
export class ConfluenceExecutionV2CaptureStore {
 constructor(private readonly prisma:PrismaClient){}
 async prepare(organisationId:string,actorUserId:string,raw:unknown) {
  try {
   const original=binding(raw);if(original.context.organisationId!==organisationId)throw new Error();
   return await this.prisma.$transaction(async tx=>{
    await tx.$executeRaw`SET LOCAL synchronous_commit = on`;await owner(tx,organisationId,actorUserId);
    const existing=await tx.confluenceCopyLedgerCapture.findUnique({where:{organisationId_operationId:{organisationId,operationId:original.context.operationId}}});
    if(existing){const saved=validateStoredExecutionV2Capture(existing);
     if(existing.actorUserId!==actorUserId||JSON.stringify(saved.binding)!==JSON.stringify(original))throw new Error();
     return{...saved,replayed:true};}
    const snapshot=await captureConfluenceExecutionLedgerV2InTransaction(tx,organisationId,actorUserId,original.context);
    const row=await tx.confluenceCopyLedgerCapture.create({data:{organisationId,actorUserId,operationId:original.context.operationId,
     context:original.context as Prisma.InputJsonValue,observedControl:original.observedControl as Prisma.InputJsonValue,
     facts:snapshot.body,factsDigest:snapshot.digest,capturedAt:new Date(snapshot.ledger.capturedAt)}});
    return{...validateStoredExecutionV2Capture(row),replayed:false};
   },{isolationLevel:'RepeatableRead',maxWait:5000,timeout:30000});
  }catch{throw new Error('Original Confluence execution V2 capture is unresolved; retry the original identity');}
 }
}
/** Encryption runs outside locks. Only the committed winning ciphertext is
 * returned; no object write, reservation or publication follows. */
export class ConfluenceExecutionV2CandidateStore {
 constructor(private readonly prisma:PrismaClient){}
 private async load(tx:Prisma.TransactionClient,organisationId:string,actorUserId:string,captureId:string) {
  await owner(tx,organisationId,actorUserId);
  const capture=await tx.confluenceCopyLedgerCapture.findFirst({where:{id:captureId,organisationId}});
  if(!capture||capture.id!==captureId||capture.organisationId!==organisationId||capture.actorUserId!==actorUserId)throw new Error();
  const original=validateStoredExecutionV2Capture(capture);
  const candidate=await tx.confluenceCopyLedgerCandidate.findUnique({where:{captureId}});
  return{capture,original,candidate};
 }
 private transaction<T>(organisationId:string,actorUserId:string,captureId:string,
  change:(tx:Prisma.TransactionClient,loaded:Awaited<ReturnType<ConfluenceExecutionV2CandidateStore['load']>>)=>Promise<T>) {
  return this.prisma.$transaction(async tx=>{
   await tx.$executeRaw`SET LOCAL synchronous_commit = on`;
   return change(tx,await this.load(tx,organisationId,actorUserId,captureId));
  },{isolationLevel:'RepeatableRead',maxWait:5000,timeout:30000});
 }
 async prepare(organisationId:string,actorUserId:string,captureId:string,keys:RecoveryDataKeys) {
  try {
   if(!/^[A-Za-z0-9_-]{1,200}$/.test(captureId))throw new Error();
   const first=await this.transaction(organisationId,actorUserId,captureId,async(_tx,loaded)=>loaded);
   if(first.candidate)return{...await validateStoredExecutionV2Candidate(first.capture,first.candidate,keys),replayed:true};
   const sealed=await sealConfluenceExecutionArchiveV2(first.original.body,first.original.binding,keys);
   const committed=await this.transaction(organisationId,actorUserId,captureId,async(tx,latest)=>{
    if(JSON.stringify(latest.capture)!==JSON.stringify(first.capture))throw new Error();
    if(latest.candidate)return{capture:latest.capture,candidate:latest.candidate,replayed:true};
    const candidate=await tx.confluenceCopyLedgerCandidate.create({data:{organisationId,captureId,actorUserId,
     envelope:sealed.envelope,envelopeDigest:sealed.digest}});
    return{capture:latest.capture,candidate,replayed:false};
   });
   return{...await validateStoredExecutionV2Candidate(committed.capture,committed.candidate,keys),replayed:committed.replayed};
  }catch{throw new Error('Original Confluence execution V2 candidate is unresolved; retry the original capture');}
 }
}
export async function validateStoredExecutionV2Candidate(capture:ConfluenceCopyLedgerCapture,candidate:ConfluenceCopyLedgerCandidate,
 keys:Pick<RecoveryDataKeys,'unwrap'>) {
 const original=validateStoredExecutionV2Capture(capture);
 if(candidate.captureId!==capture.id||candidate.organisationId!==capture.organisationId||candidate.actorUserId!==capture.actorUserId
  ||candidate.recordedAt<capture.recordedAt||typeof candidate.envelope!=='string'
  ||Buffer.byteLength(candidate.envelope,'utf8')>CONFLUENCE_EXECUTION_ARCHIVE_V2_MAX_ENVELOPE_BYTES||digest(candidate.envelope)!==candidate.envelopeDigest)throw new Error('Invalid original V2 candidate');
 if((await openConfluenceExecutionArchiveV2(candidate.envelope,original.binding,keys)).body!==original.body)throw new Error('V2 candidate plaintext differs');
 return{id:candidate.id,original,candidate:{envelope:candidate.envelope,digest:candidate.envelopeDigest},durableCandidateRecorded:true as const,...flags};
}
