import assert from 'node:assert/strict';
import test from 'node:test';
import { ComplaintHoldService, complaintHoldInput } from '../services/complaint-hold.service.js';

function fixture() {
  const f = { actor: true, record: { revision: 4 } as any, latest: null as any,
    rows: [] as any[], writes: [] as any[] };
  const scoped = (where: any) => assert.deepEqual(where,{ organisationId:'org',complaintId:'complaint' });
  const tx = {
    $queryRaw: async () => [],
    user: { findFirst: async ({where}: any) => {
      assert.deepEqual(where,{id:'actor',organisationId:'org',lifecycleStatus:'ACTIVE',role:{in:['OWNER','ADMIN']}});
      return f.actor ? {id:'actor'} : null;
    } },
    complaintRecord: { findFirst: async ({where}: any) => {
      assert.deepEqual(where,{id:'complaint',organisationId:'org'}); return f.record;
    } },
    complaintHoldEvent: {
      findFirst: async ({where,orderBy}: any) => { scoped(where); assert.deepEqual(orderBy,{revision:'desc'}); return f.latest; },
      findMany: async ({where,take}: any) => {
        assert.equal(where.organisationId,'org'); assert.equal(where.complaintId,'complaint');
        assert.equal(take,51); return f.rows.filter(row=>!where.revision || row.revision<where.revision.lt);
      },
      create: async ({data}: any) => { f.writes.push(data); f.latest=data; return data; },
    },
  };
  return {f,service:new ComplaintHoldService({$transaction:async (work: (value:any)=>unknown)=>work(tx)} as never)};
}
const input={expectedRecordRevision:4,expectedHoldRevision:0,held:true,evidenceRef:'HOLD-001',reason:'Reviewed preservation request'};

test('hold changes bind current charity actor and revisions without changing complaint contents',async()=>{
  const {f,service}=fixture();
  await service.change('org','complaint','actor',input);
  await service.change('org','complaint','actor',{...input,expectedHoldRevision:1,held:false,reason:'Reviewed release of preservation request'});
  assert.deepEqual(f.writes.map(row=>[row.organisationId,row.complaintId,row.actorUserId,row.revision,row.held]),[
    ['org','complaint','actor',1,true],['org','complaint','actor',2,false],
  ]);
  assert.equal(f.record.revision,4);
});
test('hold changes reject unauthorized, missing, stale, unchanged and spoofed requests',async()=>{
  for(const mutate of [
    (f:any)=>{f.actor=false;}, (f:any)=>{f.record=null;}, (f:any)=>{f.record.revision++;},
    (f:any)=>{f.latest={revision:1,held:true};},
    (f:any)=>{f.latest={revision:0,held:true};},
  ]) {
    const {f,service}=fixture(); mutate(f);
    await assert.rejects(service.change('org','complaint','actor',input));
    assert.equal(f.writes.length,0);
  }
  for(const extra of [{organisationId:'foreign'},{actorUserId:'foreign'},{expectedHoldRevision:2147483647},{reason:'bad\ncontrol'},{evidenceRef:'private@example.invalid'}]) {
    assert.equal(complaintHoldInput.safeParse({...input,...extra}).success,false);
  }
});
test('paged hold history keeps current state separate from older observations',async()=>{
  const {f,service}=fixture(); f.latest={revision:60,held:true};
  f.rows=Array.from({length:60},(_,i)=>({id:`event-${60-i}`,revision:60-i,held:false}));
  // The delegate respects the database take limit.
  f.rows=f.rows.slice(0,51);
  const first=await service.list('org','complaint');
  assert.equal(first.items.length,50); assert.equal(first.nextBeforeRevision,11);
  const older=await service.list('org','complaint',11);
  assert.equal(older.holdRevision,60); assert.equal(older.held,true);
  assert.deepEqual(older.items.map(row=>row.revision),[10]);
});
