import assert from 'node:assert/strict';

// Reused inside real disposable PostgreSQL proofs, never against live data.
export function proveCopyAuthority(sql, {kind, organisation, actor, foreignActor, authorization, scope, observationRevision}) {
  const table = `${kind}CopyDispositionAuthority`;
  assert.equal(sql(`SELECT count(*) FROM pg_constraint WHERE conname IN ('${kind}CopyAuthority_authorization_fkey','${kind}CopyAuthority_scope_revision_key');`),'2');
  let expectedHoldRevision=0;
  const review = (id, overrides={}) => {
    const v={organisation,actor,authorization,scope,revision:1,previous:'NULL',observationRevision,
      holdRevision:expectedHoldRevision,state:'AUTHORIZED',disposition:"'DISPOSE'",retention:"'RETENTION-REVIEW-001'",hold:"'HOLD-REVIEW-001'",
      expires:"timezone('UTC',clock_timestamp())+INTERVAL '1 day'",...overrides};
    return `INSERT INTO "${table}" (id,"organisationId","authorizationId",area,"scopeRef",revision,"previousId","observationRevision",state,disposition,"actorUserId","evidenceRef",reason,"retentionEvidenceRef","holdEvidenceRef","validUntil","holdRevision")
      VALUES ('${id}','${v.organisation}','${v.authorization}','BACKUPS','${v.scope}',${v.revision},${v.previous},${v.observationRevision},'${v.state}',${v.disposition},'${v.actor}','AUTHORITY-001','Reviewed synthetic scoped copy decision',${v.retention},${v.hold},${v.expires},${v.holdRevision});`;
  };
  const holdTable=`${kind}CopyHoldEvent`;
  const hold=(id, overrides={})=>{
    const v={actor,scope,revision:1,held:true,observationRevision,...overrides};
    return `INSERT INTO "${holdTable}" (id,"organisationId","authorizationId",area,"scopeRef",revision,"observationRevision",held,"actorUserId","evidenceRef",reason)
      VALUES ('${id}','${organisation}','${authorization}','BACKUPS','${v.scope}',${v.revision},${v.observationRevision},${v.held},'${v.actor}','COPY-HOLD-001','Reviewed synthetic copy preservation hold');`;
  };
  sql(`INSERT INTO "User" (id,email,name,"passwordHash",role,"lifecycleStatus","organisationId","updatedAt") VALUES
    ('copy-member','copy-member@example.invalid','Synthetic member','fixture','MEMBER','ACTIVE','${organisation}',now()),
    ('copy-admin','copy-admin@example.invalid','Synthetic admin','fixture','ADMIN','ACTIVE','${organisation}',now()),
    ('copy-suspended','copy-suspended@example.invalid','Synthetic suspended','fixture','ADMIN','SUSPENDED','${organisation}',now());`);
  sql(hold('member-hold',{actor:'copy-member'}),/active charity administrator/);
  sql(hold('suspended-hold',{actor:'copy-suspended'}),/active charity administrator/);
  sql(hold('foreign-hold',{actor:foreignActor}),/active charity administrator/);
  sql(hold('stale-hold-observation',{observationRevision:observationRevision+1}),/current scope observation/);
  sql(hold('initial-release',{held:false}),/change current hold state/);
  sql(hold('scope-held',{actor:'copy-admin'}));
  sql(hold('duplicate-hold',{revision:2}),/change current hold state/);
  sql(review('held-authority'),/current unheld scope/);
  sql(`UPDATE "${holdTable}" SET held=false;`,/append-only/);
  sql(`DELETE FROM "${holdTable}";`,/append-only/);
  sql(hold('scope-released',{revision:2,held:false}));
  sql(review('stale-hold-authority'),/current unheld scope/);
  // All later reviews must bind the released scope revision explicitly.
  expectedHoldRevision=2;
  sql(review('foreign-authority',{actor:foreignActor}),/active charity owner/);
  sql(review('stale-observation',{observationRevision:observationRevision+1}),/current scope observation/);
  sql(review('unlisted-scope',{scope:'UNLISTED-SCOPE'}),/current scope observation/);
  sql(review('missing-retention',{retention:'NULL'}),/review references/);
  sql(review('missing-hold',{hold:'NULL'}),/review references/);
  sql(review('url-hold',{hold:"'https://private.example/hold'"}),/review references/);
  sql(review('expired-authority',{expires:"timezone('UTC',clock_timestamp())-INTERVAL '1 day'"}),/future expiry/);
  sql(review('copy-authority'));
  sql(review('stale-authority'),/authority revision/);
  sql(review('wrong-predecessor',{revision:2,previous:"'wrong'"}),/authority revision/);
  sql(`UPDATE "${table}" SET disposition='RETAIN_APPROVED';`,/append-only/);
  sql(`DELETE FROM "${table}";`,/append-only/);
  sql(hold('reheld-scope',{revision:3}));
  sql(review('held-replacement',{revision:2,previous:"'copy-authority'",holdRevision:3}),/current unheld scope/);
  sql(review('withdraw-copy',{revision:2,previous:"'copy-authority'",state:'WITHDRAWN',disposition:'NULL',retention:'NULL',hold:'NULL',expires:'NULL'}));
  sql(review('double-withdraw',{revision:3,previous:"'withdraw-copy'",state:'WITHDRAWN',disposition:'NULL',retention:'NULL',hold:'NULL',expires:'NULL'}),/existing active authority/);
  sql(hold('released-again',{revision:4,held:false}));
  expectedHoldRevision=4;
  sql(hold('discovered-copy',{scope:'NEWLY-DISCOVERED-COPY',observationRevision:0}));
  sql(review('replacement-copy',{revision:3,previous:"'withdraw-copy'"}));
  // Persistence alone must not silently activate amended authority. Binding
  // observations to the new review and current policy/hold gates is separate.
  sql(`INSERT INTO "${kind}PurgeDispositionEvent" (id,"organisationId","authorizationId",area,"scopeRef",revision,status,"actorUserId","evidenceRef",reason,"observedAt")
    VALUES ('not-implicitly-absent','${organisation}','${authorization}','BACKUPS','${scope}',${observationRevision+1},'VERIFIED_ABSENT','${actor}','COPY-001','Synthetic absence without bound authority',timezone('UTC',clock_timestamp()));`,/cannot contradict/);
  assert.equal(sql(`SELECT string_agg(state,',' ORDER BY revision) FROM "${table}";`),'AUTHORIZED,WITHDRAWN,AUTHORIZED');
  assert.equal(sql(`SELECT "dispositionPlan"->'BACKUPS'->>'disposition' FROM "${kind}PurgeAuthorization" WHERE id='${authorization}';`),'RETAIN_APPROVED');
  return { review, table, hold };
}
