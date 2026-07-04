import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Concern: plan gating / tenant isolation / state integrity (UI). These guarantees are
// "page X correctly APPLIES already-unit-tested logic Y" (plan-feature detection, trusted
// outbound-URL allow-listing, double-submit guards). The logic itself is proven by its own
// unit test; this source-scan proves the page is wired to it, and fails the moment a page
// stops applying the guard. CJS-safe (reads source; loads no ESM/React modules).

const WEB = process.cwd(); // apps/web
const dashPath = (p: string) => join(WEB, 'src', 'app', '(dashboard)', p);
const dash = (p: string) => readFileSync(dashPath(p), 'utf8');
const optionalDash = (p: string) => (existsSync(dashPath(p)) ? readFileSync(dashPath(p), 'utf8') : '');
const app = (p: string) => readFileSync(join(WEB, 'src', 'app', p), 'utf8');
const component = (p: string) => readFileSync(join(WEB, 'src', 'components', p), 'utf8');

test('dashboard applies the plan-feature + subscription-lapse helpers (gracefully gates, never errors)', () => {
  const src = dash('dashboard/page.tsx');
  assert.match(src, /from '@\/lib\/plan-feature'/);
  assert.ok(src.includes('isPlanFeatureUnavailable'), 'hides the registers card on a plan denial');
  assert.ok(src.includes('isSubscriptionLapseError'), 'shows the subscription-lapse banner');
});

test('registers gates the whole page behind a Complete upsell on a plan-feature denial', () => {
  const src = [
    dash('registers/page.tsx'),
    optionalDash('registers/use-registers-workflow.ts'),
  ].join('\n');
  assert.match(src, /from '@\/lib\/plan-feature'/);
  assert.ok(src.includes('isPlanFeatureUnavailable'));
  // The upsell card links to billing rather than rendering a broken error.
  assert.match(src, /href="\/billing"/);
});

test('documents routes every download URL through the trusted-download allow-list', () => {
  const src = dash('documents/page.tsx');
  assert.match(src, /from '@\/lib\/url-security'/);
  assert.ok(src.includes('getTrustedDocumentDownloadUrl'));
});

test('billing routes Stripe redirects through the trusted-redirect allow-list', () => {
  const src = dash('billing/page.tsx');
  assert.match(src, /from '@\/lib\/url-security'/);
  assert.ok(src.includes('getTrustedStripeRedirectUrl'));
});

test('team surfaces the server\'s specific error message (apiErrorMessage), not a generic string', () => {
  const src = dash('team/page.tsx');
  assert.match(src, /from '@\/lib\/errors'/);
  assert.ok(src.includes('apiErrorMessage'));
});

// State integrity: each critical create/edit form guards against double-submit with an
// isLoading flag (and, where there is a required field, an isDisabled guard).
const DOUBLE_SUBMIT_GUARDED = [
  'board/page.tsx',
  'documents/page.tsx',
  'deadlines/page.tsx',
  'organisation/page.tsx',
  'export/page.tsx',
];
const DOUBLE_SUBMIT_EXTRA_FILES: Record<string, string[]> = {
  'documents/page.tsx': [
    'documents/document-upload-modal.tsx',
    'documents/document-list-panel.tsx',
    'documents/document-link-modal.tsx',
    'documents/document-delete-modal.tsx',
  ],
  'organisation/page.tsx': [
    'organisation/organisation-profile-form.tsx',
  ],
};
for (const file of DOUBLE_SUBMIT_GUARDED) {
  test(`${file} guards its primary mutation against double-submit (isLoading)`, () => {
    const src = [
      dash(file),
      ...(DOUBLE_SUBMIT_EXTRA_FILES[file] ?? []).map((extraFile) => optionalDash(extraFile)),
    ].join('\n');
    assert.match(src, /isLoading=\{/, `${file} must have an isLoading-guarded submit button`);
  });
}

test('documents blocks an oversize upload inline before any request (no wasted 4xx round-trip)', () => {
  const src = [
    dash('documents/page.tsx'),
    optionalDash('documents/document-upload-modal.tsx'),
  ].join('\n');
  assert.match(src, /MAX_FILE_SIZE/);
});

test('organisation warns before discarding unsaved edits (no silent data loss)', () => {
  const src = dash('organisation/page.tsx');
  assert.match(src, /beforeunload/);
});

test('organisation captures conditional obligation facts for review-ready workflows', () => {
  const src = [
    dash('organisation/page.tsx'),
    optionalDash('organisation/organisation-profile-form.tsx'),
    optionalDash('organisation/organisation-conditional-profile.tsx'),
  ].join('\n');
  for (const term of [
    'conditionalObligationProfile',
    'Conditional obligation triggers',
    'hasPaidStaff',
    'raisesFundsFromPublic',
    'worksWithChildrenOrVulnerableAdults',
    'processesPersonalData',
    'usesDataProcessors',
    'professional review',
  ]) {
    assert.match(src, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `organisation page must include ${term}`);
  }
});

test('organisation conditional obligation UX is extracted from the oversized route file', () => {
  const pageSrc = dash('organisation/page.tsx');
  const formPath = dashPath('organisation/organisation-profile-form.tsx');
  assert.ok(existsSync(formPath), 'organisation profile form should own conditional profile rendering');
  const formSrc = readFileSync(formPath, 'utf8');
  const profilePath = dashPath('organisation/organisation-conditional-profile.tsx');
  assert.ok(existsSync(profilePath), 'organisation conditional profile UI should be split out of page.tsx');
  const profileSrc = readFileSync(profilePath, 'utf8');

  assert.doesNotMatch(pageSrc, /OrganisationConditionalProfileFields/);
  assert.match(formSrc, /OrganisationConditionalProfileFields/);
  assert.match(pageSrc, /normaliseConditionalObligationProfile/);
  assert.doesNotMatch(pageSrc, /CONDITIONAL_OBLIGATION_FIELDS/);
  assert.match(profileSrc, /CONDITIONAL_OBLIGATION_FIELDS/);
  assert.match(profileSrc, /Professional review/);
  assert.match(profileSrc, /usesDataProcessors/);
});

test('organisation profile form is extracted from the oversized route file', () => {
  const pageSrc = dash('organisation/page.tsx');
  const formPath = dashPath('organisation/organisation-profile-form.tsx');
  assert.ok(existsSync(formPath), 'organisation profile form should be split out of page.tsx');
  const formSrc = readFileSync(formPath, 'utf8');

  assert.match(pageSrc, /OrganisationProfileForm/);
  assert.doesNotMatch(pageSrc, /Legal identity/);
  assert.doesNotMatch(pageSrc, /Choose at least one purpose/);
  assert.doesNotMatch(pageSrc, /financial-year-hint/);
  assert.doesNotMatch(pageSrc, /Save profile/);
  assert.match(formSrc, /Legal identity/);
  assert.match(formSrc, /Choose at least one purpose/);
  assert.match(formSrc, /financial-year-hint/);
  assert.match(formSrc, /Save profile/);
});

// Graceful degradation: error/empty states exist in the source (a clean state on failure,
// never a blank screen / infinite spinner / unhandled exception).
test('the global and dashboard error boundaries render a recoverable screen', () => {
  for (const file of ['error.tsx', '(dashboard)/error.tsx']) {
    const src = app(file);
    assert.match(src, /reset/, `${file} must offer a recover action`);
    assert.match(src, /Something went wrong/i, `${file} must render a clean error message`);
  }
});

test('the dashboard renders an explicit error card on a load failure (not a blank/empty screen)', () => {
  const src = dash('dashboard/page.tsx');
  assert.match(src, /role="alert"/);
  assert.match(src, /Failed to load dashboard data/i);
});

test('dashboard action lists are extracted from the oversized route file', () => {
  const pageSrc = dash('dashboard/page.tsx');
  const actionListsPath = dashPath('dashboard/dashboard-action-lists.tsx');
  assert.ok(existsSync(actionListsPath), 'dashboard deadlines and board-alert lists should be split out of page.tsx');
  const actionListsSrc = readFileSync(actionListsPath, 'utf8');

  assert.match(pageSrc, /DashboardActionLists/);
  assert.doesNotMatch(pageSrc, /SkeletonList/);
  assert.match(actionListsSrc, /SkeletonList/);
  assert.match(actionListsSrc, /Upcoming Deadlines/);
  assert.match(actionListsSrc, /Board Alerts/);
  assert.match(actionListsSrc, /View all deadlines/);
  assert.match(actionListsSrc, /View board register/);
});

test('the per-standard compliance editor announces its save state (Saving / Saved / Save failed)', () => {
  const src = [
    dash('compliance/[principleId]/page.tsx'),
    optionalDash('compliance/[principleId]/standard-editor-card.tsx'),
  ].join('\n');
  assert.match(src, /aria-live/);
  assert.match(src, /Save failed/i);
});

test('phase 6A workflows surface approval-readiness and evidence-led review guidance', () => {
  const dashboard = dash('dashboard/page.tsx');
  assert.match(dashboard, /approval-readiness\?year=\$\{currentYear\}/);
  assert.match(dashboard, /AppPage/);
  assert.match(dashboard, /AppSection/);
  assert.match(dashboard, /missingExplanations/);

  const compliance = dash('compliance/page.tsx');
  assert.match(compliance, /approval-readiness\?year=\$\{year\}/);
  assert.match(compliance, /EvidenceReadiness/);
  assert.match(compliance, /IRISH_COMPLIANCE_MATRIX/);
  assert.match(compliance, /review-ready/i);

  const principleDetail = dash('compliance/[principleId]/page.tsx');
  assert.match(principleDetail, /EvidenceReadiness/);
  assert.match(principleDetail, /getMatrixEntriesForStandard/);
  assert.match(principleDetail, /legal advice/i);

  const exportPage = dash('export/page.tsx');
  assert.match(exportPage, /approval-readiness\?year=\$\{year\}/);
  assert.match(exportPage, /missingExplanations/);
  assert.match(exportPage, /missingRecords/);
  assert.match(exportPage, /missingEvidence/);
  assert.match(exportPage, /profileIssues/);
  assert.match(exportPage, /conditionalReviewItems/);
  assert.match(exportPage, /COMPLIANCE_APPROVAL_INCOMPLETE/);
  assert.match(exportPage, /fetchApprovalReadiness/);
  assert.match(exportPage, /freshApprovalReadiness/);
  assert.match(exportPage, /freshApprovalReadiness\?\.ready === false/);
  assert.doesNotMatch(exportPage, /freshApprovalReadiness\?\.missingExplanations/);
  assert.doesNotMatch(
    exportPage,
    /const missingExplanations = approvalReadiness\?\.missingExplanations \?\? \[\];[\s\S]*?setSignoffError\(approvalIncompleteMessage\);[\s\S]*?return;[\s\S]*?setSavingSignoff\(true\);/,
  );
  assert.match(exportPage, /review-ready/i);
  assert.match(exportPage, /legal advice/i);
});

test('principle detail refreshes approval-readiness after successful autosave', () => {
  const src = dash('compliance/[principleId]/page.tsx');
  assert.match(src, /refreshApprovalReadiness/);
  assert.match(src, /readinessRequestSeq/);
  assert.match(src, /const requestSeq = \+\+readinessRequestSeq\.current/);
  assert.match(src, /if \(requestSeq === readinessRequestSeq\.current\) \{[\s\S]*?setApprovalReadiness\(readinessRes\.data\);[\s\S]*?\}/);
  assert.match(src, /if \(requestSeq === readinessRequestSeq\.current\) \{[\s\S]*?setApprovalReadiness\(null\);[\s\S]*?\}/);
  assert.match(
    src,
    /await api\.put\(`\/compliance\/records\/\$\{standardId\}`[\s\S]*?await refreshApprovalReadiness\(\);[\s\S]*?setSaveState\(\(prev\) => \(\{ \.\.\.prev, \[standardId\]: 'saved' \}\)\);/,
  );
});

test('principle detail confirms in-app navigation while saves are pending', () => {
  const src = dash('compliance/[principleId]/page.tsx');
  for (const term of [
    'hasPendingComplianceSaves',
    'confirmComplianceNavigation',
    'handleInAppNavigationClick',
    "closest('a[href]')",
    "window.confirm('CharityPilot is still saving compliance edits. Leave this page only if you are happy to rely on the last saved state.')",
    "document.addEventListener('click', handleInAppNavigationClick, true)",
    "document.removeEventListener('click', handleInAppNavigationClick, true)",
    'event.preventDefault()',
    'event.stopPropagation()',
    'navigateBackToCompliance',
    "router.push('/compliance')",
  ]) {
    assert.match(
      src,
      new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `principle detail must include ${term}`,
    );
  }
  assert.doesNotMatch(src, /onPress=\{\(\) => router\.push\('\/compliance'\)\}/);
  assert.doesNotMatch(src, /onClick=\{\(\) => router\.push\('\/compliance'\)\}/);
});

test('principle detail standard editor card is extracted from the oversized route file', () => {
  const pageSrc = dash('compliance/[principleId]/page.tsx');
  const cardPath = dashPath('compliance/[principleId]/standard-editor-card.tsx');
  assert.ok(existsSync(cardPath), 'standard editor card should be split out of page.tsx');
  const cardSrc = readFileSync(cardPath, 'utf8');

  assert.match(pageSrc, /StandardEditorCard/);
  assert.doesNotMatch(pageSrc, /Action Taken/);
  assert.doesNotMatch(pageSrc, /Internal Notes/);
  assert.doesNotMatch(pageSrc, /Save failed/);
  assert.match(cardSrc, /Action Taken/);
  assert.match(cardSrc, /Internal Notes/);
  assert.match(cardSrc, /Save failed/);
  assert.match(cardSrc, /onRetrySave/);
});

test('a board mutation failure shows a toast and keeps the existing list (no partial data loss)', () => {
  const src = dash('board/page.tsx');
  assert.match(src, /toast\(/);
  assert.match(src, /logClientError/);
});

test('the shared UI foundation exposes reusable page, state, form, list, status, and evidence primitives', () => {
  const expectedExports: Array<[string, string[]]> = [
    ['ui/app-page.tsx', ['AppPage', 'AppSection']],
    ['ui/status.tsx', ['StatusChip', 'EvidenceChip', 'ReviewFlag', 'DeadlineBadge']],
    ['ui/states.tsx', ['LoadingState', 'EmptyState', 'ErrorState', 'LockedFeatureState', 'ReviewWarningState']],
    ['ui/forms.tsx', ['FieldGroup', 'FormHint', 'ValidationSummary', 'StickyFormActions']],
    ['ui/data-list.tsx', ['DataList', 'DataListTable', 'DataListItems']],
    ['governance/evidence-readiness.tsx', ['EvidenceReadiness', 'EvidencePromptList', 'EvidenceSourceList']],
  ];

  for (const [file, exports] of expectedExports) {
    const src = component(file);
    for (const exportedName of exports) {
      assert.match(src, new RegExp(`export function ${exportedName}\\b`), `${file} must export ${exportedName}`);
    }
  }
});

test('phase 6B operational workflows use shared primitives and review-ready safeguards', () => {
  const expectations: Array<{
    file: string;
    extraFiles?: string[];
    imports: Array<[string, string[]]>;
    sourceTerms: string[];
    patterns?: RegExp[];
  }> = [
    {
      file: 'documents/page.tsx',
      extraFiles: [
        'documents/document-upload-modal.tsx',
        'documents/document-link-modal.tsx',
        'documents/document-delete-modal.tsx',
        'documents/document-list-panel.tsx',
      ],
      imports: [
        ['@/components/ui/app-page', ['AppPage', 'AppSection']],
        ['@/components/ui/states', ['LoadingState', 'EmptyState', 'ErrorState']],
        ['@/components/ui/data-list', ['DataList', 'DataListItems']],
        ['@/components/ui/status', ['EvidenceChip', 'StatusChip']],
        ['@/components/ui/forms', ['FieldGroup', 'FormHint', 'ValidationSummary']],
      ],
      sourceTerms: [
        'private evidence storage',
        'downloadDocId',
        'linkingStandard',
        'unlinkingStandard',
        'aria-live="polite"',
        'review-ready',
      ],
      patterns: [
        /isLoading=\{downloadDocId === doc\.id\}/,
        /isDisabled=\{[^}]*linkingStandard/,
      ],
    },
    {
      file: 'deadlines/page.tsx',
      extraFiles: ['deadlines/deadline-form-modal.tsx', 'deadlines/deadline-list-panel.tsx'],
      imports: [
        ['@/components/ui/app-page', ['AppPage', 'AppSection']],
        ['@/components/ui/states', ['LoadingState', 'EmptyState', 'ErrorState']],
        ['@/components/ui/data-list', ['DataList', 'DataListItems']],
        ['@/components/ui/status', ['DeadlineBadge', 'ReviewFlag', 'StatusChip']],
        ['@/components/ui/forms', ['FieldGroup', 'FormHint', 'ValidationSummary']],
      ],
      sourceTerms: [
        'toggleDeadlineId',
        'deleteDeadlineId',
        'deletingDeadlineId',
        'dueState',
        'priorityLabel',
        'aria-live="polite"',
        'review-ready',
      ],
      patterns: [
        /isDisabled=\{[^}]*toggleDeadlineId/,
        /api\.delete\(`\/deadlines\/\$\{deleteDeadlineId\}`\)/,
        /Delete deadline/,
        /role="checkbox"/,
      ],
    },
    {
      file: 'board/page.tsx',
      extraFiles: ['board/board-member-modal.tsx'],
      imports: [
        ['@/components/ui/app-page', ['AppPage']],
        ['@/components/ui/states', ['LoadingState', 'EmptyState', 'ErrorState']],
        ['@/components/ui/data-list', ['DataListTable', 'DataListItems']],
        ['@/components/ui/status', ['StatusChip']],
        ['@/components/ui/forms', ['FieldGroup', 'FormHint', 'ValidationSummary']],
      ],
      sourceTerms: [
        'mutatingMemberId',
        'TrusteeEvidencePromptCards',
        'BoardEvidenceChips',
        'table and mobile card views',
        'aria-live="polite"',
        'review-ready',
      ],
      patterns: [
        /isDisabled=\{[^}]*mutatingMemberId/,
        /<TableCell>\s*<div className="space-y-2">[\s\S]*?<BoardEvidenceChips member=\{member\} \/>[\s\S]*?conductSignedDate[\s\S]*?inductionDate[\s\S]*?<\/div>\s*<\/TableCell>/,
        /apiErrorMessage/,
      ],
    },
    {
      file: 'organisation/page.tsx',
      extraFiles: ['organisation/organisation-profile-form.tsx'],
      imports: [
        ['@/components/ui/app-page', ['AppPage', 'AppSection']],
        ['@/components/ui/states', ['ErrorState']],
        ['@/components/ui/status', ['ReviewFlag', 'StatusChip']],
        ['@/components/ui/forms', ['FieldGroup', 'FormHint', 'ValidationSummary', 'StickyFormActions']],
      ],
      sourceTerms: [
        'saveError',
        'dirtyStateLabel',
        'financial year end',
        'Registered Charity Number',
        'review-ready',
        'not legal advice',
        'aria-live="polite"',
      ],
      patterns: [
        /isDisabled=\{[^}]*!isDirty/,
        /ValidationSummary/,
      ],
    },
  ];

  for (const { file, extraFiles = [], imports, sourceTerms, patterns = [] } of expectations) {
    const src = [
      dash(file),
      ...extraFiles.map((extraFile) => optionalDash(extraFile)),
    ].join('\n');
    for (const [moduleName, importedNames] of imports) {
      assert.match(src, new RegExp(`from '${moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `${file} must import ${moduleName}`);
      for (const importedName of importedNames) {
        assert.match(src, new RegExp(`\\b${importedName}\\b`), `${file} must use ${importedName}`);
      }
    }
    for (const term of sourceTerms) {
      assert.match(src, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `${file} must include ${term}`);
    }
    for (const pattern of patterns) {
      assert.match(src, pattern, `${file} must satisfy ${pattern}`);
    }
  }
});

test('board trustee evidence UX is extracted from the oversized route file', () => {
  const pageSrc = dash('board/page.tsx');
  const evidencePath = dashPath('board/board-evidence.tsx');
  assert.ok(existsSync(evidencePath), 'board trustee evidence helpers should be split out of page.tsx');
  const evidenceSrc = readFileSync(evidencePath, 'utf8');

  assert.match(pageSrc, /TrusteeEvidencePromptCards/);
  assert.match(pageSrc, /BoardEvidenceChips/);
  assert.match(pageSrc, /getTrusteeEvidence/);
  assert.doesNotMatch(pageSrc, /trusteeEvidencePrompts/);
  assert.match(evidenceSrc, /AppSection/);
  assert.match(evidenceSrc, /EvidenceChip/);
  assert.match(evidenceSrc, /ReviewFlag/);
  assert.match(evidenceSrc, /trusteeEvidencePrompts/);
  assert.match(evidenceSrc, /Trustee evidence prompts/);
});

test('board summary UX is extracted from the oversized route file', () => {
  const pageSrc = dash('board/page.tsx');
  const summaryPath = dashPath('board/board-summary-panel.tsx');
  assert.ok(existsSync(summaryPath), 'board summary panel should be split out of page.tsx');
  const summarySrc = readFileSync(summaryPath, 'utf8');

  assert.match(pageSrc, /BoardSummaryPanel/);
  assert.doesNotMatch(pageSrc, /Keep trustee evidence visible before annual review/);
  assert.match(summarySrc, /Review-ready register/);
  assert.match(summarySrc, /Conduct gaps/);
  assert.match(summarySrc, /ReviewFlag/);
});

test('board member form modal is extracted from the oversized route file', () => {
  const pageSrc = dash('board/page.tsx');
  const modalPath = dashPath('board/board-member-modal.tsx');
  assert.ok(existsSync(modalPath), 'board member modal should be split out of page.tsx');
  const modalSrc = readFileSync(modalPath, 'utf8');

  assert.match(pageSrc, /BoardMemberModal/);
  assert.doesNotMatch(pageSrc, /Trustee details/);
  assert.doesNotMatch(pageSrc, /board-disabled-hint/);
  assert.doesNotMatch(pageSrc, /Saving updates the trustee register after the API confirms the change/);
  assert.match(modalSrc, /Trustee details/);
  assert.match(modalSrc, /board-disabled-hint/);
  assert.match(modalSrc, /Saving updates the trustee register after the API confirms the change/);
});

test('export report preview UI is extracted from the oversized route file', () => {
  const pageSrc = dash('export/page.tsx');
  const previewPath = dashPath('export/export-report-preview.tsx');
  assert.ok(existsSync(previewPath), 'export report preview cards should be split out of page.tsx');
  const previewSrc = readFileSync(previewPath, 'utf8');

  assert.match(pageSrc, /ExportReportPreview/);
  assert.doesNotMatch(pageSrc, /scoreColour/);
  assert.doesNotMatch(pageSrc, /GOVERNANCE_PRINCIPLES\.map/);
  assert.match(previewSrc, /scoreColour/);
  assert.match(previewSrc, /GOVERNANCE_PRINCIPLES\.map/);
  assert.match(previewSrc, /Report Preview/);
  assert.match(previewSrc, /Board Approval Record/);
});

test('documents workflow surfaces conditional obligation evidence prompts from the organisation profile', () => {
  const src = [
    dash('documents/page.tsx'),
    optionalDash('documents/document-profile-prompts.tsx'),
  ].join('\n');
  for (const term of [
    'OrganisationResponse',
    'CONDITIONAL_OBLIGATION_REVIEW_RULES',
    'getMatrixEntriesForStandard',
    "api.get('/organisations')",
    'conditionalObligationPrompts',
    'organisation?.conditionalObligationProfile',
    'profile?.[rule.profileKey]',
    'Profile-triggered evidence prompts',
    'profile-triggered obligations',
    'professional review',
    'sourceRefs',
    'standardCodes.includes(link.standardCode)',
  ]) {
    assert.match(
      src,
      new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      `documents page must include ${term}`,
    );
  }
});

test('documents profile-triggered evidence UX is extracted from the oversized route file', () => {
  const pageSrc = dash('documents/page.tsx');
  const panelPath = dashPath('documents/document-profile-prompts.tsx');
  assert.ok(existsSync(panelPath), 'document profile prompts should be split out of page.tsx');
  const panelSrc = readFileSync(panelPath, 'utf8');

  assert.match(pageSrc, /DocumentProfilePromptsPanel/);
  assert.match(pageSrc, /buildDocumentProfilePrompts/);
  assert.doesNotMatch(pageSrc, /formatReviewFlag/);
  assert.match(panelSrc, /formatReviewFlag/);
  assert.match(panelSrc, /linkedEvidenceCount/);
  assert.match(panelSrc, /Profile-triggered evidence prompts/);
});

test('documents upload modal is extracted from the oversized route file', () => {
  const pageSrc = dash('documents/page.tsx');
  const modalPath = dashPath('documents/document-upload-modal.tsx');
  assert.ok(existsSync(modalPath), 'document upload modal should be split out of page.tsx');
  const modalSrc = readFileSync(modalPath, 'utf8');

  assert.match(pageSrc, /DocumentUploadModal/);
  assert.doesNotMatch(pageSrc, /Document details/);
  assert.doesNotMatch(pageSrc, /document-upload-file/);
  assert.doesNotMatch(pageSrc, /File size exceeds the 10 MB limit/);
  assert.match(modalSrc, /Document details/);
  assert.match(modalSrc, /document-upload-file/);
  assert.match(modalSrc, /File size exceeds the 10 MB limit/);
  assert.match(modalSrc, /MAX_FILE_SIZE/);
});

test('documents standard-link modal is extracted from the oversized route file', () => {
  const pageSrc = dash('documents/page.tsx');
  const modalPath = dashPath('documents/document-link-modal.tsx');
  assert.ok(existsSync(modalPath), 'document standard-link modal should be split out of page.tsx');
  const modalSrc = readFileSync(modalPath, 'utf8');

  assert.match(pageSrc, /DocumentLinkModal/);
  assert.doesNotMatch(pageSrc, /<ModalHeader>Link standard<\/ModalHeader>/);
  assert.doesNotMatch(pageSrc, /link-disabled-hint/);
  assert.doesNotMatch(pageSrc, /This document will appear as evidence on the selected standard/);
  assert.match(modalSrc, /<ModalHeader>Link standard<\/ModalHeader>/);
  assert.match(modalSrc, /link-disabled-hint/);
  assert.match(modalSrc, /This document will appear as evidence on the selected standard/);
});

test('documents delete modal is extracted from the oversized route file', () => {
  const pageSrc = dash('documents/page.tsx');
  const modalPath = dashPath('documents/document-delete-modal.tsx');
  assert.ok(existsSync(modalPath), 'document delete modal should be split out of page.tsx');
  const modalSrc = readFileSync(modalPath, 'utf8');

  assert.match(pageSrc, /DocumentDeleteModal/);
  assert.doesNotMatch(pageSrc, /<ModalHeader>Delete document<\/ModalHeader>/);
  assert.doesNotMatch(pageSrc, /This removes the file and its standard links/);
  assert.match(modalSrc, /<ModalHeader>Delete document<\/ModalHeader>/);
  assert.match(modalSrc, /This removes the file and its standard links/);
});

test('documents uploaded-list panel is extracted from the oversized route file', () => {
  const pageSrc = dash('documents/page.tsx');
  const panelPath = dashPath('documents/document-list-panel.tsx');
  assert.ok(existsSync(panelPath), 'document uploaded-list panel should be split out of page.tsx');
  const panelSrc = readFileSync(panelPath, 'utf8');

  assert.match(pageSrc, /DocumentListPanel/);
  assert.doesNotMatch(pageSrc, /Uploaded documents/);
  assert.doesNotMatch(pageSrc, /No documents uploaded yet/);
  assert.doesNotMatch(pageSrc, /No linked standards/);
  assert.match(panelSrc, /Uploaded documents/);
  assert.match(panelSrc, /No documents uploaded yet/);
  assert.match(panelSrc, /No linked standards/);
  assert.match(panelSrc, /getTrustedDocumentDownloadUrl|handleDownload/);
});

test('deadlines workflow surfaces conditional obligation review dates from the organisation profile', () => {
  const src = [
    dash('deadlines/page.tsx'),
    optionalDash('deadlines/deadline-profile-prompts.tsx'),
  ].join('\n');
  for (const term of [
    'OrganisationResponse',
    'CONDITIONAL_OBLIGATION_REVIEW_RULES',
    'getMatrixEntriesForStandard',
    "api.get('/organisations')",
    'conditionalDeadlinePrompts',
    'deadlineSearchText',
    'organisation?.conditionalObligationProfile',
    'profile?.[rule.profileKey]',
    'scheduleConditionalDeadline',
    'Profile-triggered review dates',
    'profile-triggered obligations',
    'professional review',
    'sourceRefs',
    'reviewDateAlreadyScheduled',
  ]) {
    assert.match(
      src,
      new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      `deadlines page must include ${term}`,
    );
  }
});

test('deadlines profile-triggered review-date UX is extracted from the oversized route file', () => {
  const pageSrc = dash('deadlines/page.tsx');
  const panelPath = dashPath('deadlines/deadline-profile-prompts.tsx');
  assert.ok(existsSync(panelPath), 'deadline profile prompts should be split out of page.tsx');
  const panelSrc = readFileSync(panelPath, 'utf8');

  assert.match(pageSrc, /DeadlineProfilePromptsPanel/);
  assert.match(pageSrc, /buildDeadlineProfilePrompts/);
  assert.doesNotMatch(pageSrc, /formatReviewFlag/);
  assert.match(panelSrc, /formatReviewFlag/);
  assert.match(panelSrc, /reviewDateAlreadyScheduled/);
  assert.match(panelSrc, /Profile-triggered review dates/);
});

test('deadlines form modal is extracted from the oversized route file', () => {
  const pageSrc = dash('deadlines/page.tsx');
  const modalPath = dashPath('deadlines/deadline-form-modal.tsx');
  assert.ok(existsSync(modalPath), 'deadline form modal should be split out of page.tsx');
  const modalSrc = readFileSync(modalPath, 'utf8');

  assert.match(pageSrc, /DeadlineFormModal/);
  assert.doesNotMatch(pageSrc, /Deadline details/);
  assert.doesNotMatch(pageSrc, /deadline-disabled-hint/);
  assert.doesNotMatch(pageSrc, /Default reminders are kept at 30, 7, and 1 day before the due date/);
  assert.match(modalSrc, /Deadline details/);
  assert.match(modalSrc, /deadline-disabled-hint/);
  assert.match(modalSrc, /Default reminders are kept at 30, 7, and 1 day before the due date/);
});

test('deadlines list panel is extracted from the oversized route file', () => {
  const pageSrc = dash('deadlines/page.tsx');
  const panelPath = dashPath('deadlines/deadline-list-panel.tsx');
  assert.ok(existsSync(panelPath), 'deadline list panel should be split out of page.tsx');
  const panelSrc = readFileSync(panelPath, 'utf8');

  assert.match(pageSrc, /DeadlineListPanel/);
  assert.doesNotMatch(pageSrc, /Deadline list ready/);
  assert.doesNotMatch(pageSrc, /No deadlines yet/);
  assert.doesNotMatch(pageSrc, /classifyDeadline/);
  assert.match(panelSrc, /Deadline list ready/);
  assert.match(panelSrc, /No deadlines yet/);
  assert.match(panelSrc, /classifyDeadline/);
  assert.match(panelSrc, /DeadlineBadge/);
});

test('phase 6C registers keeps Complete gating and adds operational review-ready UX primitives', () => {
  const src = [
    dash('registers/page.tsx'),
    optionalDash('registers/use-registers-workflow.ts'),
    optionalDash('registers/register-compliance-cards.tsx'),
    optionalDash('registers/register-overview-panel.tsx'),
    optionalDash('registers/register-record-forms.tsx'),
    optionalDash('registers/register-record-modal.tsx'),
    optionalDash('registers/register-record-lists.tsx'),
  ].join('\n');
  const imports: Array<[string, string[]]> = [
    ['@/components/ui/app-page', ['AppPage', 'AppSection']],
    ['@/components/ui/states', ['LoadingState', 'EmptyState', 'ErrorState', 'LockedFeatureState']],
    ['@/components/ui/data-list', ['DataList', 'DataListItems']],
    ['@/components/ui/status', ['EvidenceChip', 'ReviewFlag', 'StatusChip']],
    ['@/components/ui/forms', ['FieldGroup', 'FormHint', 'ValidationSummary']],
  ];

  for (const [moduleName, importedNames] of imports) {
    assert.match(src, new RegExp(`from '${moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    for (const importedName of importedNames) {
      assert.match(src, new RegExp(`\\b${importedName}\\b`), `registers must use ${importedName}`);
    }
  }

  for (const term of [
    'isPlanFeatureUnavailable',
    'Complete plan',
    'registersRequestSeq',
    'requestedYear',
    'isLatestRegistersRequest',
    'loadedRegistersYear',
    'hasLoadedSelectedYear',
    'canSaveAnnual',
    'canSaveFinancial',
    'registerSavingLabel',
    'Annual Report source check',
    'Financial controls source check',
    'review-ready',
    'aria-live="polite"',
    'governance-registers/annual-report',
    'governance-registers/financial-controls',
  ]) {
    assert.match(src, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `registers must include ${term}`);
  }

  assert.match(src, /isDisabled=\{[^}]*saving/);
  assert.match(src, /const requestSeq = \+\+registersRequestSeq\.current/);
  assert.match(src, /governance-registers\/summary\?year=\$\{requestedYear\}/);
  assert.match(src, /governance-registers\/annual-report\?year=\$\{requestedYear\}/);
  assert.match(src, /governance-registers\/financial-controls\?year=\$\{requestedYear\}/);
  assert.match(src, /setAnnual\(annualRes\.data \?\? emptyAnnual\(requestedYear\)\)/);
  assert.match(src, /setFinancial\(financialRes\.data \?\? emptyFinancial\(requestedYear\)\)/);
  assert.match(src, /const \[loadedRegistersYear, setLoadedRegistersYear\] = useState<number \| null>\(null\)/);
  assert.match(src, /const hasLoadedSelectedYear = loadedRegistersYear === year && !loadError;/);
  assert.match(src, /const canSaveAnnual = hasLoadedSelectedYear && annual\.reportingYear === year;/);
  assert.match(src, /const canSaveFinancial = hasLoadedSelectedYear && financial\.reportingYear === year;/);
  assert.match(src, /setFinancial\(financialRes\.data \?\? emptyFinancial\(requestedYear\)\);[\r\n\s]*setLoadedRegistersYear\(requestedYear\);/);
  assert.match(src, /\]\);[\r\n\s]*if \(!isLatestRegistersRequest\(requestSeq\)\) return;[\r\n\s]*setSummary\(summaryRes\.data\)/);
  assert.match(src, /if \(isPlanFeatureUnavailable\(err\)\) \{[\r\n\s]*if \(!isLatestRegistersRequest\(requestSeq\)\) return;[\r\n\s]*setLoadedRegistersYear\(null\);[\r\n\s]*setPlanUnavailable\(true\)/);
  assert.match(src, /\}[\r\n\s]*if \(!isLatestRegistersRequest\(requestSeq\)\) return;[\r\n\s]*setLoadedRegistersYear\(null\);[\r\n\s]*setSummary\(null\);[\r\n\s]*setConflicts\(\[\]\);[\r\n\s]*setRisks\(\[\]\);[\r\n\s]*setComplaints\(\[\]\);[\r\n\s]*setFundraising\(\[\]\);[\r\n\s]*setAnnual\(emptyAnnual\(requestedYear\)\);[\r\n\s]*setFinancial\(emptyFinancial\(requestedYear\)\);[\r\n\s]*logClientError\('Failed to load governance registers', err\);[\r\n\s]*setLoadError\('Governance registers could not be loaded/);
  assert.match(src, /finally \{[\r\n\s]*if \(isLatestRegistersRequest\(requestSeq\)\) \{[\r\n\s]*setLoading\(false\);[\r\n\s]*\}[\r\n\s]*\}/);
  assert.match(src, /loadError \|\| !hasLoadedSelectedYear \? \(/);
  assert.match(src, /<AnnualReportCard[\s\S]*?saveDisabled=\{!canSaveAnnual\}/);
  assert.match(src, /<FinancialControlsCard[\s\S]*?saveDisabled=\{!canSaveFinancial\}/);
  assert.match(src, /isDisabled=\{saving \|\| saveDisabled\}/);
  assert.match(src, /LockedFeatureState/);
});

test('phase 6C regulator page presents source-cited readiness without legal certainty claims', () => {
  const src = dash('regulator/page.tsx');
  const imports: Array<[string, string[]]> = [
    ['@/components/ui/app-page', ['AppPage', 'AppSection']],
    ['@/components/ui/status', ['ReviewFlag', 'StatusChip']],
  ];

  for (const [moduleName, importedNames] of imports) {
    assert.match(src, new RegExp(`from '${moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    for (const importedName of importedNames) {
      assert.match(src, new RegExp(`\\b${importedName}\\b`), `regulator must use ${importedName}`);
    }
  }

  for (const term of [
    'IRISH_COMPLIANCE_MATRIX',
    'current guidance',
    'not-yet-commenced',
    'professional review',
    'official source',
    'review-ready',
    'not legal advice',
    'rel="noreferrer"',
  ]) {
    assert.match(src, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `regulator must include ${term}`);
  }
});

test('regulator guide prioritises profile-triggered obligations without legal certainty claims', () => {
  const src = dash('regulator/page.tsx');
  for (const term of [
    'OrganisationResponse',
    'CONDITIONAL_OBLIGATION_REVIEW_RULES',
    'api.get(\'/organisations\')',
    'profileTriggeredRegulatorPriorities',
    'organisation?.conditionalObligationProfile',
    'profile?.[rule.profileKey]',
    'Profile-triggered regulator priorities',
    'conditional obligation profile',
    'not legal advice',
    'professional review',
    'sourceRefs',
  ]) {
    assert.match(
      src,
      new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      `regulator page must include ${term}`,
    );
  }
});

test('registers workflow prioritises conditional obligation register work from the organisation profile', () => {
  const src = [
    dash('registers/page.tsx'),
    optionalDash('registers/use-registers-workflow.ts'),
    optionalDash('registers/register-priority-panel.tsx'),
  ].join('\n');
  for (const term of [
    'OrganisationResponse',
    'CONDITIONAL_OBLIGATION_REVIEW_RULES',
    'getMatrixEntriesForStandard',
    "api.get('/organisations')",
    'conditionalRegisterPriorities',
    'registerSearchText',
    'organisation?.conditionalObligationProfile',
    'profile?.[rule.profileKey]',
    'Profile-triggered register priorities',
    'profile-triggered obligations',
    'professional review',
    'sourceRefs',
    'registerPriorityEvidence',
  ]) {
    assert.match(
      src,
      new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      `registers page must include ${term}`,
    );
  }
});

test('registers workflow state is extracted from the oversized route file', () => {
  const pageSrc = dash('registers/page.tsx');
  const hookPath = dashPath('registers/use-registers-workflow.ts');
  assert.ok(existsSync(hookPath), 'registers workflow hook should be split out of page.tsx');
  const hookSrc = readFileSync(hookPath, 'utf8');

  assert.match(pageSrc, /useRegistersWorkflow/);
  assert.doesNotMatch(pageSrc, /registersRequestSeq/);
  assert.doesNotMatch(pageSrc, /isLatestRegistersRequest/);
  assert.doesNotMatch(pageSrc, /function emptyAnnual|const emptyAnnual/);
  assert.doesNotMatch(pageSrc, /function emptyFinancial|const emptyFinancial/);
  assert.match(hookSrc, /export function useRegistersWorkflow/);
  assert.match(hookSrc, /registersRequestSeq/);
  assert.match(hookSrc, /isLatestRegistersRequest/);
  assert.match(hookSrc, /emptyAnnual/);
  assert.match(hookSrc, /emptyFinancial/);
  assert.match(hookSrc, /formDisabledReason/);
});

test('registers profile-priority UX is extracted from the oversized route file', () => {
  const pageSrc = dash('registers/page.tsx');
  const hookPath = dashPath('registers/use-registers-workflow.ts');
  assert.ok(existsSync(hookPath), 'register workflow hook should own priority derivation');
  const hookSrc = readFileSync(hookPath, 'utf8');
  const panelPath = dashPath('registers/register-priority-panel.tsx');
  assert.ok(existsSync(panelPath), 'register priority panel/model should be split out of page.tsx');
  const panelSrc = readFileSync(panelPath, 'utf8');

  assert.match(pageSrc, /RegisterPriorityPanel/);
  assert.doesNotMatch(pageSrc, /buildRegisterPriorities/);
  assert.doesNotMatch(pageSrc, /buildRegisterSearchText/);
  assert.match(hookSrc, /buildRegisterPriorities/);
  assert.match(hookSrc, /buildRegisterSearchText/);
  assert.doesNotMatch(pageSrc, /registerPriorityEvidence/);
  assert.match(panelSrc, /registerPriorityEvidence/);
  assert.match(panelSrc, /Profile-triggered register priorities/);
});

test('registers annual report and financial control cards are extracted from the oversized route file', () => {
  const pageSrc = dash('registers/page.tsx');
  const cardsPath = dashPath('registers/register-compliance-cards.tsx');
  assert.ok(existsSync(cardsPath), 'register compliance cards should be split out of page.tsx');
  const cardsSrc = readFileSync(cardsPath, 'utf8');

  assert.match(pageSrc, /AnnualReportCard/);
  assert.match(pageSrc, /FinancialControlsCard/);
  assert.doesNotMatch(pageSrc, /Annual Report source check/);
  assert.doesNotMatch(pageSrc, /Financial controls source check/);
  assert.match(cardsSrc, /Annual Report source check/);
  assert.match(cardsSrc, /Financial controls source check/);
  assert.match(cardsSrc, /isDisabled=\{saving \|\| saveDisabled\}/);
});

test('registers overview summary panel is extracted from the oversized route file', () => {
  const pageSrc = dash('registers/page.tsx');
  const panelPath = dashPath('registers/register-overview-panel.tsx');
  assert.ok(existsSync(panelPath), 'register overview panel should be split out of page.tsx');
  const panelSrc = readFileSync(panelPath, 'utf8');

  assert.match(pageSrc, /RegisterOverviewPanel/);
  assert.doesNotMatch(pageSrc, /Review-ready register set/);
  assert.doesNotMatch(pageSrc, /Open records/);
  assert.doesNotMatch(pageSrc, /function SummaryTile/);
  assert.match(panelSrc, /Review-ready register set/);
  assert.match(panelSrc, /Open records/);
  assert.match(panelSrc, /function SummaryTile/);
});

test('registers modal record forms are extracted from the oversized route file', () => {
  const pageSrc = dash('registers/page.tsx');
  const hookPath = dashPath('registers/use-registers-workflow.ts');
  assert.ok(existsSync(hookPath), 'register workflow hook should own record normalization calls');
  const hookSrc = readFileSync(hookPath, 'utf8');
  const formsPath = dashPath('registers/register-record-forms.tsx');
  assert.ok(existsSync(formsPath), 'register record forms should be split out of page.tsx');
  const formsSrc = readFileSync(formsPath, 'utf8');

  assert.doesNotMatch(pageSrc, /ConflictForm/);
  assert.doesNotMatch(pageSrc, /RiskForm/);
  assert.doesNotMatch(pageSrc, /ComplaintForm/);
  assert.doesNotMatch(pageSrc, /FundraisingForm/);
  assert.doesNotMatch(pageSrc, /normalizeRegisterForm/);
  assert.match(hookSrc, /normalizeRegisterForm/);
  assert.doesNotMatch(pageSrc, /Conflict record/);
  assert.doesNotMatch(pageSrc, /Fundraising activity/);
  assert.doesNotMatch(pageSrc, /function normalizeForm/);
  assert.match(formsSrc, /export function ConflictForm/);
  assert.match(formsSrc, /export function RiskForm/);
  assert.match(formsSrc, /export function ComplaintForm/);
  assert.match(formsSrc, /export function FundraisingForm/);
  assert.match(formsSrc, /Conflict record/);
  assert.match(formsSrc, /Fundraising activity/);
  assert.match(formsSrc, /export function normalizeRegisterForm/);
});

test('registers record modal shell is extracted from the oversized route file', () => {
  const pageSrc = dash('registers/page.tsx');
  const modalPath = dashPath('registers/register-record-modal.tsx');
  assert.ok(existsSync(modalPath), 'register record modal shell should be split out of page.tsx');
  const modalSrc = readFileSync(modalPath, 'utf8');

  assert.match(pageSrc, /RegisterRecordModal/);
  assert.doesNotMatch(pageSrc, /register-disabled-hint/);
  assert.doesNotMatch(pageSrc, /Saving updates the register after the API confirms the record/);
  assert.match(modalSrc, /register-disabled-hint/);
  assert.match(modalSrc, /Saving updates the register after the API confirms the record/);
  assert.match(modalSrc, /ConflictForm/);
  assert.match(modalSrc, /FundraisingForm/);
});

test('registers operational record list sections are extracted from the oversized route file', () => {
  const pageSrc = dash('registers/page.tsx');
  const listsPath = dashPath('registers/register-record-lists.tsx');
  assert.ok(existsSync(listsPath), 'register record lists should be split out of page.tsx');
  const listsSrc = readFileSync(listsPath, 'utf8');

  assert.match(pageSrc, /RegisterRecordsPanel/);
  assert.doesNotMatch(pageSrc, /Conflicts register/);
  assert.doesNotMatch(pageSrc, /function RegisterSection/);
  assert.doesNotMatch(pageSrc, /function RegisterRow/);
  assert.match(listsSrc, /Conflicts register/);
  assert.match(listsSrc, /Fundraising register/);
  assert.match(listsSrc, /export function RegisterRecordsPanel/);
  assert.match(listsSrc, /export function riskScore/);
});

test('phase 6C team page clarifies permissions, disabled states, and invite feedback', () => {
  const src = dash('team/page.tsx');
  const imports: Array<[string, string[]]> = [
    ['@/components/ui/app-page', ['AppPage', 'AppSection']],
    ['@/components/ui/states', ['LoadingState', 'EmptyState', 'ErrorState']],
    ['@/components/ui/data-list', ['DataList', 'DataListItems']],
    ['@/components/ui/status', ['ReviewFlag', 'StatusChip']],
    ['@/components/ui/forms', ['FieldGroup', 'FormHint']],
  ];

  for (const [moduleName, importedNames] of imports) {
    assert.match(src, new RegExp(`from '${moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    for (const importedName of importedNames) {
      assert.match(src, new RegExp(`\\b${importedName}\\b`), `team must use ${importedName}`);
    }
  }

  for (const term of [
    'permissionDisabledReason',
    'allowedInviteRoles',
    'canInviteAdmin',
    'canInviteMembers',
    'canEditMemberRole',
    'aria-live="polite"',
    'Invite sent',
    'Invite revoked',
    'role guidance',
    'Admins can invite Members only',
    'isDisabled={!canInvite',
  ]) {
    assert.match(src, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `team must include ${term}`);
  }

  assert.match(src, /user\?\.role === UserRole\.OWNER[\s\S]*?UserRole\.ADMIN/);
  assert.match(src, /if \(canInvite\) return \[UserRole\.MEMBER\];/);
  assert.match(src, /useEffect\(\(\) => \{[\s\S]*?!allowedInviteRoles\.includes\(role\)[\s\S]*?setRole\(UserRole\.MEMBER\)/);
  assert.match(src, /if \(!allowedInviteRoles\.includes\(role\)\) return 'Choose an invite role available to your account\.'/);
  assert.match(src, /<SelectItem key=\{UserRole\.ADMIN\} isDisabled=\{!canInviteAdmin\}>Admin<\/SelectItem>/);
  assert.match(src, /if \(next && allowedInviteRoles\.includes\(next\)\) setRole\(next\);/);
  assert.match(src, /isLoading=\{revokeInviteId === invite\.id\}/);
});

test('phase 6C billing preserves Stripe redirect validation while clarifying plan gates', () => {
  const src = dash('billing/page.tsx');
  const imports: Array<[string, string[]]> = [
    ['@/components/ui/app-page', ['AppPage', 'AppSection']],
    ['@/components/ui/states', ['LoadingState', 'ErrorState', 'ReviewWarningState']],
    ['@/components/ui/status', ['ReviewFlag', 'StatusChip']],
  ];

  for (const [moduleName, importedNames] of imports) {
    assert.match(src, new RegExp(`from '${moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    for (const importedName of importedNames) {
      assert.match(src, new RegExp(`\\b${importedName}\\b`), `billing must use ${importedName}`);
    }
  }

  for (const term of [
    'getTrustedStripeRedirectUrl',
    'billingConfigured',
    'provider-degraded',
    'Complete-only register gates',
    'Current plan',
    'isDisabled={isCurrent',
    'aria-live="polite"',
  ]) {
    assert.match(src, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `billing must include ${term}`);
  }

  assert.match(src, /window\.location\.assign\(redirectUrl\)/);
  assert.match(src, /Checkout returned an unexpected redirect URL/);
  assert.doesNotMatch(src, /Monthly \(&euro;\$\{plan\.monthlyPrice\}\/mo\)/);
  assert.match(src, /Monthly \(\\u20ac\$\{plan\.monthlyPrice\}\/mo\)/);
});

test('dashboard navigation manages mobile sidebar focus and meaningful breadcrumbs', () => {
  const dashboardLayout = app('(dashboard)/layout.tsx');
  for (const term of [
    'menuButtonRef',
    'sidebarRef',
    'sidebarId',
    'navInteractive',
    'aria-controls={sidebarId}',
    'aria-expanded={sidebarOpen}',
    'aria-label="Primary navigation"',
    'aria-hidden={!navInteractive ? true : undefined}',
    'tabIndex={navInteractive ? undefined : -1}',
    "event.key === 'Escape'",
    'menuButtonRef.current?.focus()',
    "querySelector<HTMLElement>('a[href]')",
  ]) {
    assert.match(
      dashboardLayout,
      new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `dashboard layout must include ${term}`,
    );
  }

  const breadcrumbs = component('breadcrumbs.tsx');
  for (const term of [
    'GOVERNANCE_PRINCIPLES',
    'PRINCIPLE_LABELS',
    'labelForSegment(seg, segments[i - 1])',
    'Principle details',
    'aria-current="page"',
  ]) {
    assert.match(
      breadcrumbs,
      new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `breadcrumbs must include ${term}`,
    );
  }
  assert.doesNotMatch(breadcrumbs, /const label = LABELS\[seg\] \?\? seg\.replace/);
});

test('theme prepaint and client layout handling support dark mode beyond protected app routes', () => {
  const routeScopedDarkModeTerms = new RegExp(
    ['var app=', 'app&&', 'app routes ' + 'only', 'light' + '-only'].join('|'),
    'i',
  );

  const rootLayout = app('layout.tsx');
  assert.match(rootLayout, /localStorage\.theme/);
  assert.doesNotMatch(rootLayout, routeScopedDarkModeTerms);

  const dashboardLayout = app('(dashboard)/layout.tsx');
  assert.doesNotMatch(dashboardLayout, routeScopedDarkModeTerms);
  assert.doesNotMatch(dashboardLayout, /remove\('dark'\)/);

  for (const file of ['(marketing)/layout.tsx', '(auth)/layout.tsx']) {
    const src = app(file);
    assert.doesNotMatch(src, /className="light|colorScheme: 'light'/i, `${file} must not force light mode`);
    assert.doesNotMatch(src, routeScopedDarkModeTerms, `${file} must not force light mode`);
  }
});

test('shared form/list/status primitives avoid accessibility regressions called out in Phase 4 review', () => {
  const forms = component('ui/forms.tsx');
  assert.doesNotMatch(forms, /<fieldset[^>]*>\s*\{\(title \|\| description\)[\s\S]*?<div[^>]*>\s*\{title \? <legend/);
  assert.match(forms, /<fieldset[^>]*>[\s\S]*\{title \? <legend/);

  const dataList = component('ui/data-list.tsx');
  const fixedScrollHintId = 'data-list-scroll-' + 'hint';
  assert.doesNotMatch(dataList, new RegExp(`id="${fixedScrollHintId}"`));
  assert.doesNotMatch(dataList, new RegExp(`aria-describedby="${fixedScrollHintId}"`));
  assert.match(dataList, /scrollHintId\?/);

  const status = component('ui/status.tsx');
  assert.doesNotMatch(status, /String\(children\)/);
  assert.match(status, /ariaLabel\?/);
});

test('marketing and auth layout chrome includes dark variants for muted text and surfaces', () => {
  const classNames = (src: string) => [...src.matchAll(/className="([^"]+)"/g)].map((match) => match[1]);

  for (const file of ['(marketing)/layout.tsx', '(auth)/layout.tsx']) {
    const src = app(file);
    const mutedChromeClasses = classNames(src).filter((value) => /text-gray-(500|600)/.test(value));
    assert.ok(mutedChromeClasses.length > 0, `${file} should still use muted chrome text classes`);
    for (const className of mutedChromeClasses) {
      assert.match(className, /dark:text-/, `${file} muted chrome class must include a dark text variant: ${className}`);
    }
  }

  const marketing = app('(marketing)/layout.tsx');
  assert.match(marketing, /dark:bg-gray-950\/90/);
  assert.match(marketing, /dark:border-gray-800/);
  assert.match(marketing, /dark:bg-gray-950/);
  assert.match(marketing, /dark:\[&_button\]:text-gray-300/);
  assert.match(marketing, /dark:\[&_nav>a\]:text-gray-200/);

  const auth = app('(auth)/layout.tsx');
  assert.match(auth, /dark:bg-gray-950/);
  assert.match(auth, /dark:text-gray-100/);
});
