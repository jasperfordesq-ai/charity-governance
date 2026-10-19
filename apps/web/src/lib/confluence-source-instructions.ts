export type SourceInstruction = {
  id: string; clientRequestId: string; inputDigest: string; referenceId: string; actorUserId: string; recordedAt: string;
  kind: 'CONFLUENCE_SOURCE_INSTRUCTION_V1'; authorityAssessment: 'OWNER_RECORDED';
  input: { expectedTargetDigest: string; action: 'TRASH' | 'PURGE'; authorityEvidenceRef: string; retentionEvidenceRef: string;
    administratorRef: string; followUpAt: string; reason: string; evidenceRef: string };
  citation: { id: string; cloudId: string; pageId: string; pageVersion: number; documentId: string | null };
  providerMutationIssued: false; jobCreated: false; actionAuthorized: false;
};
export type SourceInstructionState = { instruction: SourceInstruction; withdrawal: null | {
  id: string; clientRequestId: string; instructionId: string; instructionDigest: string; actorUserId: string; recordedAt: string;
  input: { evidenceRef: string; reason: string }; actionAuthorized: false; providerMutationIssued: false; jobCreated: false;
}; historicalReceipt: true; currentStateVerified: false };
export type SourceFollowup = { id: string; clientRequestId: string; instructionId: string; instructionDigest: string;
  actorUserId: string; recordedAt: string; kind: 'CONFLUENCE_SOURCE_FOLLOWUP_V1'; instructionStateAtReport: 'RECORDED' | 'WITHDRAWN';
  instruction: SourceInstruction; withdrawal: SourceInstructionState['withdrawal'];
  input: { expectedTargetDigest: string; expectedInstructionDigest: string; controlPageId: string; actionReport: string;
    evidenceRef: string; reason: string; actionEvidenceRef: string | null; actionReportedAt: string | null };
  observation: { referenceId: string; targetDigest: string; checkedAt: string; controlPageId: string; status: string; scope: 'CITED_PAGE_ONLY';
    attachmentsObserved: false; permanentErasureVerified: false; allCopiesVerified: false; providerMutationIssued: false; actionAuthorized: false;
    jobCreated: false; citationUpdated: false };
  actionAuthorized: false; providerMutationIssued: false; jobCreated: false; historicalReceipt: true; currentStateVerified: false };

export const sourceIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const sha = /^[a-f0-9]{64}$/;
export const sourceEvidencePattern = /^[A-Z0-9][A-Z0-9-]{2,119}$/;
const isId = (value: unknown) => typeof value === 'string' && sourceIdentifierPattern.test(value);
const isDigest = (value: unknown) => typeof value === 'string' && sha.test(value);
export function validInstructionState(value: SourceInstructionState) {
  const i = value?.instruction, w = value?.withdrawal;
  return value?.historicalReceipt === true && value.currentStateVerified === false && i?.kind === 'CONFLUENCE_SOURCE_INSTRUCTION_V1'
    && isId(i.id) && isId(i.clientRequestId) && isId(i.actorUserId) && isDigest(i.inputDigest) && isId(i.referenceId) && i.referenceId === i.citation?.id
    && isId(i.citation.pageId) && typeof i.citation.cloudId === 'string' && Number.isSafeInteger(i.citation.pageVersion)
    && i.citation.pageVersion > 0 && (i.citation.documentId === null || isId(i.citation.documentId))
    && Number.isFinite(Date.parse(i.recordedAt)) && isDigest(i.input?.expectedTargetDigest)
    && ['TRASH', 'PURGE'].includes(i.input.action) && i.authorityAssessment === 'OWNER_RECORDED'
    && i.providerMutationIssued === false && i.jobCreated === false && i.actionAuthorized === false
    && [i.input.authorityEvidenceRef, i.input.retentionEvidenceRef, i.input.administratorRef, i.input.evidenceRef]
      .every(ref => typeof ref === 'string' && sourceEvidencePattern.test(ref))
    && typeof i.input.reason === 'string' && Number.isFinite(Date.parse(i.input.followUpAt))
    && (w === null || (!!w && isId(w.id) && isId(w.clientRequestId) && isId(w.actorUserId)
      && w.instructionId === i.id && w.instructionDigest === i.inputDigest
      && w.actionAuthorized === false && w.providerMutationIssued === false && w.jobCreated === false
      && !!w.input && typeof w.input.reason === 'string' && sourceEvidencePattern.test(w.input.evidenceRef)
      && Number.isFinite(Date.parse(w.recordedAt)) && Date.parse(w.recordedAt) >= Date.parse(i.recordedAt)));
}
export function validSourceFollowup(value: SourceFollowup) {
  if (!value || value.kind !== 'CONFLUENCE_SOURCE_FOLLOWUP_V1' || !isId(value.id) || !isId(value.clientRequestId)
    || !isId(value.actorUserId) || !isId(value.instructionId) || !isDigest(value.instructionDigest)
    || !validInstructionState({ instruction: value.instruction, withdrawal: value.withdrawal, historicalReceipt: true, currentStateVerified: false })) return false;
  return !!value.input && !!value.observation && isDigest(value.input.expectedTargetDigest)
    && isId(value.input.controlPageId) && typeof value.input.reason === 'string'
    && ['NOT_REPORTED', 'TRASH_REPORTED', 'PURGE_REPORTED'].includes(value.input.actionReport)
    && Number.isFinite(Date.parse(value.recordedAt)) && Number.isFinite(Date.parse(value.observation.checkedAt))
    && sourceEvidencePattern.test(value.input.evidenceRef)
    && value.instructionId === value.instruction?.id && value.instructionDigest === value.instruction.inputDigest
    && value.input?.expectedInstructionDigest === value.instructionDigest
    && value.input.expectedTargetDigest === value.instruction.input.expectedTargetDigest
    && value.observation?.targetDigest === value.input.expectedTargetDigest && value.observation.referenceId === value.instruction.referenceId
    && value.input.controlPageId === value.observation.controlPageId && value.observation.scope === 'CITED_PAGE_ONLY'
    && ['VISIBLE', 'TRASHED', 'NOT_OBSERVED', 'UNKNOWN'].includes(value.observation.status)
    && value.observation.attachmentsObserved === false && value.observation.permanentErasureVerified === false
    && value.observation.allCopiesVerified === false && value.observation.providerMutationIssued === false && value.observation.actionAuthorized === false
    && value.observation.jobCreated === false && value.observation.citationUpdated === false
    && value.actionAuthorized === false && value.providerMutationIssued === false && value.jobCreated === false
    && value.historicalReceipt === true && value.currentStateVerified === false
    && value.instructionStateAtReport === (value.withdrawal ? 'WITHDRAWN' : 'RECORDED');
}
