import assert from 'node:assert/strict';
import test from 'node:test';
import { ComplaintPurgeService, complaintPurgeAuthorizationInput } from '../services/complaint-purge.service.js';

const plan=Object.fromEntries(['PRIMARY','SNAPSHOTS','EXPORTS','AUDIT','BACKUPS','OTHER_COPIES'].map(area=>
  [area,{disposition:area==='PRIMARY'?'DISPOSE':'RETAIN_APPROVED',evidenceRef:'COPY-001'}]));
const input={expectedRecordRevision:2,expectedHoldRevision:0,policyId:'policy',removalId:'removal',
  recoveryUntil:'2026-09-01T00:00:00.000Z',authorityConfirmed:true,
  evidenceRef:'REVIEW-001',reason:'Reviewed complaint disposal authority',dispositionPlan:plan};
function fixture() {
  const f={owner:true,bound:false,record:{id:'complaint',revision:2,removalId:'removal',removal:{recoveryUntil:new Date(input.recoveryUntil)}} as any,
    auth:{id:'auth',actorUserId:'actor',complaintId:'complaint',withdrawal:null,claim:null} as any,
    rows:[] as any[],reads:[] as any[],writes:[] as any[],error:null as Error|null};
  const tx={
    $queryRaw:async()=>[],
    complaintRecoveryEnforcement:{findUnique:async()=>f.bound?{id:'binding'}:null},
    user:{findFirst:async({where}:any)=>{
      assert.deepEqual(where,{id:'actor',organisationId:'org',role:'OWNER',lifecycleStatus:'ACTIVE'});
      return f.owner?{id:'actor'}:null;
    }},
    complaintRecord:{findFirst:async({where}:any)=>{
      assert.deepEqual(where,{id:'complaint',organisationId:'org',removedAt:{not:null}});return f.record;
    }},
    complaintPurgeAuthorization:{
      findFirst:async({where}:any)=>{assert.equal(where.organisationId,'org');return f.auth;},
      findMany:async(args:any)=>{f.reads.push(args);return f.rows;},
      create:async({data,select}:any)=>{assert.equal(select.claim.select.transactionId,undefined);f.writes.push(data);return data;},
    },
    complaintPurgeClaim:{create:async({data,select}:any)=>{
      assert.equal(select.transactionId,undefined);if(f.error)throw f.error;
      f.writes.push(data);return {id:'receipt',claimedAt:new Date(input.recoveryUntil),complaintId:data.complaintId};
    }},
    complaintPurgeAuthorizationWithdrawal:{create:async({data}:any)=>{f.writes.push(data);return data;}},
    complaintPurgeDispositionEvent:{
      create:async({data}:any)=>{if(f.error)throw f.error;f.writes.push(data);return data;},
      findFirst:async({where}:any)=>{assert.equal(where.organisationId,'org');assert.equal(where.authorizationId,'auth');return null;},
      findMany:async(args:any)=>{f.reads.push(args);return f.rows;},
    },
  };
  return {f,service:new ComplaintPurgeService({$transaction:async(work:any)=>work(tx)} as never)};
}
test('complaint purge requires reviewed exact revision, original deadline and six strict areas',async()=>{
  for(const extra of [{actorUserId:'spoof'},{authorityConfirmed:false},{expectedRecordRevision:0},
    {dispositionPlan:{PRIMARY:plan.PRIMARY}},{evidenceRef:'private@example.invalid'},{reason:'bad\nreason'}]) {
    assert.equal(complaintPurgeAuthorizationInput.safeParse({...input,...extra}).success,false);
  }
  const {f,service}=fixture();await service.authorize('org','complaint','actor',input);
  assert.equal(f.writes[0].actorUserId,'actor');assert.equal(f.writes[0].organisationId,'org');
  assert.equal(f.writes[0].holdRevision,0);assert.equal(f.writes[0].removalId,'removal');
  for(const mutate of [(f:any)=>{f.owner=false;},(f:any)=>{f.record=null;},
    (f:any)=>{f.record.revision++;},(f:any)=>{f.record.removalId='new';},
    (f:any)=>{f.record.removal.recoveryUntil=new Date('2026-09-02');}]) {
    const sample=fixture();mutate(sample.f);
    await assert.rejects(sample.service.authorize('org','complaint','actor',input));assert.equal(sample.f.writes.length,0);
  }
});
test('claim requires explicit confirmation, current Owner and unwithdrawn same-Owner authority',async()=>{
  for(const mutate of [(f:any)=>{f.owner=false;},(f:any)=>{f.auth=null;},
    (f:any)=>{f.auth.withdrawal={id:'withdrawn'};},(f:any)=>{f.auth.actorUserId='former-owner';}]) {
    const {f,service}=fixture();mutate(f);
    await assert.rejects(service.claim('org','actor','auth',{confirmPermanentPurge:true}));assert.equal(f.writes.length,0);
  }
  const {f,service}=fixture();
  await assert.rejects(service.claim('org','actor','auth',{}));
  await assert.rejects(service.claim('org','actor','auth',{confirmPermanentPurge:true,actorUserId:'spoof'}));
  assert.equal(f.writes.length,0);
  const result=await service.claim('org','actor','auth',{confirmPermanentPurge:true});
  assert.equal(result.id,'receipt');assert.equal(f.writes[0].complaintId,'complaint');
});
test('claim retry returns only retained receipt without another primary deletion',async()=>{
  const {f,service}=fixture();f.auth.claim={id:'existing',complaintId:'complaint',claimedAt:new Date(),transactionId:42n};
  const result=await service.claim('org','actor','auth',{confirmPermanentPurge:true});
  assert.equal(result.id,'existing');assert.equal('transactionId' in result,false);assert.equal(f.writes.length,0);
});
test('withdrawal refuses claimed or previously withdrawn authority',async()=>{
  for(const field of ['claim','withdrawal']) {
    const {f,service}=fixture();f.auth[field]={id:'existing'};
    await assert.rejects(service.withdraw('org','actor','auth',{evidenceRef:'WITHDRAW-001',reason:'Reviewed cancellation request'}));
    assert.equal(f.writes.length,0);
  }
});
test('database authority guard becomes a safe conflict without leaking database text',async()=>{
  const {f,service}=fixture();f.error=new Error('Complaint purge claim requires unchanged unheld revision SECRET');
  f.error.name='PrismaClientUnknownRequestError';
  await assert.rejects(service.claim('org','actor','auth',{confirmPermanentPurge:true}),(error:any)=>{
    assert.equal(error.statusCode,409);assert.doesNotMatch(error.message,/SECRET/);return true;
  });
});
test('review history is Owner-only, scoped, bounded and excludes transaction identity',async()=>{
  const {f,service}=fixture();
  f.rows=Array.from({length:51},(_,index)=>({id:`review-${index}`}));
  const page=await service.list('org','actor',{complaintId:'complaint'});
  assert.equal(page.items.length,50);assert.equal(page.nextCursor,'review-49');
  assert.deepEqual(f.reads[0].where,{organisationId:'org',complaintId:'complaint'});
  assert.equal(f.reads[0].take,51);assert.equal(f.reads[0].select.claim.select.transactionId,undefined);
  f.auth={id:'cursor',authorizedAt:new Date('2026-09-01')};
  await service.list('org','actor',{complaintId:'complaint',before:'cursor'});
  assert.equal(f.reads[1].where.OR[1].id.lt,'cursor');
  assert.equal(f.reads[1].where.organisationId,'org');
  f.auth=null;
  await assert.rejects(service.list('org','actor',{before:'foreign-cursor'}));
  f.owner=false;
  await assert.rejects(service.list('org','actor',{}));
  assert.equal(f.reads.length,2);
});
const observation={area:'BACKUPS',scopeRef:'BACKUP-SET-001',revision:1,status:'RETAINED_APPROVED',
  evidenceRef:'COPY-EVIDENCE-001',reason:'Reviewed the retained backup scope',observedAt:'2026-09-30T10:00:00Z',
  nextReviewAt:'2026-10-30T10:00:00Z',evidenceReviewed:true};
test('copy observations require confirmation, scoped claim and active Owner without another primary write',async()=>{
  const {f,service}=fixture();
  await assert.rejects(service.recordDisposition('org','actor','auth',observation));
  f.auth.claim={id:'claim'};
  for(const extra of [{area:'PRIMARY'},{actorUserId:'spoof'},{evidenceReviewed:false},{revision:0},
    {nextReviewAt:null},{observedAt:'invalid'},{scopeRef:'private@example.invalid'}]) {
    await assert.rejects(service.recordDisposition('org','actor','auth',{...observation,...extra}));
  }
  assert.equal(f.writes.length,0);
  await service.recordDisposition('org','actor','auth',observation);
  assert.equal(f.writes[0].organisationId,'org');assert.equal(f.writes[0].authorizationId,'auth');
  assert.equal(f.writes[0].actorUserId,'actor');assert.ok(f.writes[0].observedAt instanceof Date);
  assert.equal(f.writes[0].evidenceReviewed,undefined);assert.equal(f.writes.length,1);
  f.owner=false;
  await assert.rejects(service.recordDisposition('org','actor','auth',observation));
});
test('complaint recovery binding freezes copy observation writes while preserving history',async()=>{
  const {f,service}=fixture();f.auth.claim={id:'claim'};f.bound=true;
  await assert.rejects(service.recordDisposition('org','actor','auth',observation),
    {statusCode:409,code:'COPY_RECOVERY_AUTHORITY_REQUIRED'});
  assert.equal(f.writes.length,0);
  await service.listDispositions('org','actor','auth',{});
});
test('copy history is bounded within authorization and rejects foreign cursors',async()=>{
  const {f,service}=fixture();f.rows=Array.from({length:51},(_,i)=>({id:`copy-${i}`}));
  const page=await service.listDispositions('org','actor','auth',{});
  assert.equal(page.items.length,50);assert.equal(page.nextCursor,'copy-49');
  assert.deepEqual(f.reads[0].where,{organisationId:'org',authorizationId:'auth'});
  await assert.rejects(service.listDispositions('org','actor','auth',{before:'foreign'}));
  f.auth=null;await assert.rejects(service.listDispositions('org','actor','auth',{}));
  assert.equal(f.reads.length,1);
});
test('copy evidence conflicts return safe review guidance',async()=>{
  const {f,service}=fixture();f.auth.claim={id:'claim'};
  f.error=new Error('Complaint purge disposition revision changed SECRET');f.error.name='PrismaClientUnknownRequestError';
  await assert.rejects(service.recordDisposition('org','actor','auth',observation),(error:any)=>{
    assert.equal(error.statusCode,409);assert.doesNotMatch(error.message,/SECRET/);return true;
  });
  f.error=new Error('Complaint copy change requires independent recovery authority SECRET');f.error.name='PrismaClientUnknownRequestError';
  await assert.rejects(service.recordDisposition('org','actor','auth',observation),
    {statusCode:409,code:'COPY_RECOVERY_AUTHORITY_REQUIRED'});
});


test('copy observations preserve explicit authority and safely report changed copy controls',async()=>{
  const {f,service}=fixture();f.auth.claim={id:'claim'};
  await service.recordDisposition('org','actor','auth',{...observation,copyAuthorityId:'scoped-authority'});
  assert.equal(f.writes.at(-1).copyAuthorityId,'scoped-authority');
  await assert.rejects(service.recordDisposition('org','actor','auth',{...observation,copyAuthorityId:'https://private.example/authority'}));
  for(const message of ['Copy observation requires current unheld scope revision SECRET',
    'Copy review requires one current approved copy policy SECRET',
    'Permanent copy retention requires approved retention SECRET',
    'Copy retention has not expired SECRET']) {
    f.error=Object.assign(new Error(message),{name:'PrismaClientUnknownRequestError'});
    await assert.rejects(service.recordDisposition('org','actor','auth',{...observation,copyAuthorityId:'scoped-authority'}),(error:any)=>{
      assert.equal(error.statusCode,409);assert.doesNotMatch(error.message,/SECRET/);return true;
    });
  }
});
