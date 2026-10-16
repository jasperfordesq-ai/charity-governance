import { ledgerFixture } from './confluence-copy-ledger.js';
import { recoveryContextFixture as context } from './confluence-copy-recovery-facts.js';
export function executionLedgerFixture() {
  const original=ledgerFixture();
  const tables: Record<string,Array<Record<string,unknown>>>={...original.raw.tables};
  tables.ConfluenceCopyExecutionClaim=[{id:'claim-a',organisationId:'org-a',permissionId:'permission-a',operationId:'consume-a',
    actorUserId:'owner-a',snapshotSha256:tables.ConfluenceRetainedCopyPermission![0]!.snapshotSha256,evidenceRef:'SYNTHETIC-CLAIM',
    reason:'Synthetic local consumption only',phase:'QUARANTINED',providerIOAuthorised:false,claimedAt:'2026-10-15T18:03:00.000Z'}];
  tables.ConfluenceCopyExecutionRequest=[{id:'request-a',organisationId:'org-a',claimId:'claim-a',requestKey:'request-key-a',
    actorUserId:'owner-a',action:'TRASH',evidenceRef:'SYNTHETIC-REQUEST',reason:'Synthetic prepared request only',phase:'QUARANTINED',
    providerIOAuthorised:false,preparedAt:'2026-10-15T18:04:00.000Z'}];
  tables.ConfluenceCopyExecutionOutcome=[{id:'outcome-a',organisationId:'org-a',requestId:'request-a',requestOutcome:'UNRESOLVED',
    reportingBasis:'APPLICATION_REPORT',automaticRetryAllowed:false,providerAbsenceVerified:false,allCopiesVerified:false,
    providerIOAuthorised:false,reportedAt:'2026-10-15T18:07:00.000Z',recordedByDatabaseRole:'cp_runtime'}];
  return {...original.raw,format:2,kind:'CONFLUENCE_EXECUTION_LEDGER_V2',writerEpoch:context.writerEpoch,
    captureOperationId:context.operationId,tables};
}
