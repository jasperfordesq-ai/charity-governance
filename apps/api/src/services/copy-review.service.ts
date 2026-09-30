import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { retentionWithdrawalInput } from './retention-policy.service.js';
import { AppError } from '../utils/errors.js';

const id=z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const revision=z.number().int().positive().max(2147483647);
const evidence=z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/);
const scope=retentionWithdrawalInput.extend({area:z.string(),scopeRef:evidence,revision,
  observationRevision:z.number().int().nonnegative().max(2147483647)});
const reviewBase=scope.extend({previousId:id.nullable(),observationRevision:revision,authorityConfirmed:z.literal(true)});
const reviewInput=z.discriminatedUnion('state',[
  reviewBase.extend({state:z.literal('AUTHORIZED'),disposition:z.enum(['DISPOSE','RETAIN_APPROVED','NOT_APPLICABLE']),
    policyId:id,retentionAnchorAt:z.string().datetime({offset:true}).nullable(),
    holdRevision:z.number().int().nonnegative().max(2147483647),retentionEvidenceRef:evidence,holdEvidenceRef:evidence,
    validUntil:z.string().datetime({offset:true})}).strict(),
  reviewBase.extend({state:z.literal('WITHDRAWN'),previousId:id}).strict(),
]);
const holdInput=scope.extend({held:z.boolean(),holdConfirmed:z.literal(true)}).strict();
const baseView={id:true,authorizationId:true,area:true,scopeRef:true,revision:true,observationRevision:true,
  actorUserId:true,evidenceRef:true,reason:true,occurredAt:true} as const;
const authorityView={...baseView,previousId:true,state:true,disposition:true,policyId:true,retentionAnchorAt:true,
  holdRevision:true,retentionEvidenceRef:true,holdEvidenceRef:true,validUntil:true} as const;
const holdView={...baseView,held:true} as const;
type Kind='DOCUMENT'|'COMPLAINT';
type History='authorities'|'holds';

/** Server-selected record family; references never dispatch provider deletion. */
export class CopyReviewService {
  constructor(private readonly prisma:PrismaClient,private readonly kind:Kind) {}
  private area(value:string) {
    const allowed=this.kind==='DOCUMENT'?['VERSIONS','CONFLUENCE','EXPORTS','AUDIT','BACKUPS']:['SNAPSHOTS','EXPORTS','AUDIT','BACKUPS','OTHER_COPIES'];
    if(!allowed.includes(value))throw new AppError(400,'COPY_SCOPE_INVALID','Select a supported copy area.');
  }
  private async transaction<T>(work:(tx:Prisma.TransactionClient)=>Promise<T>):Promise<T> {
    try{return await this.prisma.$transaction(work);}
    catch(error){
      if(error instanceof Error&&error.name==='PrismaClientUnknownRequestError'&&/Copy (?:authority|hold|review|withdrawal|retention)|Permanent copy retention|Untimed copy policy/.test(error.message))
        throw new AppError(409,'COPY_REVIEW_CHANGED','Refresh the scope, policy, hold and current review before submitting again.');
      if(error&&typeof error==='object'&&'code' in error&&['P2002','P2003','P2004','P2010','P2034'].includes(String(error.code)))
        throw new AppError(409,'COPY_REVIEW_CHANGED','The copy review changed. Refresh its current state.');
      throw error;
    }
  }
  private async parent(tx:Prisma.TransactionClient,organisationId:string,actorUserId:string,authorizationId:string,owner:boolean) {
    id.parse(authorizationId);
    await tx.$queryRaw`SELECT id FROM "Organisation" WHERE id=${organisationId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR UPDATE`;
    const actor=await tx.user.findFirst({where:{id:actorUserId,organisationId,lifecycleStatus:'ACTIVE',
      role:{in:owner?['OWNER']:['OWNER','ADMIN']}},select:{id:true}});
    if(!actor)throw new AppError(403,'COPY_REVIEW_FORBIDDEN',owner?'The active charity Owner must review copy authority.':'An active charity administrator is required.');
    const args={where:{id:authorizationId,organisationId},select:{id:true,claim:{select:{id:true}}}} as const;
    if(this.kind==='DOCUMENT')await tx.$queryRaw`SELECT id FROM "DocumentPurgeAuthorization" WHERE id=${authorizationId} AND "organisationId"=${organisationId} FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM "ComplaintPurgeAuthorization" WHERE id=${authorizationId} AND "organisationId"=${organisationId} FOR UPDATE`;
    const parent=this.kind==='DOCUMENT'?await tx.documentPurgeAuthorization.findFirst(args):await tx.complaintPurgeAuthorization.findFirst(args);
    if(!parent)throw new AppError(404,'COPY_PARENT_NOT_FOUND','Disposal review not found.');
    if(!parent.claim)throw new AppError(409,'COPY_PRIMARY_NOT_CLAIMED','Review copies against a completed primary disposal claim.');
  }
  async list(organisationId:string,actorUserId:string,authorizationId:string,history:History,raw:unknown) {
    const {before}=z.object({before:id.optional()}).strict().parse(raw);
    return this.transaction(async tx=>{
      await this.parent(tx,organisationId,actorUserId,authorizationId,history==='authorities');
      const cursorArgs={where:{id:before,organisationId,authorizationId},select:{id:true,occurredAt:true}} as const;
      const anchor=!before?null:history==='authorities'
        ?this.kind==='DOCUMENT'?await tx.documentCopyDispositionAuthority.findFirst(cursorArgs):await tx.complaintCopyDispositionAuthority.findFirst(cursorArgs)
        :this.kind==='DOCUMENT'?await tx.documentCopyHoldEvent.findFirst(cursorArgs):await tx.complaintCopyHoldEvent.findFirst(cursorArgs);
      if(before&&!anchor)throw new AppError(404,'COPY_CURSOR_NOT_FOUND','Copy history cursor not found.');
      const args={where:{organisationId,authorizationId,...(anchor?{OR:[{occurredAt:{lt:anchor.occurredAt}},{occurredAt:anchor.occurredAt,id:{lt:anchor.id}}]}:{})},
        orderBy:[{occurredAt:'desc' as const},{id:'desc' as const}],take:51};
      const rows=history==='authorities'
        ?this.kind==='DOCUMENT'?await tx.documentCopyDispositionAuthority.findMany({...args,select:authorityView}):await tx.complaintCopyDispositionAuthority.findMany({...args,select:authorityView})
        :this.kind==='DOCUMENT'?await tx.documentCopyHoldEvent.findMany({...args,select:holdView}):await tx.complaintCopyHoldEvent.findMany({...args,select:holdView});
      return {items:rows.slice(0,50),nextCursor:rows.length>50?rows[49]!.id:null};
    });
  }
  async scopes(organisationId:string,actorUserId:string,authorizationId:string,raw:unknown) {
    const {before}=z.object({before:id.optional()}).strict().parse(raw);
    return this.transaction(async tx=>{
      await this.parent(tx,organisationId,actorUserId,authorizationId,false);
      const cursorArgs={where:{id:before,organisationId,authorizationId},select:{id:true,occurredAt:true}} as const;
      const anchor=!before?null:this.kind==='DOCUMENT'?await tx.documentPurgeDispositionEvent.findFirst(cursorArgs):await tx.complaintPurgeDispositionEvent.findFirst(cursorArgs);
      if(before&&!anchor)throw new AppError(404,'COPY_CURSOR_NOT_FOUND','Copy scope cursor not found.');
      const args={where:{organisationId,authorizationId,...(anchor?{OR:[
        {occurredAt:{lt:anchor.occurredAt}},{occurredAt:anchor.occurredAt,id:{lt:anchor.id}}]}:{})},
        orderBy:[{occurredAt:'desc'},{id:'desc'}],take:51,
        select:{id:true,area:true,scopeRef:true,revision:true,occurredAt:true}} as const;
      const rows=this.kind==='DOCUMENT'?await tx.documentPurgeDispositionEvent.findMany({...args,orderBy:[{occurredAt:'desc'},{id:'desc'}]}):await tx.complaintPurgeDispositionEvent.findMany({...args,orderBy:[{occurredAt:'desc'},{id:'desc'}]});
      return {items:rows.slice(0,50),nextCursor:rows.length>50?rows[49]!.id:null};
    });
  }
  async review(organisationId:string,actorUserId:string,authorizationId:string,raw:unknown) {
    const input=reviewInput.parse(raw);this.area(input.area);
    return this.transaction(async tx=>{
      await this.parent(tx,organisationId,actorUserId,authorizationId,true);
      const {authorityConfirmed:_confirmation,...fields}=input;
      const data={...fields,organisationId,actorUserId,authorizationId,
        disposition:input.state==='AUTHORIZED'?input.disposition:null,policyId:input.state==='AUTHORIZED'?input.policyId:null,
        retentionAnchorAt:input.state==='AUTHORIZED'&&input.retentionAnchorAt?new Date(input.retentionAnchorAt):null,
        holdRevision:input.state==='AUTHORIZED'?input.holdRevision:0,
        retentionEvidenceRef:input.state==='AUTHORIZED'?input.retentionEvidenceRef:null,
        holdEvidenceRef:input.state==='AUTHORIZED'?input.holdEvidenceRef:null,
        validUntil:input.state==='AUTHORIZED'?new Date(input.validUntil):null};
      return this.kind==='DOCUMENT'?tx.documentCopyDispositionAuthority.create({data,select:authorityView})
        :tx.complaintCopyDispositionAuthority.create({data,select:authorityView});
    });
  }
  async hold(organisationId:string,actorUserId:string,authorizationId:string,raw:unknown) {
    const {holdConfirmed:_confirmation,...input}=holdInput.parse(raw);this.area(input.area);
    return this.transaction(async tx=>{
      await this.parent(tx,organisationId,actorUserId,authorizationId,false);
      const data={...input,organisationId,actorUserId,authorizationId};
      return this.kind==='DOCUMENT'?tx.documentCopyHoldEvent.create({data,select:holdView}):tx.complaintCopyHoldEvent.create({data,select:holdView});
    });
  }
}
