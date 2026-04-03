import type {
  OrganisationComplexity,
  LegalForm,
  CharitablePurpose,
  ComplianceStatus,
  SubscriptionPlan,
  SubscriptionStatus,
  DocumentCategory,
  UserRole,
} from './enums.js';

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
  accessToken: string;
  refreshToken: string;
}

export interface AuthResponse extends AuthTokens {
  user: UserResponse;
}

export interface RefreshRequest {
  refreshToken: string;
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

// ── Organisation ──

export interface OrganisationResponse {
  id: string;
  name: string;
  rcnNumber: string | null;
  croNumber: string | null;
  legalForm: LegalForm;
  complexity: OrganisationComplexity;
  charitablePurpose: CharitablePurpose[];
  financialYearEnd: string | null;
  registeredAddress: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  website: string | null;
  dateRegistered: string | null;
  lastAgmDate: string | null;
}

export interface UpdateOrganisationRequest {
  name?: string;
  rcnNumber?: string | null;
  croNumber?: string | null;
  legalForm?: LegalForm;
  complexity?: OrganisationComplexity;
  charitablePurpose?: CharitablePurpose[];
  financialYearEnd?: string | null;
  registeredAddress?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  website?: string | null;
  dateRegistered?: string | null;
  lastAgmDate?: string | null;
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
  id: string;
  organisationId: string;
  standardId: string;
  standard: GovernanceStandardResponse;
  reportingYear: number;
  status: ComplianceStatus;
  actionTaken: string | null;
  evidence: string | null;
  notes: string | null;
  explanationIfNA: string | null;
  updatedById: string | null;
  updatedAt: string;
}

export interface UpsertComplianceRecordRequest {
  reportingYear: number;
  status?: ComplianceStatus;
  actionTaken?: string | null;
  evidence?: string | null;
  notes?: string | null;
  explanationIfNA?: string | null;
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
  fileUrl: string;
  fileSize: number;
  mimeType: string;
  version: number;
  uploadedById: string | null;
  standardLinks: { standardId: string; standardCode: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface LinkStandardRequest {
  standardId: string;
}

// ── Deadlines ──

export interface DeadlineResponse {
  id: string;
  organisationId: string;
  title: string;
  description: string | null;
  dueDate: string;
  isAutoGenerated: boolean;
  isComplete: boolean;
  completedDate: string | null;
  reminderDays: number[];
  createdAt: string;
}

export interface CreateDeadlineRequest {
  title: string;
  description?: string;
  dueDate: string;
  reminderDays?: number[];
}

export interface UpdateDeadlineRequest {
  title?: string;
  description?: string | null;
  dueDate?: string;
  isComplete?: boolean;
  reminderDays?: number[];
}

// ── Billing ──

export interface CreateCheckoutRequest {
  plan: SubscriptionPlan;
  interval: 'monthly' | 'yearly';
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
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  hasAccess: boolean;
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
  type: 'term_expiring' | 'conduct_unsigned' | 'induction_pending';
  message: string;
}

export interface ActivityItem {
  id: string;
  type: 'compliance_update' | 'document_upload' | 'board_member_change' | 'deadline_change';
  description: string;
  userId: string;
  userName: string;
  timestamp: string;
}
