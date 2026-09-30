import type {
  OrganisationComplexity,
  LegalForm,
  CharitablePurpose,
  ComplianceStatus,
  ComplianceSignoffStatus,
  SubscriptionPlan,
  SubscriptionStatus,
  DocumentCategory,
  DocumentVisibility,
  DocumentContentAccessClass,
  DocumentLifecycleStatus,
  RegisterStatus,
  ConflictStatus,
  RiskCategory,
  AnnualReportFilingStatus,
  UserRole,
  UserLifecycleStatus,
  AuthSessionRevocationReason,
  DeadlineReminderStatus,
  DeadlineReminderReconciliationOutcome,
  GeneratedDeadlineKind,
  DeadlineSupersessionReason,
} from "./enums.js";
import type {
  ComplianceSourceRef,
  CommencementStatus,
  ProfessionalReviewFlag,
} from "../constants/irish-compliance-matrix.js";

// ── Generic API response ──

export interface ApiError {
  error: string;
  code: string;
  details?: unknown;
}

export interface PaginatedResponse<T> {
  data: T[];
  nextCursor?: string;
  hasMore: boolean;
  total?: number;
}

// ── Auth ──

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
  organisationName: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken?: string;
  refreshToken?: string;
}

export interface AuthResponse extends AuthTokens {
  user: UserResponse;
}

export interface RefreshRequest {
  refreshToken?: string;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  password: string;
}

export interface VerifyEmailRequest {
  token: string;
}

export interface AcceptTeamInviteRequest {
  token: string;
  name: string;
  password: string;
}

// ── User ──

export interface UserResponse {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  emailVerified: boolean;
  organisationId: string;
  organisation: OrganisationResponse;
}

// ── Team ──

export interface TeamMemberResponse {
  id: string;
  /** Null in the basic MEMBER team view. */
  email: string | null;
  name: string;
  role: UserRole;
  /** Null in the basic MEMBER team view. */
  emailVerified: boolean | null;
  lifecycleStatus: UserLifecycleStatus;
  membershipVersion: number;
  membershipChangedAt: string;
  /** Present only for OWNER/ADMIN team-list responses. */
  activeSessionCount?: number;
  createdAt: string;
}

export interface TeamSessionResponse {
  familyId: string;
  /** Non-reversible display discriminator; never a session or family identifier. */
  displaySuffix: string;
  familyCreatedAt: string;
  latestCreatedAt: string;
  expiresAt: string;
  deviceLabel: string | null;
  /** Which client the session belongs to. Web sessions are always ADMIN. */
  clientKind: 'WEB' | 'MCP_CONNECTOR';
  /** How much the session may do, chosen when the password was typed. */
  accessLevel: 'READ' | 'WRITE' | 'ADMIN';
  active: boolean;
  current: boolean;
  revokedAt: string | null;
  revocationReason: AuthSessionRevocationReason | null;
}

/**
 * Every value of the Prisma `SecurityAuditEventType` enum, and nothing else.
 *
 * This union is hand-written rather than inferred, so it drifts silently — and
 * it had, in both directions at once: three values the database could produce
 * were missing (`SESSION_REPLAY_DETECTED`,
 * `ORGANISATION_CONFIGURATION_CHANGED`, `INVITE_LINK_REISSUED`), so a client
 * narrowing on this type would fail to handle events it was actually sent; and
 * one value here (`PASSWORD_RESET_COMPLETED`) did not exist in the database at
 * all, so a `switch` could carry a branch that could never run.
 *
 * `security-audit-event-union.test.ts` now pins it against the Prisma schema in
 * both directions. Add a value here whenever you add one there, or that test
 * will say so.
 */
export type SecurityAuditEventType =
  | 'ACTION_APPROVAL_REFUSED'
  | 'SECOND_FACTOR_ENROLLED'
  | 'SECOND_FACTOR_REMOVED'
  | 'SECOND_FACTOR_RECOVERY_USED'
  | 'MEMBER_SUSPENDED'
  | 'MEMBER_REACTIVATED'
  | 'MEMBER_REMOVED'
  | 'MEMBER_ROLE_CHANGED'
  | 'OWNERSHIP_TRANSFERRED'
  | 'OWNERSHIP_RECOVERED'
  | 'SESSION_REVOKED'
  | 'ALL_SESSIONS_REVOKED'
  | 'SESSION_REPLAY_DETECTED'
  | 'ORGANISATION_SUSPENDED'
  | 'ORGANISATION_REACTIVATED'
  | 'ORGANISATION_CLOSED'
  | 'ORGANISATION_CONFIGURATION_CHANGED'
  | 'INVITE_REVOKED'
  | 'INVITE_LINK_REISSUED'
  | 'INTEGRATION_CONNECTED'
  | 'INTEGRATION_SITE_SELECTED'
  | 'INTEGRATION_DISCONNECTED'
  | 'INTEGRATION_PUBLISH_TARGET_CHANGED'
  | 'INTEGRATION_ENVIRONMENT_DECLARED'
  | 'INTEGRATION_REAUTHORISATION_REQUIRED'
  | 'DOCUMENT_PUBLICATION_DEAD_LETTERED'
  | 'CONFLUENCE_ERASURE_REQUESTED';

export interface SecurityAuditEventResponse {
  /** Password markers are trusted projections of stored ALL_SESSIONS_REVOKED rows. */
  type: SecurityAuditEventType | 'PASSWORD_RESET_COMPLETED' | 'PASSWORD_CHANGED';
  actorLabel: string;
  subjectLabel: string;
  reason: string;
  occurredAt: string;
}

export interface SecurityAuditPageResponse {
  data: SecurityAuditEventResponse[];
  nextCursor: string | null;
}

export interface SessionReplayDiagnosticResponse {
  eventId: string;
  occurredAt: string;
  familyFingerprint: string | null;
  /** Equal values identify repeated presentations of one spent session row. */
  presentedSessionFingerprint: string | null;
  /** Number of active rows quarantined by this observation, absent on old events. */
  newlyQuarantinedSessionCount: number | null;
  clientKind: 'WEB' | 'MCP_CONNECTOR' | null;
  accessLevel: 'READ' | 'WRITE' | 'ADMIN' | null;
  requestId: string | null;
  /** Allowlisted session revocation reason, absent on older events. */
  previousRevocationReason: string | null;
  /** When the presented session was previously revoked, absent on older events. */
  presentedSessionRevokedAt: string | null;
}

export interface SessionReplayDiagnosticsPageResponse {
  data: SessionReplayDiagnosticResponse[];
  nextCursor: string | null;
}

export interface PasswordRecoveryAcceptedResponse {
  message: string;
}

export interface PasswordResetResponse {
  message: string;
}

export interface TeamInviteResponse {
  id: string;
  email: string;
  role: UserRole;
  invitedByName: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface TeamResponse {
  members: TeamMemberResponse[];
  invites: TeamInviteResponse[];
}

export interface InviteTeamMemberRequest {
  email: string;
  role: UserRole.ADMIN | UserRole.MEMBER;
}

export interface UpdateTeamMemberRoleRequest {
  role: UserRole.ADMIN | UserRole.MEMBER;
  expectedMembershipVersion: number;
  reason: string;
}

export interface TeamMemberLifecycleActionRequest {
  expectedMembershipVersion: number;
  reason: string;
}

export interface TransferTeamOwnershipRequest {
  targetMemberId: string;
  expectedCurrentOwnerVersion: number;
  expectedTargetVersion: number;
  confirmation: 'TRANSFER OWNERSHIP';
  reason: string;
}

export interface RevokeTeamSessionRequest {
  expectedMembershipVersion: number;
  reason: string;
}

export interface DeadlineReminderLogResponse {
  id: string;
  deadlineId: string;
  deadlineTitle: string;
  deadlineDueDate: string;
  deadlineScheduleVersion: number;
  deadlineContextKind: 'RECORDED_AT_RESERVATION' | 'MIGRATION_TIME_CONTEXT';
  deadlineSnapshotKnown: boolean;
  deliveryTimingKnown: boolean;
  legacyDeliveryStatus: 'SENT' | 'FAILED' | 'SKIPPED' | null;
  legacyRecordedAt: string | null;
  email: string;
  reminderDays: number;
  status: DeadlineReminderStatus;
  error: string | null;
  reservedAt: string | null;
  attemptedAt: string | null;
  providerRequestStartedAt: string | null;
  reconciliationOutcome: DeadlineReminderReconciliationOutcome | null;
  reconciledAt: string | null;
  sentAt: string | null;
}

export interface DeadlineReminderHistoryResponse {
  data: DeadlineReminderLogResponse[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// ── Organisation ──

export interface OrganisationResponse {
  id: string;
  name: string;
  rcnNumber: string | null;
  croNumber: string | null;
  legalForm: LegalForm | null;
  legalFormConfirmedAt: string | null;
  complexity: OrganisationComplexity;
  charitablePurpose: CharitablePurpose[];
  financialYearEnd: string | null;
  registeredAddress: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  website: string | null;
  dateRegistered: string | null;
  incorporationDate: string | null;
  croAnnualReturnDate: string | null;
  croAnnualReturnDateConfirmedAt: string | null;
  lastActualAgmDate: string | null;
  lastUnanimousAnnualMemberResolutionDate: string | null;
  memberCount: number | null;
  constitutionPermitsWrittenResolutions: boolean | null;
  conditionalObligationProfile: ConditionalObligationProfile | null;
  updatedAt: string;
}

export interface UpdateOrganisationRequest {
  expectedUpdatedAt: string;
  name?: string;
  rcnNumber?: string | null;
  croNumber?: string | null;
  legalForm?: LegalForm | null;
  confirmLegalForm?: boolean;
  complexity?: OrganisationComplexity;
  charitablePurpose?: CharitablePurpose[];
  financialYearEnd?: string | null;
  registeredAddress?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  website?: string | null;
  dateRegistered?: string | null;
  incorporationDate?: string | null;
  croAnnualReturnDate?: string | null;
  confirmCroAnnualReturnDate?: boolean;
  lastActualAgmDate?: string | null;
  lastUnanimousAnnualMemberResolutionDate?: string | null;
  memberCount?: number | null;
  constitutionPermitsWrittenResolutions?: boolean | null;
  conditionalObligationProfile?: ConditionalObligationProfile | null;
}

export interface ConditionalObligationProfile {
  hasPaidStaff: boolean;
  hasVolunteers: boolean;
  raisesFundsFromPublic: boolean;
  worksWithChildrenOrVulnerableAdults: boolean;
  processesPersonalData: boolean;
  operatesPremisesOrEvents: boolean;
  isPublicSectorBody: boolean;
  usesDataProcessors: boolean;
}

// ── Governance ──

export interface GovernancePrincipleResponse {
  id: string;
  number: number;
  title: string;
  description: string;
  sortOrder: number;
  standards: GovernanceStandardResponse[];
}

export interface GovernanceStandardResponse {
  id: string;
  principleId: string;
  code: string;
  title: string;
  isCore: boolean;
  isAdditional: boolean;
  sortOrder: number;
}

// ── Compliance Records ──

export interface ComplianceRecordResponse {
  id: string | null;
  organisationId: string;
  standardId: string;
  standard: GovernanceStandardResponse;
  reportingYear: number;
  status: ComplianceStatus;
  actionTaken: string | null;
  evidence: string | null;
  notes: string | null;
  explanationIfNA: string | null;
  revision: number;
  updatedById: string | null;
  updatedAt: string | null;
}

export type ComplianceApprovalInvalidationReason =
  | "RECORD_CHANGED"
  | "MANUAL_STATUS_CHANGE"
  | "LEGACY_APPROVAL_UNBOUND";

export interface ComplianceApprovalSnapshotSummary {
  id: string;
  approvalSequence: number;
  evidenceHash: string;
  snapshotHash: string;
  approvedAt: string;
}

export interface ComplianceSignoffResponse {
  id: string | null;
  organisationId: string;
  reportingYear: number;
  status: ComplianceSignoffStatus;
  boardMeetingDate: string | null;
  minuteReference: string | null;
  approvedByName: string | null;
  approvedByRole: string | null;
  approvalNotes: string | null;
  approvedAt: string | null;
  revision: number;
  approvalSequence: number;
  approvalCurrent: boolean;
  currentApprovalSnapshotId: string | null;
  currentApproval: ComplianceApprovalSnapshotSummary | null;
  latestApproval: ComplianceApprovalSnapshotSummary | null;
  invalidatedAt: string | null;
  invalidationReason: ComplianceApprovalInvalidationReason | null;
  invalidatedById: string | null;
  updatedById: string | null;
  updatedAt: string | null;
}

export interface ComplianceApprovalMissingRecord {
  standardId: string;
  standardCode: string;
  status: "NOT_STARTED";
}

export interface ComplianceApprovalMissingEvidence {
  standardId: string;
  standardCode: string;
  status: "COMPLIANT" | "WORKING_TOWARDS";
  missingActionTaken: boolean;
  missingEvidence: boolean;
}

export interface ComplianceApprovalMissingExplanation {
  standardId: string;
  standardCode: string;
  status: "NOT_APPLICABLE" | "EXPLAIN";
}

export interface ComplianceApprovalProfileIssue {
  code: "CONDITIONAL_OBLIGATION_PROFILE_MISSING";
  message: string;
}

export interface ComplianceApprovalConditionalReviewItem {
  profileKey: keyof ConditionalObligationProfile;
  label: string;
  recommendedAction: string;
  standardCodes: string[];
  commencementStatuses: CommencementStatus[];
  professionalReview: ProfessionalReviewFlag[];
  sourceRefs: ComplianceSourceRef[];
  applicabilityNotes: string[];
}

export interface ComplianceApprovalMatrixReviewItem {
  standardCode: string;
  matrixEntryId: string;
  commencementStatus: CommencementStatus;
  boardApproval: "required" | "recommended" | "conditional" | "not_applicable";
  professionalReview: ProfessionalReviewFlag[];
  sourceRefs: ComplianceSourceRef[];
  applicabilityNote: string;
  evidenceRequired: string[];
}

export interface ComplianceApprovalReadinessResponse {
  ready: boolean;
  evidenceHash: string;
  missingRecords: ComplianceApprovalMissingRecord[];
  missingEvidence: ComplianceApprovalMissingEvidence[];
  missingExplanations: ComplianceApprovalMissingExplanation[];
  profileIssues: ComplianceApprovalProfileIssue[];
  conditionalReviewItems: ComplianceApprovalConditionalReviewItem[];
  matrixReviewItems: ComplianceApprovalMatrixReviewItem[];
  matrixLastChecked: string;
}

export interface UpsertComplianceRecordRequest {
  reportingYear: number;
  expectedRevision: number;
  status?: ComplianceStatus;
  actionTaken?: string | null;
  evidence?: string | null;
  notes?: string | null;
  explanationIfNA?: string | null;
}

export interface UpsertComplianceSignoffRequest {
  reportingYear: number;
  expectedRevision: number;
  expectedEvidenceHash?: string;
  status: ComplianceSignoffStatus;
  boardMeetingDate?: string | null;
  minuteReference?: string | null;
  approvedByName?: string | null;
  approvedByRole?: string | null;
  approvalNotes?: string | null;
}

export interface ComplianceEvidenceRecordSnapshot {
  id: string;
  revision: number;
  status:
    | "COMPLIANT"
    | "WORKING_TOWARDS"
    | "NOT_STARTED"
    | "NOT_APPLICABLE"
    | "EXPLAIN";
  actionTaken: string | null;
  evidence: string | null;
  notes: string | null;
  explanationIfNA: string | null;
  updatedById: string | null;
  updatedAt: string;
}

export interface ComplianceEvidenceStandardSnapshot {
  principle: {
    id: string;
    number: number;
    title: string;
    sortOrder: number;
  };
  standard: {
    id: string;
    code: string;
    title: string;
    isCore: boolean;
    isAdditional: boolean;
    sortOrder: number;
  };
  record: ComplianceEvidenceRecordSnapshot | null;
}

export interface ComplianceEvidenceSnapshotPayload {
  organisation: {
    id: string;
    name: string;
    rcnNumber: string | null;
  };
  reportingYear: number;
  scope: {
    complexity: "SIMPLE" | "COMPLEX";
    plan: "ESSENTIALS" | "COMPLETE";
    conditionalObligationProfile: ConditionalObligationProfile | null;
  };
  matrixLastChecked: string;
  standards: ComplianceEvidenceStandardSnapshot[];
  readiness: Omit<ComplianceApprovalReadinessResponse, "evidenceHash">;
}

export interface ComplianceApprovalSnapshotPayload {
  kind: "charitypilot.compliance-approval";
  formatVersion: 1;
  evidence: ComplianceEvidenceSnapshotPayload;
  approval: {
    sequence: number;
    boardMeetingDate: string;
    minuteReference: string;
    approvedByName: string;
    approvedByRole: string | null;
    approvalNotes: string | null;
    recordedById: string;
    recordedByName: string | null;
    approvedAt: string;
  };
}

export interface ComplianceSummary {
  reportingYear: number;
  totalApplicable: number;
  compliant: number;
  workingTowards: number;
  notStarted: number;
  notApplicable: number;
  explain: number;
  percentComplete: number;
  byPrinciple: PrincipleComplianceSummary[];
}

export interface PrincipleComplianceSummary {
  principleId: string;
  principleNumber: number;
  principleTitle: string;
  totalApplicable: number;
  compliant: number;
  percentComplete: number;
}

// ── Board Members ──

// Mirrors the prisma DirectorAppointmentKind enum. A literal union rather than a TS enum so
// the values parsed by `createBoardMemberSchema` / `updateBoardMemberSchema` stay assignable.
export type DirectorAppointmentKind = 'BOARD' | 'MEMBERS';

export interface BoardMemberResponse {
  id: string;
  organisationId: string;
  name: string;
  role: string;
  email?: string | null;
  appointedDate: string;
  termEndDate: string | null;
  isActive: boolean;
  conductSigned: boolean;
  conductSignedDate: string | null;
  inductionCompleted: boolean;
  inductionDate: string | null;
  dateOfBirth?: string | null;
  residentialAddress?: string | null;
  otherDirectorships?: string | null;
  formerNames?: string | null;
  appointmentKind?: DirectorAppointmentKind | null;
}

export interface CreateBoardMemberRequest {
  name: string;
  role: string;
  email?: string;
  appointedDate: string;
  termEndDate?: string;
  conductSigned?: boolean;
  conductSignedDate?: string;
  inductionCompleted?: boolean;
  inductionDate?: string;
  dateOfBirth?: string;
  residentialAddress?: string;
  otherDirectorships?: string;
  formerNames?: string;
  appointmentKind?: DirectorAppointmentKind;
}

export interface UpdateBoardMemberRequest {
  name?: string;
  role?: string;
  email?: string | null;
  appointedDate?: string;
  termEndDate?: string | null;
  isActive?: boolean;
  conductSigned?: boolean;
  conductSignedDate?: string | null;
  inductionCompleted?: boolean;
  inductionDate?: string | null;
  dateOfBirth?: string | null;
  residentialAddress?: string | null;
  otherDirectorships?: string | null;
  formerNames?: string | null;
  appointmentKind?: DirectorAppointmentKind | null;
}

// ── Documents ──

export interface DocumentResponse {
  id: string;
  organisationId: string;
  name: string;
  description: string | null;
  category: DocumentCategory;
  visibility: DocumentVisibility;
  /** Owner/Admin only. Existing files require a fresh content review. */
  contentAccessClass?: DocumentContentAccessClass;
  /** Owner/Admin only. A suitable assessment without this needs byte review again. */
  memberByteReviewVerified?: boolean;
  lifecycleStatus: DocumentLifecycleStatus;
  /** Owner/Admin only. The successor is a separate reviewed document. */
  supersededByDocumentId?: string | null;
  externalPublicationApproved: boolean;
  /** Owner/Admin only. Prevents the normal document delete pipeline. */
  deletionHold?: boolean;
  /** Owner/Admin only: whether the original byte provider has been verified. */
  storageProviderVerified?: boolean;
  fileSize: number;
  mimeType: string;
  version: number;
  owner: string | null;
  approvedDate: string | null;
  nextReviewDate: string | null;
  boardMinuteReference: string | null;
  uploadedById: string | null;
  standardLinks: { standardId: string; standardCode: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface UpdateDocumentRequest {
  name?: string;
  description?: string | null;
  // The enum's values rather than the enum itself, for the reason given above
  // DirectorAppointmentKind: a string parsed out of a request body is not
  // assignable to a TypeScript enum, so a route would have to cast the very
  // value its schema just validated.
  category?: `${DocumentCategory}`;
  visibility?: `${DocumentVisibility}`;
  visibilityReason?: string;
  contentAccessClass?: `${DocumentContentAccessClass}`;
  contentAccessReason?: string;
  lifecycleStatus?: `${DocumentLifecycleStatus}`;
  replacementDocumentId?: string;
  lifecycleReason?: string;
  externalPublicationApproved?: boolean;
  publicationApprovalReason?: string;
  reviewedPublicationSiteId?: string;
  reviewedPublicationSpaceId?: string;
  owner?: string | null;
  approvedDate?: string | null;
  nextReviewDate?: string | null;
  boardMinuteReference?: string | null;
}

export interface LinkStandardRequest {
  standardId: string;
}

// ── Governance Registers ──

export interface ConflictRecordResponse {
  id: string;
  organisationId: string;
  boardMemberId: string | null;
  trusteeName: string;
  matter: string;
  nature: string;
  dateDeclared: string;
  meetingDate: string | null;
  actionTaken: string;
  decision: string | null;
  status: ConflictStatus;
  minuteReference: string | null;
  nextReviewDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConflictRecordRequest {
  boardMemberId?: string | null;
  trusteeName: string;
  matter: string;
  nature: string;
  dateDeclared: string;
  meetingDate?: string | null;
  actionTaken: string;
  decision?: string | null;
  status?: ConflictStatus;
  minuteReference?: string | null;
  nextReviewDate?: string | null;
}

export type UpdateConflictRecordRequest = Partial<CreateConflictRecordRequest>;

export interface RiskRecordResponse {
  id: string;
  organisationId: string;
  title: string;
  category: RiskCategory;
  description: string;
  likelihood: number;
  impact: number;
  mitigation: string;
  owner: string | null;
  reviewDate: string | null;
  status: RegisterStatus;
  boardMinuteReference: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRiskRecordRequest {
  title: string;
  category: RiskCategory;
  description: string;
  likelihood: number;
  impact: number;
  mitigation: string;
  owner?: string | null;
  reviewDate?: string | null;
  status?: RegisterStatus;
  boardMinuteReference?: string | null;
}

export type UpdateRiskRecordRequest = Partial<CreateRiskRecordRequest>;

export interface ComplaintRecordResponse {
  id: string;
  organisationId: string;
  receivedDate: string;
  source: string | null;
  summary: string;
  actionTaken: string | null;
  outcome: string | null;
  status: RegisterStatus;
  reviewedByBoard: boolean;
  boardMinuteReference: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateComplaintRecordRequest {
  receivedDate: string;
  source?: string | null;
  summary: string;
  actionTaken?: string | null;
  outcome?: string | null;
  status?: RegisterStatus;
  reviewedByBoard?: boolean;
  boardMinuteReference?: string | null;
}

export type UpdateComplaintRecordRequest =
  Partial<CreateComplaintRecordRequest>;

export interface FundraisingRecordResponse {
  id: string;
  organisationId: string;
  name: string;
  activityType: string;
  startDate: string | null;
  endDate: string | null;
  publicFacing: boolean;
  thirdPartyFundraiser: string | null;
  controls: string | null;
  complaintsReceived: boolean;
  reviewOutcome: string | null;
  status: RegisterStatus;
  boardMinuteReference: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFundraisingRecordRequest {
  name: string;
  activityType: string;
  startDate?: string | null;
  endDate?: string | null;
  publicFacing?: boolean;
  thirdPartyFundraiser?: string | null;
  controls?: string | null;
  complaintsReceived?: boolean;
  reviewOutcome?: string | null;
  status?: RegisterStatus;
  boardMinuteReference?: string | null;
}

export type UpdateFundraisingRecordRequest =
  Partial<CreateFundraisingRecordRequest>;

export interface AnnualReportReadinessResponse {
  id: string | null;
  organisationId: string;
  reportingYear: number;
  activitiesNarrative: string | null;
  publicBenefitStatement: string | null;
  beneficiariesSummary: string | null;
  financialStatementsApproved: boolean;
  annualReportUploaded: boolean;
  trusteeDetailsReviewed: boolean;
  fundraisingReviewed: boolean;
  complaintsReviewed: boolean;
  boardApprovalDate: string | null;
  filingStatus: AnnualReportFilingStatus;
  filedDate: string | null;
  notes: string | null;
  updatedAt: string | null;
}

export interface UpsertAnnualReportReadinessRequest {
  reportingYear: number;
  activitiesNarrative?: string | null;
  publicBenefitStatement?: string | null;
  beneficiariesSummary?: string | null;
  financialStatementsApproved?: boolean;
  annualReportUploaded?: boolean;
  trusteeDetailsReviewed?: boolean;
  fundraisingReviewed?: boolean;
  complaintsReviewed?: boolean;
  boardApprovalDate?: string | null;
  filingStatus?: AnnualReportFilingStatus;
  filedDate?: string | null;
  notes?: string | null;
}

export interface FinancialControlReviewResponse {
  id: string | null;
  organisationId: string;
  reportingYear: number;
  bankReconciliationsReviewed: boolean;
  dualAuthorisation: boolean;
  budgetApproved: boolean;
  managementAccountsReviewed: boolean;
  reservesReviewed: boolean;
  restrictedFundsReviewed: boolean;
  assetsInsuranceReviewed: boolean;
  payrollControlsReviewed: boolean;
  fundraisingControlsReviewed: boolean;
  reviewedBy: string | null;
  reviewDate: string | null;
  minuteReference: string | null;
  actions: string | null;
  updatedAt: string | null;
}

export interface UpsertFinancialControlReviewRequest {
  reportingYear: number;
  bankReconciliationsReviewed?: boolean;
  dualAuthorisation?: boolean;
  budgetApproved?: boolean;
  managementAccountsReviewed?: boolean;
  reservesReviewed?: boolean;
  restrictedFundsReviewed?: boolean;
  assetsInsuranceReviewed?: boolean;
  payrollControlsReviewed?: boolean;
  fundraisingControlsReviewed?: boolean;
  reviewedBy?: string | null;
  reviewDate?: string | null;
  minuteReference?: string | null;
  actions?: string | null;
}

export interface GovernanceRegistersSummary {
  openConflicts: number;
  openRisks: number;
  openComplaints: number;
  activeFundraisingActivities: number;
  annualReportReadinessPercent: number;
  financialControlsPercent: number;
}

// ── Deadlines ──

export interface DeadlineResponse {
  id: string;
  organisationId: string;
  title: string;
  description: string | null;
  dueDate: string;
  isAutoGenerated: boolean;
  scheduleVersion: number;
  generatedKind: GeneratedDeadlineKind | null;
  generatedKey: string | null;
  generationVersion: number | null;
  generationRuleVersion: number | null;
  generationFingerprint: string | null;
  generationSource: Record<string, unknown> | null;
  generationInputs: Record<string, unknown> | null;
  profileRuleKey: keyof ConditionalObligationProfile | null;
  isComplete: boolean;
  completedDate: string | null;
  completionDateKnown: boolean;
  reminderDays: number[];
  supersededAt: string | null;
  supersededById: string | null;
  supersessionReason: DeadlineSupersessionReason | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeadlineHistoryResponse {
  data: DeadlineResponse[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface CreateDeadlineRequest {
  title: string;
  description?: string;
  dueDate: string;
  reminderDays?: number[];
  profileRuleKey?: keyof ConditionalObligationProfile;
}

export interface UpdateDeadlineRequest {
  expectedUpdatedAt: string;
  title?: string;
  description?: string | null;
  dueDate?: string;
  isComplete?: boolean;
  reminderDays?: number[];
}

export interface DeleteDeadlineRequest {
  expectedUpdatedAt: string;
}

// ── Billing ──

export interface CreateCheckoutRequest {
  plan: SubscriptionPlan;
  interval: "monthly" | "yearly";
}

export interface CheckoutResponse {
  url: string;
}

export interface PortalResponse {
  url: string;
}

export interface BillingStatusResponse {
  plan: SubscriptionPlan | null;
  status: SubscriptionStatus | null;
  stripeStatus: string | null;
  billingInterval: "monthly" | "yearly" | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  hasAccess: boolean;
  billingConfigured: boolean;
  canStartCheckout: boolean;
  canOpenPortal: boolean;
}

// ── Dashboard ──

export interface DashboardResponse {
  compliance: ComplianceSummary;
  upcomingDeadlines: DeadlineResponse[];
  boardAlerts: BoardAlert[];
  recentActivity: ActivityItem[];
}

export interface BoardAlert {
  boardMemberId: string;
  memberName: string;
  type: "term_expiring" | "conduct_unsigned" | "induction_pending";
  message: string;
}

export interface ActivityItem {
  id: string;
  type:
    | "compliance_update"
    | "document_upload"
    | "board_member_change"
    | "deadline_change";
  description: string;
  userId: string;
  userName: string;
  timestamp: string;
}
