import assert from 'node:assert/strict';

export async function proveCopyBinding(sql,{kind,organisation,actor,authorization,originalPolicyFrozenAfterRecoveryBinding=false},orderedRace) {
  const scope='BINDING-COPY-001';
  const observation=(id,overrides={})=>{
    const v={scope,revision:1,status:'RETAINED_APPROVED',binding:'NULL',observed:"timezone('UTC',clock_timestamp())",...overrides};
    return `INSERT INTO "${kind}PurgeDispositionEvent" (id,"organisationId","authorizationId",area,"scopeRef",revision,status,"actorUserId","evidenceRef",reason,"observedAt","nextReviewAt","copyAuthorityId")
      VALUES ('${id}','${organisation}','${authorization}','BACKUPS','${v.scope}',${v.revision},'${v.status}','${actor}','COPY-OBS-001','Synthetic exact-scope copy evidence',${v.observed},timezone('UTC',clock_timestamp())+INTERVAL '1 day',${v.binding});`;
  };
  const grant=(id,overrides={})=>{
    const v={holdRevision:0,scope,revision:1,previous:'NULL',observed:1,state:'AUTHORIZED',disposition:"'DISPOSE'",policy:"'copy-policy'",anchor:'NULL',expires:"timezone('UTC',clock_timestamp())+INTERVAL '1 day'",...overrides};
    return `INSERT INTO "${kind}CopyDispositionAuthority" (id,"organisationId","authorizationId",area,"scopeRef",revision,"previousId","observationRevision",state,disposition,"actorUserId","evidenceRef",reason,"retentionEvidenceRef","holdEvidenceRef","validUntil","holdRevision","policyId","retentionAnchorAt")
      VALUES ('${id}','${organisation}','${authorization}','BACKUPS','${v.scope}',${v.revision},${v.previous},${v.observed},'${v.state}',${v.disposition},'${actor}','AUTH-REVIEW-001','Synthetic policy-bound copy review',${v.state==='WITHDRAWN'?'NULL':"'RETENTION-001'"},${v.state==='WITHDRAWN'?'NULL':"'HOLD-REVIEW-001'"},${v.expires},${v.holdRevision},${v.policy},${v.anchor});`;
  };
  sql(observation('binding-retained'));
  sql(grant('missing-policy',{policy:'NULL'}),/current approved copy policy/);
  sql(grant('wrong-class',{policy:`(SELECT "policyId" FROM "${kind}PurgeAuthorization" WHERE id='${authorization}')`}),/current approved copy policy/);
  sql(grant('binding-authority'));
  sql(observation('no-binding',{revision:2,status:'VERIFIED_ABSENT'}),/requires explicit current scoped authority/);
  sql(observation('wrong-scope-binding',{revision:2,status:'VERIFIED_ABSENT',binding:"'replacement-copy'"}),/current scoped authority/);
  sql(observation('predated-binding',{revision:2,status:'VERIFIED_ABSENT',binding:"'binding-authority'",observed:"'2000-01-01'::timestamp"}),/observation predates scoped authority/);
  sql(observation('binding-pending',{revision:2,status:'PENDING_DISPOSAL',binding:"'binding-authority'"}));
  sql(observation('binding-absent',{revision:3,status:'VERIFIED_ABSENT',binding:"'binding-authority'"}));
  assert.equal(sql(`SELECT "copyAuthorityId" FROM "${kind}PurgeDispositionEvent" WHERE id='binding-absent';`),'binding-authority');
  sql(grant('binding-withdrawal',{revision:2,previous:"'binding-authority'",observed:3,state:'WITHDRAWN',disposition:'NULL',policy:'NULL',expires:'NULL'}));
  sql(observation('withdrawn-binding',{revision:4,status:'VERIFIED_ABSENT',binding:"'binding-authority'"}),/current scoped authority/);
  sql(observation('no-fallback',{revision:4,status:'RETAINED_APPROVED'}),/requires explicit current scoped authority/);
  sql(observation('binding-unresolved',{revision:4,status:'NEEDS_REVIEW'}));
  sql(grant('binding-retain-authority',{revision:3,previous:"'binding-withdrawal'",observed:4,disposition:"'RETAIN_APPROVED'"}));
  sql(observation('binding-retained-again',{revision:5,binding:"'binding-retain-authority'"}));
  sql(observation('expiring-original',{scope:'EXPIRING-COPY'}));
  sql(grant('expiring-authority',{scope:'EXPIRING-COPY',expires:"timezone('UTC',clock_timestamp())+INTERVAL '1 second'"}));
  sql('SELECT pg_sleep(1.1);');
  sql(observation('expired-binding',{scope:'EXPIRING-COPY',revision:2,status:'VERIFIED_ABSENT',binding:"'expiring-authority'"}),/expired scoped authority/);
  sql(observation('held-original',{scope:'HELD-BINDING-COPY'}));
  sql(grant('held-binding-authority',{scope:'HELD-BINDING-COPY'}));
  const holdCopy=(id,revision,held)=>`INSERT INTO "${kind}CopyHoldEvent" (id,"organisationId","authorizationId",area,"scopeRef",revision,"observationRevision",held,"actorUserId","evidenceRef",reason)
    VALUES ('${id}','${organisation}','${authorization}','BACKUPS','HELD-BINDING-COPY',${revision},1,${held},'${actor}','HOLD-BIND-001','Synthetic hold after reviewed authority');`;
  const heldAttempt=observation('held-bound-absence',{scope:'HELD-BINDING-COPY',revision:2,status:'VERIFIED_ABSENT',binding:"'held-binding-authority'"});
  if(orderedRace) await orderedRace(holdCopy('held-binding',1,true),heldAttempt,/current unheld scope/);
  else { sql(holdCopy('held-binding',1,true)); sql(heldAttempt,/current unheld scope/); }
  sql(holdCopy('released-binding',2,false));
  sql(observation('stale-released-absence',{scope:'HELD-BINDING-COPY',revision:2,status:'VERIFIED_ABSENT',binding:"'held-binding-authority'"}),/current unheld scope/);
  sql(grant('rechecked-binding-authority',{scope:'HELD-BINDING-COPY',revision:2,previous:"'held-binding-authority'",holdRevision:2}));
  sql(observation('rechecked-absence',{scope:'HELD-BINDING-COPY',revision:2,status:'VERIFIED_ABSENT',binding:"'rechecked-binding-authority'"}));
  const withdrawPolicy=id=>`INSERT INTO "DataRetentionPolicyWithdrawal" (id,"organisationId","policyId","actorUserId",reason,"evidenceRef") VALUES ('withdraw-${id}','${organisation}','${id}','${actor}','Replace synthetic copy policy','COPY-POLICY-CHANGE');`;
  const withdrawnPolicyAttempt=observation('withdrawn-policy-binding',{revision:6,binding:"'binding-retain-authority'"});
  if(orderedRace) await orderedRace(withdrawPolicy('copy-policy'),withdrawnPolicyAttempt,/current approved copy policy/);
  else { sql(withdrawPolicy('copy-policy')); sql(withdrawnPolicyAttempt,/current approved copy policy/); }
  sql(observation('withdrawn-policy-fact',{revision:6,status:'NEEDS_REVIEW'}));
  sql(`INSERT INTO "DataRetentionPolicyRevision" (id,"organisationId","recordClass",revision,state,"retentionMode","retentionAnchor","retentionDays","recoveryDays","createdById","approvedById","approvedAt","approvalEvidenceRef")
    VALUES ('copy-timed','${organisation}','${kind.toUpperCase()}_COPY',2,'APPROVED','AFTER_ANCHOR','CREATED_AT',1,30,'${actor}','${actor}',now(),'COPY-TIMED-001');`);
  sql(observation('timed-original',{scope:'TIMED-COPY'}));
  sql(grant('no-anchor',{scope:'TIMED-COPY',policy:"'copy-timed'"}),/reviewed copy anchor/);
  sql(grant('unexpired-retention',{scope:'TIMED-COPY',policy:"'copy-timed'",anchor:"timezone('UTC',clock_timestamp())"}),/Copy retention has not expired/);
  sql(grant('timed-authority',{scope:'TIMED-COPY',policy:"'copy-timed'",anchor:"timezone('UTC',clock_timestamp())-INTERVAL '2 days'"}));
  sql(observation('timed-absent',{scope:'TIMED-COPY',revision:2,status:'VERIFIED_ABSENT',binding:"'timed-authority'"}));
  sql(withdrawPolicy('copy-timed'));
  sql(`INSERT INTO "DataRetentionPolicyRevision" (id,"organisationId","recordClass",revision,state,"retentionMode","recoveryDays","createdById","approvedById","approvedAt","approvalEvidenceRef")
    VALUES ('copy-permanent','${organisation}','${kind.toUpperCase()}_COPY',3,'APPROVED','PERMANENT',30,'${actor}','${actor}',now(),'COPY-PERMANENT-001');`);
  sql(observation('permanent-original',{scope:'PERMANENT-COPY'}));
  sql(grant('permanent-disposal',{scope:'PERMANENT-COPY',policy:"'copy-permanent'"}),/Permanent copy retention/);
  sql(grant('permanent-retain',{scope:'PERMANENT-COPY',policy:"'copy-permanent'",disposition:"'RETAIN_APPROVED'"}));
  sql(observation('permanent-retained',{scope:'PERMANENT-COPY',revision:2,binding:"'permanent-retain'"}));
  const originalPolicy=sql(`SELECT "policyId" FROM "${kind}PurgeAuthorization" WHERE id='${authorization}';`);
  if (originalPolicyFrozenAfterRecoveryBinding) {
    sql(withdrawPolicy(originalPolicy),/requires independent recovery authority/);
    assert.equal(sql(`SELECT count(*) FROM "DataRetentionPolicyWithdrawal" WHERE "policyId"='${originalPolicy}';`),'0');
  } else {
    sql(withdrawPolicy(originalPolicy));
    sql(observation('withdrawn-original-plan',{scope:'ORIGINAL-PLAN-WITHDRAWN'}),/current original-plan policy/);
    sql(observation('withdrawn-original-fact',{scope:'ORIGINAL-PLAN-WITHDRAWN',status:'NEEDS_REVIEW'}));
  }
  assert.equal(sql(`SELECT "copyAuthorityId" IS NULL FROM "${kind}PurgeDispositionEvent" WHERE id='binding-retained';`),'t');
}
