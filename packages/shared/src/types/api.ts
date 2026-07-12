import type {
  OrganisationComplexity,
  LegalForm,
  CharitablePurpose,
  ComplianceStatus,
  ComplianceSignoffStatus,
  SubscriptionPlan,
  SubscriptionStatus,
  DocumentCategory,
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
  email: string;
  name: string;
  role: UserRole;
  emailVerified: boolean;
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
  active: boolean;
  current: boolean;
  revokedAt: string | null;
  revocationReason: AuthSessionRevocationReason | null;
}

export type SecurityAuditEventType =
  | 'MEMBER_SUSPENDED'
  | 'MEMBER_REACTIVATED'
  | 'MEMBER_REMOVED'
  | 'MEMBER_ROLE_CHANGED'
  | 'OWNERSHIP_TRANSFERRED'
  | 'OWNERSHIP_RECOVERED'
  | 'SESSION_REVOKED'
  | 'ALL_SESSIONS_REVOKED'
  | 'ORGANISATION_SUSPENDED'
  | 'ORGANISATION_REACTIVATED'
  | 'ORGANISATION_CLOSED'
  | 'INVITE_REVOKED'
  | 'PASSWORD_RESET_COMPLETED';

export interface SecurityAuditEventResponse {
  type: SecurityAuditEventType;
  actorLabel: string;
  subjectLabel: string;
  reason: string;
  occurredAt: string;
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

export interface BoardMemberResponse {
  id: string;
  organisationId: string;
  name: string;
  role: string;
  email: string | null;
  appointedDate: string;
  termEndDate: string | null;
  isActive: boolean;
  conductSigned: boolean;
  conductSignedDate: string | null;
  inductionCompleted: boolean;
  inductionDate: string | null;
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
}

// ── Documents ──

export interface DocumentResponse {
  id: string;
  organisationId: string;
  name: string;
  description: string | null;
  category: DocumentCategory;
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
