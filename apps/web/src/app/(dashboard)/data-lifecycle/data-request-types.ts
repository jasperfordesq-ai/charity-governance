export type Kind = 'ERASURE' | 'RETENTION_REVIEW';
export type Scope = 'ACCOUNT' | 'GOVERNANCE' | 'DOCUMENT' | 'INTEGRATION' | 'ORGANISATION' | 'OTHER';
export type ReviewState = 'OPEN' | 'ASSESSING' | 'DECISION_REQUIRED';
export type RequestRecord = {
  id: string; caseReference: string; kind: Kind; scope: Scope;
  receivedAt: string; targetResponseAt: string | null; responseSentAt: string | null;
  reviewState: ReviewState; updatedAt: string;
};
export type ReviewEvent = {
  id: string; previousState: ReviewState | null; nextState: ReviewState;
  reason: string; evidenceRef: string | null; actorUserId: string; occurredAt: string;
};
export type PageResult = { items: RequestRecord[]; nextCursor: string | null };
export type EventPageResult = { items: ReviewEvent[]; nextCursor: string | null };
export type TargetEvent = {
  id: string; previousTargetAt: string | null; nextTargetAt: string | null;
  reason: string; evidenceRef: string | null; actorUserId: string; occurredAt: string;
};
export type TargetEventPage = { items: TargetEvent[]; nextCursor: string | null };
export type ResponseEvent = {
  id: string; previousResponseAt: string | null; nextResponseAt: string | null;
  reason: string; evidenceRef: string | null; actorUserId: string; occurredAt: string;
};
export type ResponseEventPage = { items: ResponseEvent[]; nextCursor: string | null };
export type StorageLink = {
  id: string; deletionId: string; actorUserId: string; reason: string; createdAt: string;
  withdrawal: { actorUserId: string; reason: string; createdAt: string } | null;
  deletion: { sourceDocumentId: string | null; provider: string; state: string; attempts: number; processedAt: string | null;
    activeObjectAbsentAt: string | null; terminalReason: string | null };
};
export type StorageLinkPage = { items: StorageLink[]; nextCursor: string | null };
export type DocumentLink = {
  id: string; documentId: string; actorUserId: string; reason: string; createdAt: string;
  withdrawal: { actorUserId: string; reason: string; createdAt: string } | null;
};
export type DocumentLinkPage = { items: DocumentLink[]; nextCursor: string | null };
export type SourceJob = {
  id: string; sourceDocumentId: string; provider: string; state: string;
  attempts: number; processedAt: string | null; activeObjectAbsentAt: string | null;
  terminalReason: string | null; createdAt: string;
};
export type SourceJobPage = { items: SourceJob[]; nextCursor: string | null };

export const stateLabels: Record<ReviewState, string> = {
  OPEN: 'Open', ASSESSING: 'Under review', DECISION_REQUIRED: 'Decision required',
};
export const fieldClass = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-950 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-50';

