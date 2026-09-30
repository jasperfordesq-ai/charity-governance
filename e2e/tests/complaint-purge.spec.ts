import { reviewCopyPolicy } from '../helpers/copy-policy';
import { reviewCopyPreservation } from '../helpers/copy-preservation';
import { test, expect, reliableFill, uniqueEmail, TEST_PASSWORD } from '../fixtures';
import { IS_DEPLOYED_QA } from '../env';
import { createAuthenticatedStorageState, createVerifiedOwner, withDb } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';

test('Owner reviews and withdraws complaint disposal then explicitly purges only its primary record',async({newFencedContext})=>{
  test.skip(IS_DEPLOYED_QA,'Synthetic expired recovery requires the identity-bound disposable database.');
  test.setTimeout(120_000);
  const owner=await createVerifiedOwner({email:uniqueEmail('complaint-purge'),password:TEST_PASSWORD,
    name:'Disposal Owner',organisationName:'Synthetic Disposal Charity'});
  const id=`complaint-purge-${Date.now()}`;
  await withDb(async client=>{
    await client.query(`UPDATE "Subscription" SET plan='COMPLETE',"updatedAt"=now() WHERE "organisationId"=$1`,[owner.organisationId]);
    await client.query(`INSERT INTO "DataRetentionPolicyRevision" (id,"organisationId","recordClass",revision,state,"retentionMode","recoveryDays","createdById","approvedById","approvedAt","approvalEvidenceRef")
      VALUES ($1,$2,'COMPLAINT',1,'APPROVED','REVIEW_REQUIRED',30,$3,$3,now(),'SYNTHETIC-POLICY')`,[`${id}-policy`,owner.organisationId,owner.userId]);
    await client.query(`INSERT INTO "ComplaintRecord" (id,"organisationId","receivedDate",summary,status,"updatedAt")
      VALUES ($1,$2,now(),'Synthetic expired complaint','CLOSED',now())`,[id,owner.organisationId]);
    await client.query(`INSERT INTO "ComplaintRemoval" (id,"organisationId","complaintId","recordRevision","actorUserId","policyId","evidenceRef",reason)
      VALUES ($1,$2,$3,1,$4,$5,'SYNTHETIC-REMOVAL','Reviewed synthetic complaint removal')`,[`${id}-removal`,owner.organisationId,id,owner.userId,`${id}-policy`]);
    await client.query(`UPDATE "ComplaintRecord" SET "removalId"=$2,"removedAt"=(SELECT "occurredAt" FROM "ComplaintRemoval" WHERE id=$2) WHERE id=$1`,[id,`${id}-removal`]);
    // Test-only time travel; history protection is restored before any UI action.
    await client.query('BEGIN');
    try {
      await client.query('ALTER TABLE "ComplaintRemoval" DISABLE TRIGGER "ComplaintRemoval_append_only"');
      await client.query(`UPDATE "ComplaintRemoval" SET "recoveryUntil"=timezone('UTC',now())-INTERVAL '1 day' WHERE id=$1`,[`${id}-removal`]);
      await client.query('ALTER TABLE "ComplaintRemoval" ENABLE TRIGGER "ComplaintRemoval_append_only"');
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;}
  });
  const context=await newFencedContext({storageState:await createAuthenticatedStorageState({...owner,role:'OWNER'})});
  const page=await context.newPage();await gotoWithDevServerRetry(page,'/registers');
  const panel=page.getByRole('region',{name:'Complaint permanent disposal'});
  await panel.getByLabel('Complaint for disposal review').selectOption(id);
  await expect(panel.getByText('No active administrative hold at this review.')).toBeVisible();
  for(const area of ['Primary complaint record','Approved report snapshots','Downloaded and shared exports','Audit and retained evidence','Backups','Other copies and attachments']) {
    if(area!=='Primary complaint record') await panel.getByLabel(`Planned disposition — ${area}`,{exact:true}).selectOption('RETAIN_APPROVED');
    await reliableFill(panel.getByLabel(`Copy-plan reference — ${area}`,{exact:true}),'SYNTHETIC-COPY-001');
  }
  await reliableFill(panel.getByLabel('Complaint disposal authority reference'),'SYNTHETIC-DISPOSAL-001');
  await reliableFill(panel.getByLabel('Complaint disposal review reason'),'Reviewed each synthetic copy scope and approved retention.');
  async function confirm(label:string) {
    const dialog=page.getByRole('dialog');
    await expect(dialog.getByRole('button',{name:label,exact:true})).toBeDisabled();
    await dialog.getByRole('checkbox',{name:'I have reviewed this exact action and have authority to proceed.'}).check();
    await dialog.getByRole('button',{name:label,exact:true}).click();
    await expect(dialog).not.toBeVisible();
  }
  await panel.getByRole('button',{name:'Review complaint disposal authority',exact:true}).click();
  await confirm('Record complaint disposal authority');
  await panel.getByRole('button',{name:'Review withdrawal of SYNTHETIC-DISPOSAL-001',exact:true}).click();
  await reliableFill(page.getByLabel('Complaint disposal withdrawal reference'),'SYNTHETIC-WITHDRAW-001');
  await reliableFill(page.getByLabel('Complaint disposal withdrawal reason'),'Withdraw the first synthetic review before execution.');
  await confirm('Withdraw complaint disposal authority');
  await expect(panel.getByText(/Withdrawn: SYNTHETIC-WITHDRAW-001/)).toBeVisible();
  await reliableFill(panel.getByLabel('Complaint disposal authority reference'),'SYNTHETIC-DISPOSAL-002');
  await panel.getByRole('button',{name:'Review complaint disposal authority',exact:true}).click();
  await confirm('Record complaint disposal authority');
  await panel.getByRole('button',{name:'Review permanent disposal of SYNTHETIC-DISPOSAL-002',exact:true}).click();
  await confirm('Permanently dispose of primary complaint');
  await expect(panel.getByText(/This does not establish erasure of retained copies/)).toBeVisible();
  await expect(page.getByRole('region',{name:'Recoverable complaints'}).getByText('Synthetic expired complaint',{exact:true})).toHaveCount(0);
  await page.reload();await expect(panel.getByText(/This does not establish erasure of retained copies/)).toBeVisible();
  const copies=panel.getByRole('region',{name:'Copy and backup evidence'});
  await copies.getByRole('button',{name:'Load copy evidence',exact:true}).click();
  await expect(copies.getByText('No downstream observations recorded.')).toBeVisible();
  await copies.getByLabel('Evidence storage location',{exact:true}).selectOption('BACKUPS');
  await reliableFill(copies.getByLabel('Copy or inventory scope reference'),'SYNTHETIC-BACKUP-SET');
  async function observe(status:string,reference:string) {
    await copies.getByLabel('Reviewed copy outcome',{exact:true}).selectOption(status);
    await reliableFill(copies.getByLabel('Copy observation evidence reference',{exact:true}),reference);
    await reliableFill(copies.getByLabel('Reason for copy observation',{exact:true}),'Reviewed the synthetic backup inventory and custody evidence.');
    const clock=await withDb(client=>client.query(`SELECT to_char(timezone('UTC',clock_timestamp()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`));
    const dates=await page.evaluate((serverTime:string)=>{
      const local=(date:Date)=>{
        const input=document.createElement('input');input.type='datetime-local';input.step='0.001';
        input.value=new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,23);
        if(new Date(input.value).getTime()!==date.getTime())throw new Error('Observation precision lost');
        return input.value;
      };
      return {observed:local(new Date(serverTime)),followup:local(new Date(new Date(serverTime).getTime()+86400000))};
    },clock.rows[0].now);
    await copies.getByLabel('Copy observation time',{exact:true}).fill(dates.observed);
    await copies.getByLabel('Copy follow-up time',{exact:true}).fill(dates.followup);
    await copies.getByRole('checkbox',{name:'I reviewed the evidence for this exact scope and outcome.'}).check();
    const saved=page.waitForResponse(response=>response.url().endsWith('/dispositions')&&response.request().method()==='POST');
    await copies.getByRole('button',{name:'Record copy observation',exact:true}).click();
    expect((await saved).status()).toBe(201);
  }
  await observe('RETAINED_APPROVED','SYNTHETIC-COPY-OBSERVATION-001');
  const observation=(reference:string)=>copies.getByRole('listitem').filter({hasText:reference});
  await expect(observation('SYNTHETIC-COPY-OBSERVATION-001')).toContainText('Retained with approved authority');
  await observation('SYNTHETIC-COPY-OBSERVATION-001').getByRole('button',{name:'Record a later observation'}).click();
  await expect(copies.getByLabel('Copy or inventory scope reference')).toBeDisabled();
  await reviewCopyPreservation(copies);
  await observe('NEEDS_REVIEW','SYNTHETIC-COPY-OBSERVATION-002');
  await expect(observation('SYNTHETIC-COPY-OBSERVATION-001')).toContainText('Historical observation');
  await page.reload();await copies.getByRole('button',{name:'Load copy evidence',exact:true}).click();
  await expect(observation('SYNTHETIC-COPY-OBSERVATION-002')).toContainText('Revision 2');
  await withDb(async client=>{
    expect((await client.query('SELECT count(*)::int AS count FROM "ComplaintRecord" WHERE id=$1',[id])).rows[0].count).toBe(0);
    expect((await client.query('SELECT "actorUserId" FROM "ComplaintPurgeClaim" WHERE "complaintId"=$1',[id])).rows).toEqual([{actorUserId:owner.userId}]);
    expect((await client.query('SELECT count(*)::int AS count FROM "ComplaintPurgeAuthorization" WHERE "complaintId"=$1',[id])).rows[0].count).toBe(2);
    expect((await client.query(`SELECT e.revision,e.status,e."actorUserId" FROM "ComplaintPurgeDispositionEvent" e JOIN "ComplaintPurgeAuthorization" a ON a.id=e."authorizationId" WHERE a."complaintId"=$1 ORDER BY e.revision`,[id])).rows)
      .toEqual([{revision:1,status:'RETAINED_APPROVED',actorUserId:owner.userId},{revision:2,status:'NEEDS_REVIEW',actorUserId:owner.userId}]);
  });
  await reviewCopyPolicy(page, 'Complaint');
});
