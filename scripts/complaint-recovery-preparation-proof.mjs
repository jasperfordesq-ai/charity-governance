import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The caller supplies the existing isolated PostgreSQL fixture, never live data. */
export function proveComplaintRecoveryPreparation(sql, authorizationId) {
  assert.match(authorizationId, /^[a-z-]+$/);
  const body = sql(`SELECT json_build_object(
    'format',1,'action','COMPLAINT_PURGE_PREPARATION','installationId','synthetic-install',
    'organisationId',a."organisationId",'operationId','synthetic-'||a.id,'writerEpoch',1,
    'actorUserId',a."actorUserId",'preparedAt',timezone('UTC',clock_timestamp()),'sourceRevision',repeat('a',40),
    'complaint',json_build_object('id',c.id,'organisationId',c."organisationId",'revision',c.revision,
      'status',c.status,'removedAt',c."removedAt",'removalId',c."removalId",'reviewedByBoard',c."reviewedByBoard",'boardMinuteReference',c."boardMinuteReference"),
    'authorization',row_to_json(a),'policy',row_to_json(p),'removalPolicy',row_to_json(op),
    'removal',row_to_json(r),'removalResolution',
      (SELECT row_to_json(e) FROM "ComplaintResolutionEvidence" e WHERE e.id=r."resolutionEvidenceId" AND e."organisationId"=a."organisationId"),
    'resolution',(SELECT row_to_json(e) FROM "ComplaintResolutionEvidence" e WHERE e."complaintId"=c.id AND e."organisationId"=a."organisationId" ORDER BY revision DESC LIMIT 1),
    'latestHold',(SELECT row_to_json(h) FROM "ComplaintHoldEvent" h WHERE h."complaintId"=c.id AND h."organisationId"=a."organisationId" ORDER BY revision DESC LIMIT 1))::text
    FROM "ComplaintPurgeAuthorization" a JOIN "ComplaintRecord" c ON c.id=a."complaintId" AND c."organisationId"=a."organisationId"
    JOIN "ComplaintRemoval" r ON r.id=a."removalId" AND r."organisationId"=a."organisationId"
    JOIN "DataRetentionPolicyRevision" p ON p.id=a."policyId" AND p."organisationId"=a."organisationId"
    JOIN "DataRetentionPolicyRevision" op ON op.id=r."policyId" AND op."organisationId"=a."organisationId"
    WHERE a.id='${authorizationId}';`);
  assert.ok(body);
  const value = JSON.parse(body);
  // PostgreSQL timestamp-without-time-zone fields in this schema store UTC.
  // Convert only enumerated temporal fields to the API's ISO Date representation.
  const dates = new Set(['preparedAt','removedAt','authorizedAt','recoveryUntil','createdAt','approvedAt','occurredAt','resolvedAt']);
  function normalize(row) {
    if (!row || typeof row !== 'object') return;
    for (const [key, item] of Object.entries(row)) {
      if (dates.has(key) && typeof item === 'string') row[key] = new Date(`${item}Z`).toISOString();
      else normalize(item);
    }
  }
  normalize(value);
  const runner = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { prepareComplaintRecoveryFacts } from './apps/api/src/services/complaint-recovery-preparation.ts';
    const value=JSON.parse(readFileSync(0,'utf8'));
    const result=prepareComplaintRecoveryFacts(value);
    assert.equal(result.actionAuthorized,false);
    assert.deepEqual(JSON.parse(result.body),value);
    value.complaint.summary='Synthetic subject narrative';
    assert.throws(()=>prepareComplaintRecoveryFacts(value));
    process.stdout.write(JSON.stringify(result));
  `], { cwd: fileURLToPath(new URL('../', import.meta.url)), input: JSON.stringify(value), encoding: 'utf8', timeout: 30000 });
  assert.equal(runner.status, 0, runner.stderr);
  const prepared = JSON.parse(runner.stdout);
  const hex = Buffer.from(prepared.body, 'utf8').toString('hex');
  const insert = (operation, actor = value.actorUserId, digest = prepared.digest) => `INSERT INTO "ComplaintRecoveryPreparation"
    (id,"organisationId","installationId","operationId","writerEpoch","authorizationId","actorUserId",facts,"factsDigest")
    VALUES ('${operation}','a','synthetic-install','${value.operationId}',1,'${authorizationId}','${actor}',
      convert_from(decode('${hex}','hex'),'UTF8'),'${digest}');`;
  sql(insert(`bad-${authorizationId}`, 'member-a'), /active charity Owner/);
  sql(insert(`digest-${authorizationId}`, value.actorUserId, '0'.repeat(64)), /digest mismatch/);
  sql(insert(`prepared-${authorizationId}`));
  sql(insert(`duplicate-${authorizationId}`), /unique constraint/);
  sql(`UPDATE "ComplaintRecoveryPreparation" SET "factsDigest"=repeat('0',64);`, /append-only/);
  sql(`DELETE FROM "ComplaintRecoveryPreparation";`, /append-only/);
  assert.equal(sql(`SELECT "factsDigest" FROM "ComplaintRecoveryPreparation" WHERE id='prepared-${authorizationId}';`), prepared.digest);
  assert.equal(sql(`SELECT count(*) FROM "ComplaintPurgeClaim" WHERE "authorizationId"='${authorizationId}';`), '0');
}
