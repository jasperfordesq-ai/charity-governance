import test from 'node:test';
import assert from 'node:assert/strict';
import { validInstructionState, validSourceFollowup, type SourceInstructionState, type SourceFollowup } from './confluence-source-instructions';

function state(): SourceInstructionState {
  return { historicalReceipt: true, currentStateVerified: false, withdrawal: null, instruction: {
    id: 'instruction-1', clientRequestId: '00000000-0000-4000-8000-000000000321', inputDigest: 'a'.repeat(64),
    referenceId: 'citation-1', actorUserId: 'owner-1', recordedAt: '2026-10-20T00:00:00.000Z',
    kind: 'CONFLUENCE_SOURCE_INSTRUCTION_V1', authorityAssessment: 'OWNER_RECORDED',
    input: { expectedTargetDigest: 'b'.repeat(64), action: 'TRASH', authorityEvidenceRef: 'SYNTHETIC-AUTHORITY',
      retentionEvidenceRef: 'SYNTHETIC-RETENTION', administratorRef: 'SYNTHETIC-ADMIN', followUpAt: '2026-11-01T12:00:00.000Z',
      reason: 'Synthetic original assessment', evidenceRef: 'SYNTHETIC-DECISION' },
    citation: { id: 'citation-1', cloudId: 'site-1', pageId: 'page-1', pageVersion: 3, documentId: null },
    providerMutationIssued: false, jobCreated: false, actionAuthorized: false,
  } };
}
function report(): SourceFollowup {
  const original = state();
  return { id: 'followup-1', clientRequestId: '00000000-0000-4000-8000-000000000322', instructionId: original.instruction.id,
    instructionDigest: original.instruction.inputDigest, actorUserId: 'owner-1', recordedAt: '2026-10-20T00:05:00.000Z',
    kind: 'CONFLUENCE_SOURCE_FOLLOWUP_V1', instructionStateAtReport: 'RECORDED', instruction: original.instruction, withdrawal: null,
    input: { expectedInstructionDigest: original.instruction.inputDigest, expectedTargetDigest: original.instruction.input.expectedTargetDigest,
      controlPageId: 'control-1', actionReport: 'NOT_REPORTED', actionEvidenceRef: null, actionReportedAt: null,
      evidenceRef: 'SYNTHETIC-FOLLOWUP', reason: 'Synthetic independent page observation' },
    observation: { referenceId: 'citation-1', targetDigest: original.instruction.input.expectedTargetDigest,
      checkedAt: '2026-10-20T00:04:59.000Z', controlPageId: 'control-1', status: 'NOT_OBSERVED', scope: 'CITED_PAGE_ONLY',
      attachmentsObserved: false, permanentErasureVerified: false, allCopiesVerified: false, jobCreated: false, citationUpdated: false,
      providerMutationIssued: false, actionAuthorized: false },
    actionAuthorized: false, providerMutationIssued: false, jobCreated: false, historicalReceipt: true, currentStateVerified: false };
}
test('client receipts preserve unknown provider outcomes and both citation anchors', () => {
  const s = state(); assert.equal(validInstructionState(s), true);
  s.instruction.citation.documentId = 'document-1'; assert.equal(validInstructionState(s), true);
  const r = report(); assert.equal(validSourceFollowup(r), true);
  r.observation.status = 'UNKNOWN'; assert.equal(validSourceFollowup(r), true);
});
test('instruction receipts reject changed targets, claimed execution and mismatched withdrawal', () => {
  for (const flag of ['actionAuthorized', 'jobCreated', 'providerMutationIssued']) {
    const s = state(); Reflect.set(s.instruction, flag, true); assert.equal(validInstructionState(s), false);
  }
  const s = state(); s.instruction.citation.id = 'another-citation'; assert.equal(validInstructionState(s), false);
  const w = state(); w.withdrawal = { id: 'withdrawal-1', clientRequestId: 'request-2', instructionId: 'another-instruction',
    instructionDigest: w.instruction.inputDigest, actorUserId: 'owner-1', recordedAt: '2026-10-20T00:02:00.000Z',
    input: { evidenceRef: 'SYNTHETIC-WITHDRAWAL', reason: 'Synthetic withdrawal' }, actionAuthorized: false, jobCreated: false, providerMutationIssued: false };
  assert.equal(validInstructionState(w), false);
});
test('follow-up receipts refuse changed original/target/control and false erasure claims', () => {
  for (const flag of ['attachmentsObserved', 'permanentErasureVerified', 'allCopiesVerified', 'providerMutationIssued', 'actionAuthorized', 'jobCreated', 'citationUpdated']) {
    const r = report(); Reflect.set(r.observation, flag, true); assert.equal(validSourceFollowup(r), false);
  }
  const changed = report(); changed.instructionDigest = 'c'.repeat(64); assert.equal(validSourceFollowup(changed), false);
  const target = report(); target.observation.targetDigest = 'd'.repeat(64); assert.equal(validSourceFollowup(target), false);
  const control = report(); control.observation.controlPageId = 'different-control'; assert.equal(validSourceFollowup(control), false);
  const withdrawal = report(); withdrawal.instructionStateAtReport = 'WITHDRAWN'; assert.equal(validSourceFollowup(withdrawal), false);
});
test('malformed server receipts fail validation without throwing or becoming a successful save', () => {
  for (const value of [null, undefined, {}, { instruction: {} }, { historicalReceipt: true, currentStateVerified: false,
    instruction: { kind: 'CONFLUENCE_SOURCE_INSTRUCTION_V1' } }]) {
    assert.doesNotThrow(() => assert.equal(validInstructionState(value as unknown as SourceInstructionState), false));
  }
  for (const value of [null, undefined, {}, { kind: 'CONFLUENCE_SOURCE_FOLLOWUP_V1' }, { ...report(), observation: null }]) {
    assert.doesNotThrow(() => assert.equal(validSourceFollowup(value as unknown as SourceFollowup), false));
  }
});
