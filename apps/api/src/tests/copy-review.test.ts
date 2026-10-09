import assert from 'node:assert/strict';
import test from 'node:test';
import { CopyReviewService } from '../services/copy-review.service.js';

const authority={area:'BACKUPS',scopeRef:'BACKUP-001',revision:1,previousId:null,observationRevision:1,
  state:'AUTHORIZED',disposition:'DISPOSE',policyId:'policy',retentionAnchorAt:null,holdRevision:0,
  retentionEvidenceRef:'RETENTION-001',holdEvidenceRef:'HOLD-001',validUntil:'2027-01-01T00:00:00Z',
  evidenceRef:'AUTH-001',reason:'Reviewed synthetic copy scope',authorityConfirmed:true};
const hold={area:'BACKUPS',scopeRef:'BACKUP-001',revision:1,observationRevision:1,held:true,
  evidenceRef:'HOLD-001',reason:'Preserve synthetic copy scope',holdConfirmed:true};
function fixture(kind:'DOCUMENT'|'COMPLAINT') {
  const state={allowed:true,parent:true,claimed:true,bound:false,writes:[] as any[],actorQueries:[] as any[],rows:[] as any[],reads:[] as any[],error:null as Error|null};
  const history={findFirst:async({where}:any)=>state.rows.find(row=>row.id===where.id&&row.organisationId===where.organisationId&&row.authorizationId===where.authorizationId)??null,findMany:async(args:any)=>{state.reads.push(args);return state.rows;},
    create:async({data,select}:any)=>{if(state.error)throw state.error;state.writes.push({data,select});return data;}};
  const parent={findFirst:async({where}:any)=>{assert.deepEqual(where,{id:'auth',organisationId:'org'});return state.parent?{id:'auth',claim:state.claimed?{id:'claim'}:null}:null;}};
  const tx:any={$queryRaw:async()=>[],user:{findFirst:async(args:any)=>{state.actorQueries.push(args);return state.allowed?{id:'actor'}:null;}},
    documentPurgeAuthorization:parent,complaintPurgeAuthorization:parent,
    documentRecoveryEnforcement:{findUnique:async()=>state.bound?{id:'binding'}:null},
    complaintRecoveryEnforcement:{findUnique:async()=>state.bound?{id:'binding'}:null},
    documentCopyDispositionAuthority:history,complaintCopyDispositionAuthority:history,
    documentCopyHoldEvent:history,complaintCopyHoldEvent:history,documentPurgeDispositionEvent:history,complaintPurgeDispositionEvent:history};
  return {state,service:new CopyReviewService({...tx,$transaction:async(fn:any)=>fn(tx)} as any,kind)};
}
for(const kind of ['DOCUMENT','COMPLAINT'] as const) {
  test(`${kind} recovery binding freezes copy writes but keeps history readable`,async()=>{
    const {state,service}=fixture(kind);state.bound=true;
    await assert.rejects(service.review('org','actor','auth',authority),{statusCode:409,code:'COPY_RECOVERY_AUTHORITY_REQUIRED'});
    await assert.rejects(service.hold('org','actor','auth',hold),{statusCode:409,code:'COPY_RECOVERY_AUTHORITY_REQUIRED'});
    assert.equal(state.writes.length,0);
    await service.list('org','actor','auth','authorities',{});
    await service.scopes('org','actor','auth',{});
  });
  test(`${kind} scoped review preserves explicit policy, actor and expiry`,async()=>{
    const {state,service}=fixture(kind);
    await service.review('org','actor','auth',authority);
    assert.deepEqual(state.actorQueries[0].where.role,{in:['OWNER']});
    const data=state.writes[0].data;
    assert.equal(data.organisationId,'org');assert.equal(data.actorUserId,'actor');assert.equal(data.authorizationId,'auth');
    assert.equal(data.authorityConfirmed,undefined);assert.ok(data.validUntil instanceof Date);assert.equal(data.policyId,'policy');
    for(const extra of [{actorUserId:'spoof'},{authorityConfirmed:false},{area:'PRIMARY'},{policyId:null},{revision:0},{holdRevision:-1}])
      await assert.rejects(service.review('org','actor','auth',{...authority,...extra}));
    assert.equal(state.writes.length,1);
  });
  test(`${kind} hold and withdrawal have separate confirmations and no grant fields`,async()=>{
    const {state,service}=fixture(kind);await service.hold('org','actor','auth',hold);
    assert.equal(state.writes[0].data.holdConfirmed,undefined);
    assert.deepEqual(state.actorQueries[0].where.role,{in:['OWNER','ADMIN']});
    const withdrawal={area:'BACKUPS',scopeRef:'BACKUP-001',revision:2,previousId:'prior',observationRevision:1,
      state:'WITHDRAWN',evidenceRef:'WITHDRAW-001',reason:'Withdraw synthetic copy authority',authorityConfirmed:true};
    await service.review('org','actor','auth',withdrawal);
    assert.equal(state.writes[1].data.policyId,null);assert.equal(state.writes[1].data.disposition,null);
    await assert.rejects(service.review('org','actor','auth',{...withdrawal,policyId:'policy'}));
    await assert.rejects(service.hold('org','actor','auth',{...hold,holdConfirmed:false}));
  });
  test(`${kind} history and writes require current actor and scoped primary claim`,async()=>{
    const {state,service}=fixture(kind);state.allowed=false;
    await assert.rejects(service.review('org','actor','auth',authority),{statusCode:403});
    state.allowed=true;state.parent=false;
    await assert.rejects(service.list('org','actor','auth','authorities',{}),{statusCode:404});
    state.parent=true;state.claimed=false;
    await assert.rejects(service.hold('org','actor','auth',hold),{statusCode:409});
    state.claimed=true;
    await assert.rejects(service.list('org','actor','auth','holds',{before:'foreign'}),{statusCode:404});
    await service.list('org','actor','auth','authorities',{});
    assert.deepEqual(state.reads[0].where,{organisationId:'org',authorizationId:'auth'});assert.equal(state.reads[0].take,51);
    state.rows=Array.from({length:51},(_,i)=>({id:`row-${i}`,organisationId:'org',authorizationId:'auth',occurredAt:new Date('2026-09-30T12:00:00Z')}));
    const page=await service.list('org','actor','auth','holds',{});assert.equal(page.items.length,50);assert.equal(page.nextCursor,'row-49');
    await service.list('org','actor','auth','holds',{before:'row-49'});
    assert.deepEqual(state.reads.at(-1).where.OR,[{occurredAt:{lt:state.rows[49].occurredAt}},{occurredAt:state.rows[49].occurredAt,id:{lt:'row-49'}}]);
    state.error=Object.assign(new Error('Copy authority revision changed SECRET'),{name:'PrismaClientUnknownRequestError'});
    await assert.rejects(service.review('org','actor','auth',authority),(error:any)=>{assert.equal(error.statusCode,409);assert.doesNotMatch(error.message,/SECRET/);return true;});
    state.error=Object.assign(new Error(`${kind==='DOCUMENT'?'Document':'Complaint'} copy change requires independent recovery authority SECRET`),
      {name:'PrismaClientUnknownRequestError'});
    await assert.rejects(service.review('org','actor','auth',authority),{statusCode:409,code:'COPY_RECOVERY_AUTHORITY_REQUIRED'});
    await assert.rejects(service.hold('org','actor','auth',hold),{statusCode:409,code:'COPY_RECOVERY_AUTHORITY_REQUIRED'});
  });
}

for(const kind of ['DOCUMENT','COMPLAINT'] as const) {
  test(`${kind} Admin scope discovery is bounded to claimed parent and omits review contents`,async()=>{
    const {state,service}=fixture(kind);
    await service.scopes('org','actor','auth',{});
    assert.deepEqual(state.actorQueries[0].where.role,{in:['OWNER','ADMIN']});
    assert.deepEqual(state.reads[0].where,{organisationId:'org',authorizationId:'auth'});
    assert.deepEqual(state.reads[0].select,{id:true,area:true,scopeRef:true,revision:true,occurredAt:true});
    assert.equal(state.reads[0].take,51);
    await assert.rejects(service.scopes('org','actor','auth',{before:'foreign'}),{statusCode:404});
    state.claimed=false;
    await assert.rejects(service.scopes('org','actor','auth',{}),{statusCode:409});
    state.allowed=false;
    await assert.rejects(service.scopes('org','actor','auth',{}),{statusCode:403});
  });
}
