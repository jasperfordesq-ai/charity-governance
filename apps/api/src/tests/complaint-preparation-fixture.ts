export function complaintPreparationFixture() {
  const organisationId = 'charity', stamp = '2026-09-01T00:00:00.000Z';
  const provenance = { actorUserId: 'owner', evidenceRef: 'EVIDENCE-1', reason: 'Synthetic reviewed reason' };
  const copy = { disposition: 'RETAIN_APPROVED', evidenceRef: 'COPY-1' };
  const value = { format: 1, action: 'COMPLAINT_PURGE_PREPARATION', installationId: 'install', organisationId,
    operationId: 'operation', writerEpoch: 1, actorUserId: 'owner', preparedAt: stamp, sourceRevision: 'a'.repeat(40),
    complaint: { id: 'complaint', organisationId, revision: 2, status: 'CLOSED', removedAt: stamp,
      removalId: 'removal', reviewedByBoard: false, boardMinuteReference: null },
    authorization: { id: 'authority', organisationId, complaintId: 'complaint', recordRevision: 2,
      holdRevision: 0, removalId: 'removal', policyId: 'policy', ...provenance, recoveryUntil: stamp,
      authorizedAt: stamp, dispositionPlan: { PRIMARY: { ...copy, disposition: 'DISPOSE' },
        SNAPSHOTS: copy, EXPORTS: copy, AUDIT: copy, BACKUPS: copy, OTHER_COPIES: copy } },
    policy: { id: 'policy', organisationId, recordClass: 'COMPLAINT', revision: 1, state: 'APPROVED',
      retentionMode: 'REVIEW_REQUIRED', retentionAnchor: null as string | null, retentionDays: null as number | null,
      recoveryDays: 1, createdById: 'owner', createdAt: stamp, approvedById: 'owner', approvedAt: stamp,
      approvalEvidenceRef: 'POLICY-1' },
    removal: { id: 'removal', organisationId, complaintId: 'complaint', recordRevision: 1,
      ...provenance, policyId: 'policy', resolutionEvidenceId: null as string | null, occurredAt: stamp, recoveryUntil: stamp },
    removalResolution: null as Record<string, unknown> | null, resolution: null as Record<string, unknown> | null, latestHold: null as Record<string, unknown> | null };
  return { ...value, removalPolicy: { ...value.policy } };
}
