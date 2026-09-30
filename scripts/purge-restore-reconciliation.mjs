import { createHash } from 'node:crypto';

// Callers must independently authenticate the
// current authority source and isolated restored target. Never obtain both
// sides from one old backup or interpret this result as permission to reopen.
const tables = [
  'DataRetentionPolicyRevision', 'DataRetentionPolicyWithdrawal',
  'DocumentPurgeAuthorization', 'DocumentPurgeAuthorizationWithdrawal',
  'DocumentPurgeClaim', 'DocumentPurgeDispositionEvent',
  'ComplaintResolutionEvidence', 'ComplaintRemoval', 'ComplaintHoldEvent',
  'ComplaintPurgeAuthorization', 'ComplaintPurgeAuthorizationWithdrawal',
  'ComplaintPurgeClaim',
  'ComplaintRecoveryPreparation',
  'ComplaintRecoveryOutcome',
  'ComplaintRecoveryEnforcement', 'ComplaintRecoveryExecution',
  'ComplaintHoldRecoveryPreparation',
  'ComplaintPurgeDispositionEvent',
  'DocumentCopyDispositionAuthority', 'ComplaintCopyDispositionAuthority',
  'DocumentCopyHoldEvent', 'ComplaintCopyHoldEvent',
];
const digest = expression => `encode(sha256(convert_to((${expression})::text,'UTF8')),'hex')`;
const entries = tables.map(name => `SELECT '${name}' AS name, COALESCE(jsonb_agg(jsonb_build_object('id',t.id,'sha256',${digest('to_jsonb(t)')}) ORDER BY t.id),'[]'::jsonb) AS rows FROM "${name}" t`);
entries.push(`SELECT 'ClaimedPrimaryJobs' AS name, COALESCE(jsonb_agg(jsonb_build_object('id',t.id,'sha256',${digest('to_jsonb(t)')}) ORDER BY t.id),'[]'::jsonb) AS rows
 FROM "DocumentStorageDeletion" t JOIN "DocumentPurgeClaim" c ON c."deletionId"=t.id AND c."organisationId"=t."organisationId"`);
// Recovery pointers are mutable; matching append-only decisions alone would
// miss an older backup restoring a removed complaint to ordinary active views.
entries.push(`SELECT 'ComplaintRecoveryState' AS name, COALESCE(jsonb_agg(jsonb_build_object('id',t.id,'sha256',${digest(`jsonb_build_object('id',t.id,'organisationId',t."organisationId",'revision',t.revision,'removedAt',t."removedAt",'removalId',t."removalId")`)}) ORDER BY t.id),'[]'::jsonb) AS rows FROM "ComplaintRecord" t`);
// Surviving documents can have newer holds, removal/recovery state, reviewed
// bytes or access restrictions without a purge claim. Compare full row hashes
// so restoration cannot silently rewind those controls. No document content,
// storage path or evidence reference leaves the database in this inventory.
entries.push(`SELECT 'DocumentRecoveryState' AS name, COALESCE(jsonb_agg(jsonb_build_object('id',t.id,'sha256',${digest('to_jsonb(t)')}) ORDER BY t.id),'[]'::jsonb) AS rows FROM "Document" t`);
entries.push(`SELECT 'ComplaintPrimaryConflicts' AS name, COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'sha256',${digest('to_jsonb(c)')}) ORDER BY c.id),'[]'::jsonb) AS rows
 FROM "ComplaintPurgeClaim" c JOIN "ComplaintRecord" r ON r.id=c."complaintId" AND r."organisationId"=c."organisationId"`);
export const PURGE_RESTORE_TABLES = Object.freeze([...tables, 'ClaimedPrimaryJobs', 'ComplaintRecoveryState', 'DocumentRecoveryState', 'ComplaintPrimaryConflicts']);
// Object keys are hashed in PostgreSQL so raw storage paths are not returned.
// Any claimed local object still present requires quarantine/reconciliation,
// including a pending deletion; byte changes at the same key do not excuse it.
export const PURGE_RESTORE_LOCAL_OBJECTS_SQL = `SELECT COALESCE(jsonb_agg(DISTINCT ${digest('t."storagePath"')}),'[]'::jsonb)
 FROM "DocumentStorageDeletion" t JOIN "DocumentPurgeClaim" c
 ON c."deletionId"=t.id AND c."organisationId"=t."organisationId" WHERE t.provider='local';`;

export function assertNoClaimedLocalObjects(pathHashes, restoredEntries) {
  if (!Array.isArray(pathHashes) || pathHashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) ||
    new Set(pathHashes).size !== pathHashes.length || !Array.isArray(restoredEntries)) {
    throw new Error('Invalid purge restore local-object inventory');
  }
  const claimed = new Set(pathHashes);
  const seen = new Set();
  let conflicts = 0;
  for (const entry of restoredEntries) {
    const path = entry?.path;
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') ||
      path.split('/').some(part => !part || part === '.' || part === '..') || /[\u0000-\u001f\u007f]/.test(path) || seen.has(path)) {
      throw new Error('Invalid purge restore local-object path');
    }
    seen.add(path);
    if (claimed.has(createHash('sha256').update(path, 'utf8').digest('hex'))) conflicts++;
  }
  if (conflicts) {
    const error = new Error('Restored archive contains claimed local objects; keep restored files quarantined.');
    error.code = 'PURGE_RESTORE_LOCAL_OBJECTS_PRESENT';
    error.conflicts = conflicts;
    throw error;
  }
  return { checkedLocalObjects: restoredEntries.length, claimedLocalKeys: claimed.size,
    claimedLocalObjectsPresent: 0, externalCopyReconciliationRequired: true };
}
// One statement uses one MVCC snapshot. Hashes cover entire records, including
// authority, policy, object fingerprint, outcome and deadlines. Raw paths,
// reasons and evidence content never leave PostgreSQL in this result.
export const PURGE_RESTORE_SNAPSHOT_SQL = `SELECT jsonb_build_object(
 'format',1,
 'capturedAt',to_char(timezone('UTC',statement_timestamp()),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'tables',(SELECT jsonb_object_agg(name,rows) FROM (${entries.join(' UNION ALL ')}) inventories),
 'claims',COALESCE((SELECT jsonb_agg(jsonb_build_object('organisationId',"organisationId",'documentId',"documentId") ORDER BY "organisationId","documentId") FROM "DocumentPurgeClaim"),'[]'::jsonb),
 'documents',COALESCE((SELECT jsonb_agg(jsonb_build_object('organisationId',"organisationId",'documentId',id) ORDER BY "organisationId",id) FROM "Document"),'[]'::jsonb)
) AS snapshot;`;

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new Error(`Invalid purge restore ${label}`);
}
function references(rows, label) {
  if (!Array.isArray(rows) || rows.length > 1_000_000) throw new Error(`Invalid purge restore ${label}`);
  const values = new Set();
  for (const row of rows) {
    exact(row, ['organisationId','documentId'], label);
    for (const value of [row.organisationId, row.documentId]) {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error(`Invalid purge restore ${label} identity`);
    }
    const key = JSON.stringify([row.organisationId,row.documentId]);
    if (values.has(key)) throw new Error(`Duplicate purge restore ${label} identity`);
    values.add(key);
  }
  return values;
}
function validate(snapshot) {
  exact(snapshot, ['format','capturedAt','tables','claims','documents'], 'snapshot');
  if (snapshot.format !== 1 || typeof snapshot.capturedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snapshot.capturedAt) ||
    !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
    new Date(snapshot.capturedAt).toISOString() !== snapshot.capturedAt) throw new Error('Invalid purge restore format or time');
  exact(snapshot.tables, PURGE_RESTORE_TABLES, 'table inventory');
  const inventories = new Map();
  for (const table of PURGE_RESTORE_TABLES) {
    const rows = snapshot.tables[table];
    if (!Array.isArray(rows) || rows.length > 1_000_000) throw new Error('Invalid purge restore row inventory');
    const inventory = new Map();
    for (const row of rows) {
      exact(row, ['id','sha256'], 'row');
      if (typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(row.id) ||
        typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256) || inventory.has(row.id)) throw new Error('Invalid or duplicate purge restore row');
      inventory.set(row.id,row.sha256);
    }
    inventories.set(table,inventory);
  }
  const claims = references(snapshot.claims, 'claims');
  if (inventories.get('ComplaintPrimaryConflicts').size) {
    const error = new Error('Claimed complaint primary records are present; keep application access closed.');
    error.code = 'PURGE_RESTORE_RECONCILIATION_REQUIRED';
    throw error;
  }
  if (claims.size !== inventories.get('DocumentPurgeClaim').size || claims.size !== inventories.get('ClaimedPrimaryJobs').size) {
    throw new Error('Incomplete purge restore claim/job lineage');
  }
  return { inventories, claims, documents: references(snapshot.documents, 'documents') };
}

export function reconcilePurgeRestore(authority, restored) {
  const source = validate(authority); const target = validate(restored);
  const differences = [];
  for (const table of PURGE_RESTORE_TABLES) {
    const expected = source.inventories.get(table); const actual = target.inventories.get(table);
    let missing = 0; let changed = 0; let unexpected = 0;
    for (const [id, hash] of expected) {
      if (!actual.has(id)) missing++; else if (actual.get(id) !== hash) changed++;
    }
    for (const id of actual.keys()) if (!expected.has(id)) unexpected++;
    if (missing || changed || unexpected) differences.push({ table, missing, changed, unexpected });
  }
  let resurrectedDocuments = 0; let sourceConflicts = 0; let claimScopeDifferences = 0;
  for (const key of source.claims) {
    if (target.documents.has(key)) resurrectedDocuments++;
    if (source.documents.has(key)) sourceConflicts++;
    if (!target.claims.has(key)) claimScopeDifferences++;
  }
  for (const key of target.claims) if (!source.claims.has(key)) claimScopeDifferences++;
  return {
    databaseLedgerMatches: differences.length === 0 && !resurrectedDocuments && !sourceConflicts && !claimScopeDifferences,
    authorityCapturedAt: authority.capturedAt, restoredCapturedAt: restored.capturedAt,
    differences, resurrectedDocuments, sourceConflicts, claimScopeDifferences,
    objectAndExternalCopyReconciliationRequired: true,
    // This primitive supplies no launch token or approval. A recovery controller
    // must keep access closed, replay separately authorized instructions and
    // recapture against a fresh source before checking objects and opening.
  };
}

export function assertPurgeRestoreLedger(authority, restored) {
  const result = reconcilePurgeRestore(authority, restored);
  if (!result.databaseLedgerMatches) {
    const error = new Error('Restored purge history differs from current authority; keep application access closed.');
    error.code = 'PURGE_RESTORE_RECONCILIATION_REQUIRED';
    error.report = result;
    throw error;
  }
  return result;
}
