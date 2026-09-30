import type { FastifyInstance, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import type { CopyReviewService } from '../services/copy-review.service.js';
import type { RetentionPolicyService } from '../services/retention-policy.service.js';
import { requireAdmin, requireOwner } from '../middleware/roles.js';
import { requireSessionLevel, requireWebSession } from '../middleware/session-level.js';
import { handleError } from '../utils/errors.js';
import { sendCreated, sendSuccess } from '../utils/response.js';

const id=z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
function failure(reply:FastifyReply,error:unknown) {
  if(error instanceof ZodError)return reply.status(400).send({code:'VALIDATION_ERROR',error:'Review the scope, policy, evidence and confirmation fields.'});
  return handleError(reply,error);
}
/** Inside authenticated parent routes; prefixes and policy classes are server-owned. */
export function registerCopyReviewRoutes(app:FastifyInstance,prefix:''|'/complaints',service:CopyReviewService,policies:RetentionPolicyService) {
  for(const history of ['authorities','holds'] as const) {
    const role=history==='authorities'?requireOwner:requireAdmin;
    const path=`${prefix}/purge-authorizations/:id/copy-${history}`;
    app.get<{Params:{id:string}}>(path,{preHandler:[role,requireWebSession]},async(req,reply)=>{
      try{return sendSuccess(reply,await service.list(req.user.organisationId,req.user.userId,id.parse(req.params.id),history,req.query));}
      catch(error){return failure(reply,error);}
    });
    app.post<{Params:{id:string}}>(path,{preHandler:[role,requireWebSession,requireSessionLevel('ADMIN')]},async(req,reply)=>{
      try{return sendCreated(reply,await service[history==='authorities'?'review':'hold'](req.user.organisationId,req.user.userId,id.parse(req.params.id),req.body));}
      catch(error){return failure(reply,error);}
    });
  }
  app.get(`${prefix}/copy-policy-revisions`,{preHandler:[requireAdmin,requireWebSession]},async(req,reply)=>{
    try{
      const {before}=z.object({before:z.coerce.number().int().positive().max(2147483647).optional()}).strict().parse(req.query);
      return sendSuccess(reply,await policies.list(req.user.organisationId,before));
    }catch(error){return failure(reply,error);}
  });
  app.post(`${prefix}/copy-policy-revisions`,{preHandler:[requireAdmin,requireWebSession,requireSessionLevel('ADMIN'),async(req,reply)=>{
    if((req.body as {state?:unknown}|null)?.state==='APPROVED')return requireOwner(req,reply);
  }]},async(req,reply)=>{
    try{return sendCreated(reply,await policies.create(req.user.organisationId,req.user.userId,req.body));}
    catch(error){return failure(reply,error);}
  });
  app.post<{Params:{id:string}}>(`${prefix}/copy-policy-revisions/:id/withdraw`,{preHandler:[requireOwner,requireWebSession,requireSessionLevel('ADMIN')]},async(req,reply)=>{
    try{return sendCreated(reply,await policies.withdraw(req.user.organisationId,req.user.userId,id.parse(req.params.id),req.body));}
    catch(error){return failure(reply,error);}
  });
}
