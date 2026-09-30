import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { retentionWithdrawalInput } from './retention-policy.service.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';

const id=z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const area=z.object({disposition:z.enum(['DISPOSE','RETAIN_APPROVED','NOT_APPLICABLE']),
  evidenceRef:z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/)}).strict();
export const complaintPurgeAuthorizationInput=retentionWithdrawalInput.extend({
  expectedRecordRevision:z.number().int().positive().max(2147483647),
  expectedHoldRevision:z.number().int().nonnegative().max(2147483647),
  policyId:id,removalId:id,recoveryUntil:z.string().datetime({offset:true}),authorityConfirmed:z.literal(true),
  dispositionPlan:z.object({PRIMARY:area.extend({disposition:z.literal('DISPOSE')}),
    SNAPSHOTS:area,EXPORTS:area,AUDIT:area,BACKUPS:area,OTHER_COPIES:area}).strict(),
}).strict();
const claimInput=z.object({confirmPermanentPurge:z.literal(true)}).strict();
const receipt={id:true,complaintId:true,claimedAt:true} as const;
const review={id:true,complaintId:true,recordRevision:true,holdRevision:true,removalId:true,
  policyId:true,actorUserId:true,recoveryUntil:true,dispositionPlan:true,evidenceRef:true,
  reason:true,authorizedAt:true,withdrawal:true,claim:{select:receipt}} as const;

export class ComplaintPurgeService {
  constructor(private readonly prisma:PrismaClient) {}

  private async owner(tx:Prisma.TransactionClient,organisationId:string,actorUserId:string) {
    await lockOrganisationForUpdate(tx,organisationId);
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
    const actor=await tx.user.findFirst({where:{id:actorUserId,organisationId,role:'OWNER',lifecycleStatus:'ACTIVE'},select:{id:true}});
    if(!actor) throw new AppError(403,'COMPLAINT_PURGE_OWNER_REQUIRED','The active charity Owner must review complaint disposal.');
  }

  private async transaction<T>(work:(tx:Prisma.TransactionClient)=>Promise<T>):Promise<T> {
    try {return await this.prisma.$transaction(work);}
    catch(error) {
      if(error instanceof Error && error.name==='PrismaClientUnknownRequestError'
        && /Complaint purge (?:claim|authorization|withdrawal)|Claimed complaint disposal/.test(error.message)) {
        throw new AppError(409,'COMPLAINT_PURGE_REVIEW_CHANGED','Refresh the complaint, policy, hold and disposal review. Retention and the original recovery period must expire before permanent disposal.');
      }
      if(error && typeof error==='object' && 'code' in error && ['P2002','P2004','P2010','P2034'].includes(String(error.code))) {
        throw new AppError(409,'COMPLAINT_PURGE_REVIEW_CHANGED','The disposal review changed. Refresh its current state before continuing.');
      }
      throw error;
    }
  }

  async list(organisationId:string,actorUserId:string,raw:unknown) {
    const {complaintId,before}=z.object({complaintId:id.optional(),before:id.optional()}).strict().parse(raw);
    return this.transaction(async tx=>{
      await this.owner(tx,organisationId,actorUserId);
      const anchor=before?await tx.complaintPurgeAuthorization.findFirst({where:{id:before,organisationId,complaintId},
        select:{id:true,authorizedAt:true}}):null;
      if(before&&!anchor) throw new AppError(404,'COMPLAINT_PURGE_NOT_FOUND','Disposal review cursor not found.');
      const rows=await tx.complaintPurgeAuthorization.findMany({where:{organisationId,complaintId,
        ...(anchor?{OR:[{authorizedAt:{lt:anchor.authorizedAt}},{authorizedAt:anchor.authorizedAt,id:{lt:anchor.id}}]}:{})},
        select:review,orderBy:[{authorizedAt:'desc'},{id:'desc'}],take:51});
      return {items:rows.slice(0,50),nextCursor:rows.length>50?rows[49]!.id:null};
    });
  }

  async authorize(organisationId:string,complaintId:string,actorUserId:string,raw:unknown) {
    id.parse(complaintId);
    const input=complaintPurgeAuthorizationInput.parse(raw);
    return this.transaction(async tx=>{
      await this.owner(tx,organisationId,actorUserId);
      await tx.$queryRaw`SELECT id FROM "ComplaintRecord" WHERE id=${complaintId} AND "organisationId"=${organisationId} FOR UPDATE`;
      const record=await tx.complaintRecord.findFirst({where:{id:complaintId,organisationId,removedAt:{not:null}},include:{removal:true}});
      if(!record) throw new AppError(404,'COMPLAINT_NOT_FOUND','Recoverable complaint not found.');
      if(record.revision!==input.expectedRecordRevision || record.removalId!==input.removalId ||
        !record.removal || record.removal.recoveryUntil.getTime()!==new Date(input.recoveryUntil).getTime()) {
        throw new AppError(409,'COMPLAINT_PURGE_RECORD_CHANGED','The removed complaint or recovery decision changed. Review it again.');
      }
      // PostgreSQL rechecks hold, policy, original resolution and actor under
      // the same transaction locks. Authorization does not delete the record.
      return tx.complaintPurgeAuthorization.create({data:{organisationId,complaintId,actorUserId,
        recordRevision:record.revision,holdRevision:input.expectedHoldRevision,removalId:input.removalId,
        policyId:input.policyId,recoveryUntil:record.removal.recoveryUntil,
        dispositionPlan:input.dispositionPlan,evidenceRef:input.evidenceRef,reason:input.reason},select:review});
    });
  }

  async withdraw(organisationId:string,actorUserId:string,authorizationId:string,raw:unknown) {
    id.parse(authorizationId);const input=retentionWithdrawalInput.parse(raw);
    return this.transaction(async tx=>{
      await this.owner(tx,organisationId,actorUserId);
      await tx.$queryRaw`SELECT id FROM "ComplaintPurgeAuthorization" WHERE id=${authorizationId} AND "organisationId"=${organisationId} FOR UPDATE`;
      const auth=await tx.complaintPurgeAuthorization.findFirst({where:{id:authorizationId,organisationId},select:review});
      if(!auth) throw new AppError(404,'COMPLAINT_PURGE_NOT_FOUND','Disposal review not found.');
      if(auth.claim||auth.withdrawal) throw new AppError(409,'COMPLAINT_PURGE_CANNOT_WITHDRAW','This review is already withdrawn or permanent disposal has completed.');
      return tx.complaintPurgeAuthorizationWithdrawal.create({data:{organisationId,actorUserId,authorizationId,...input}});
    });
  }

  async claim(organisationId:string,actorUserId:string,authorizationId:string,raw:unknown) {
    id.parse(authorizationId);claimInput.parse(raw);
    return this.transaction(async tx=>{
      await this.owner(tx,organisationId,actorUserId);
      await tx.$queryRaw`SELECT id FROM "ComplaintPurgeAuthorization" WHERE id=${authorizationId} AND "organisationId"=${organisationId} FOR UPDATE`;
      const auth=await tx.complaintPurgeAuthorization.findFirst({where:{id:authorizationId,organisationId},select:review});
      if(!auth) throw new AppError(404,'COMPLAINT_PURGE_NOT_FOUND','Disposal review not found.');
      if(auth.withdrawal) throw new AppError(409,'COMPLAINT_PURGE_WITHDRAWN','This disposal review was withdrawn.');
      if(auth.actorUserId!==actorUserId) throw new AppError(409,'COMPLAINT_PURGE_OWNER_CHANGED','The current Owner must record a new disposal review.');
      if(auth.claim) return {id:auth.claim.id,complaintId:auth.claim.complaintId,claimedAt:auth.claim.claimedAt};
      // The database claim trigger rechecks authority, deletes the primary row
      // and records metadata audit atomically. Retained copies are separate.
      return tx.complaintPurgeClaim.create({data:{organisationId,actorUserId,authorizationId,complaintId:auth.complaintId},select:receipt});
    });
  }
}
