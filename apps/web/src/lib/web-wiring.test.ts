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
const repo = (p: string) => readFileSync(join(WEB, '..', '..', p), 'utf8');
const dashPath = (p: string) => join(WEB, 'src', 'app', '(dashboard)', p);
const dash = (p: string) => readFileSync(dashPath(p), 'utf8');
const optionalDash = (p: string) => (existsSync(dashPath(p)) ? readFileSync(dashPath(p), 'utf8') : '');
const app = (p: string) => readFileSync(join(WEB, 'src', 'app', p), 'utf8');
const component = (p: string) => readFileSync(join(WEB, 'src', 'components', p), 'utf8');
const lib = (p: string) => readFileSync(join(WEB, 'src', 'lib', p), 'utf8');

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
  const src = [
    dash('documents/page.tsx'),
    optionalDash('documents/use-documents-workflow.ts'),
  ].join('\n');
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

test('profile-triggered workflows treat missing organisation profiles as setup state', () => {
  const consumers = [
    'documents/use-documents-workflow.ts',
    'deadlines/page.tsx',
    'registers/use-registers-workflow.ts',
    'regulator/page.tsx',
  ];

  for (const file of consumers) {
    const src = dash(file);
    assert.match(src, /from '@\/lib\/errors'/, `${file} must import the API error helpers`);
    assert.match(src, /isApiNotFoundError/, `${file} must recognise expected missing-profile 404s`);
    assert.match(
      src,
      /if \(isApiNotFoundError\(err\)\) \{[\s\S]*?setOrganisation\(null\);[\s\S]*?return;[\s\S]*?\}/,
      `${file} must fall back to the profile setup state without logging expected 404s`,
    );
  }
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
  'board/page.tsx': [
    'board/board-member-list-panel.tsx',
  ],
  'documents/page.tsx': [
    'documents/use-documents-workflow.ts',
    'documents/document-upload-modal.tsx',
    'documents/document-list-panel.tsx',
    'documents/document-link-modal.tsx',
    'documents/document-delete-modal.tsx',
  ],
  'deadlines/page.tsx': [
    'deadlines/deadline-form-modal.tsx',
    'deadlines/deadline-list-panel.tsx',
    'deadlines/deadline-delete-modal.tsx',
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

test('document upload uses the shared file upload field instead of route-local file input styling', () => {
  const modalSrc = dash('documents/document-upload-modal.tsx');
  const fileFieldSrc = component('ui/file-upload-field.tsx');

  assert.match(modalSrc, /FileUploadField/);
  assert.match(fileFieldSrc, /from '@heroui\/react'/);
  assert.match(fileFieldSrc, /<Button\b/);
  assert.match(fileFieldSrc, /type="file"/);
  assert.match(fileFieldSrc, /formatFileSize/);
  assert.doesNotMatch(modalSrc, /type="file"/);
  assert.doesNotMatch(modalSrc, /file:mr-4/);
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

test('organisation review warnings use the shared inline status primitive', () => {
  const pageSrc = dash('organisation/page.tsx');
  const profileSrc = dash('organisation/organisation-conditional-profile.tsx');

  assert.match(pageSrc, /InlineStatus/);
  assert.match(profileSrc, /InlineStatus/);
  assert.doesNotMatch(pageSrc, /border-amber-200 bg-amber-50/);
  assert.doesNotMatch(profileSrc, /border-amber-200 bg-amber-50/);
});

test('organisation setup summary uses shared status panel tones', () => {
  const pageSrc = dash('organisation/page.tsx');

  assert.match(pageSrc, /statusPanelClassName/);
  assert.doesNotMatch(pageSrc, /rounded-lg border border-teal-primary\/20 bg-white p-5/);
  assert.doesNotMatch(pageSrc, /rounded-lg border border-gray-200 bg-gray-50 p-3/);
});

test('organisation setup checkbox groups use HeroUI Checkbox controls', () => {
  const formSrc = dash('organisation/organisation-profile-form.tsx');
  const profileSrc = dash('organisation/organisation-conditional-profile.tsx');

  assert.match(formSrc, /Checkbox/);
  assert.match(profileSrc, /Checkbox/);
  assert.match(formSrc, /from '@heroui\/react'/);
  assert.match(profileSrc, /from '@heroui\/react'/);
  assert.doesNotMatch(formSrc, /type="checkbox"/);
  assert.doesNotMatch(profileSrc, /type="checkbox"/);
  assert.doesNotMatch(formSrc, /h-4 w-4 rounded border-gray-300/);
  assert.doesNotMatch(profileSrc, /h-4 w-4 rounded border-gray-300/);
});

test('organisation complexity selector uses HeroUI RadioGroup controls', () => {
  const formSrc = dash('organisation/organisation-profile-form.tsx');

  assert.match(formSrc, /RadioGroup/);
  assert.match(formSrc, /Radio/);
  assert.match(formSrc, /value=\{complexity\}/);
  assert.match(formSrc, /onValueChange=\{\(value\) => handleComplexityChange\(value as OrganisationComplexity\)\}/);
  assert.doesNotMatch(formSrc, /aria-pressed/);
  assert.doesNotMatch(formSrc, /<button[\s\S]*handleComplexityChange/);
});

// Graceful degradation: error/empty states exist in the source (a clean state on failure,
// never a blank screen / infinite spinner / unhandled exception).
test('the global and dashboard error boundaries render a recoverable screen', () => {
  for (const file of ['error.tsx', '(dashboard)/error.tsx']) {
    const src = app(file);
    assert.match(src, /from '@\/components\/ui\/states'/, `${file} should use shared state primitives`);
    assert.match(src, /ErrorState/, `${file} should render the shared ErrorState`);
    assert.match(src, /reset/, `${file} must offer a recover action`);
    assert.match(src, /Something went wrong/i, `${file} must render a clean error message`);
    assert.doesNotMatch(src, /CircleAlert/, `${file} should not duplicate the error icon`);
    assert.doesNotMatch(src, /border-red-200|bg-red-50/, `${file} should not duplicate red error-card styling`);
  }
});

test('route-group loading screens use the shared LoadingState primitive', () => {
  for (const file of ['(auth)/loading.tsx', '(dashboard)/loading.tsx']) {
    const src = app(file);
    assert.match(src, /from '@\/components\/ui\/states'/, `${file} should import shared state primitives`);
    assert.match(src, /LoadingState/, `${file} should render LoadingState`);
    assert.doesNotMatch(src, /animate-pulse/, `${file} should not duplicate skeleton markup`);
  }

  const dashboardLayout = app('(dashboard)/layout.tsx');
  assert.match(dashboardLayout, /from '@\/components\/ui\/states'/);
  assert.match(dashboardLayout, /LoadingState/);
  assert.doesNotMatch(dashboardLayout, /Loading CharityPilot\.\.\./);
  assert.doesNotMatch(dashboardLayout, /LoaderCircle/);
});

test('the dashboard renders an explicit error card on a load failure (not a blank/empty screen)', () => {
  const src = dash('dashboard/page.tsx');
  assert.match(src, /from '@\/components\/ui\/states'/);
  assert.match(src, /ErrorState/);
  assert.match(src, /ReviewWarningState/);
  assert.match(src, /EmptyState/);
  assert.match(src, /fetchDashboard/);
  assert.doesNotMatch(src, /border-red-200/);
  assert.doesNotMatch(src, /border-amber-200/);
  assert.match(src, /Failed to load dashboard data/i);
});

test('dashboard action lists are extracted from the oversized route file', () => {
  const pageSrc = dash('dashboard/page.tsx');
  const actionListsPath = dashPath('dashboard/dashboard-action-lists.tsx');
  assert.ok(existsSync(actionListsPath), 'dashboard deadlines and board-alert lists should be split out of page.tsx');
  const actionListsSrc = readFileSync(actionListsPath, 'utf8');

  assert.match(pageSrc, /DashboardActionLists/);
  assert.doesNotMatch(pageSrc, /SkeletonList/);
  assert.match(actionListsSrc, /Upcoming Deadlines/);
  assert.match(actionListsSrc, /Board Alerts/);
  assert.match(actionListsSrc, /View all deadlines/);
  assert.match(actionListsSrc, /View board register/);
});

test('dashboard loading and empty states use shared primitives instead of route-local skeleton cards', () => {
  const pageSrc = dash('dashboard/page.tsx');
  const actionListsSrc = dash('dashboard/dashboard-action-lists.tsx');

  assert.match(pageSrc, /from '@\/components\/ui\/states'/);
  assert.match(pageSrc, /from '@\/components\/ui\/status'/);
  assert.match(pageSrc, /LoadingState/);
  assert.match(pageSrc, /EmptyState/);
  assert.match(pageSrc, /StatusDot/);
  assert.doesNotMatch(pageSrc, /function SkeletonCard/);
  assert.doesNotMatch(pageSrc, /animate-pulse/);
  assert.doesNotMatch(pageSrc, /rounded-full bg-green-500/);
  assert.doesNotMatch(pageSrc, /rounded-full bg-amber-400/);
  assert.doesNotMatch(pageSrc, /rounded-full bg-gray-400/);

  assert.match(actionListsSrc, /from '@\/components\/ui\/states'/);
  assert.match(actionListsSrc, /LoadingState/);
  assert.match(actionListsSrc, /EmptyState/);
  assert.match(actionListsSrc, /ReviewWarningState/);
  assert.doesNotMatch(actionListsSrc, /function SkeletonList/);
  assert.doesNotMatch(actionListsSrc, /animate-pulse/);
  assert.doesNotMatch(actionListsSrc, /Everything looks good!/);
});

test('dashboard binary filters use HeroUI Switch instead of route-local switch markup', () => {
  const sources = [
    dash('board/board-member-list-panel.tsx'),
    dash('compliance/page.tsx'),
  ];

  for (const src of sources) {
    assert.match(src, /Switch/);
    assert.match(src, /from '@heroui\/react'/);
    assert.doesNotMatch(src, /role="switch"/);
    assert.doesNotMatch(src, /aria-checked=/);
    assert.doesNotMatch(src, /rounded-full transition-colors/);
  }
});

test('deadline completion uses HeroUI Checkbox instead of a button with checkbox ARIA', () => {
  const src = dash('deadlines/deadline-list-panel.tsx');

  assert.match(src, /Checkbox/);
  assert.match(src, /from '@heroui\/react'/);
  assert.doesNotMatch(src, /role="checkbox"/);
  assert.doesNotMatch(src, /aria-checked=/);
});

test('deadline list rows use shared status panel tones instead of route-local warning cards', () => {
  const listSrc = dash('deadlines/deadline-list-panel.tsx');
  const statusSrc = component('ui/status.tsx');

  assert.match(statusSrc, /statusPanelClassName/);
  assert.match(listSrc, /statusPanelClassName/);
  assert.doesNotMatch(listSrc, /border-rose-200 bg-rose-50/);
  assert.doesNotMatch(listSrc, /border-amber-200 bg-amber-50/);
  assert.doesNotMatch(listSrc, /dark:bg-rose-950/);
  assert.doesNotMatch(listSrc, /dark:bg-amber-950/);
});

test('the per-standard compliance editor announces its save state (Saving / Saved / Save failed)', () => {
  const src = [
    dash('compliance/[principleId]/page.tsx'),
    optionalDash('compliance/[principleId]/standard-editor-card.tsx'),
  ].join('\n');
  assert.match(src, /aria-live/);
  assert.match(src, /Save failed/i);
  assert.match(src, /from '@\/components\/ui\/status'/);
  assert.match(src, /StatusDot/);
  assert.doesNotMatch(src, /style=\{\{ backgroundColor: .*?colour/);
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
  const exportReadiness = optionalDash('export/export-approval-readiness.tsx');
  const exportSurface = [exportPage, exportReadiness].join('\n');
  assert.match(exportPage, /approval-readiness\?year=\$\{year\}/);
  assert.match(exportSurface, /missingExplanations/);
  assert.match(exportSurface, /missingRecords/);
  assert.match(exportSurface, /missingEvidence/);
  assert.match(exportSurface, /profileIssues/);
  assert.match(exportSurface, /conditionalReviewItems/);
  assert.match(exportPage, /MatrixSourceSummary/);
  assert.match(exportSurface, /matrixReviewItems/);
  assert.match(exportSurface, /matrixLastChecked/);
  assert.match(exportSurface, /not_commenced/);
  assert.match(exportSurface, /compliance certificate/i);
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

test('compliance overview uses shared loading and error state primitives', () => {
  const src = dash('compliance/page.tsx');

  assert.match(src, /from '@\/components\/ui\/states'/);
  assert.match(src, /LoadingState/);
  assert.match(src, /ErrorState/);
  assert.match(src, /apiErrorMessage/);
  assert.match(src, /setLoadError/);
  assert.doesNotMatch(src, /animate-pulse/);
});

test('compliance overview principle disclosures expose expanded state and panel ownership', () => {
  const src = dash('compliance/page.tsx');

  assert.match(src, /const panelId = `principle-\$\{principle\.id\}-standards`/);
  assert.match(src, /aria-expanded=\{isExpanded\}/);
  assert.match(src, /aria-controls=\{panelId\}/);
  assert.match(src, /id=\{panelId\}/);
});

test('shell recovery and disclosure actions use HeroUI Button primitives', () => {
  const expectations: Array<['app' | 'dashboard', string]> = [
    ['app', 'error.tsx'],
    ['app', 'not-found.tsx'],
    ['dashboard', 'layout.tsx'],
    ['dashboard', 'compliance/page.tsx'],
  ];

  for (const [scope, file] of expectations) {
    const src = scope === 'dashboard' ? dash(file) : app(file);
    assert.match(src, /from '@heroui\/react'/, `${file} should import HeroUI for shell actions`);
    assert.match(src, /<Button\b/, `${file} should render HeroUI Button controls`);
    assert.doesNotMatch(src, /<button\b/, `${file} should not keep route-local raw action buttons`);
  }

  const notFound = app('not-found.tsx');
  assert.doesNotMatch(notFound, /rounded-full/, '404 actions should not use pill-shaped bespoke link buttons');
  assert.doesNotMatch(notFound, /as=\{Link\}/, 'server-rendered 404 actions should not pass Next Link as a Client Component prop');
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

test('principle detail navigation guard preserves expected browser link behaviour', () => {
  const src = dash('compliance/[principleId]/page.tsx');
  for (const term of [
    'event.defaultPrevented',
    'event.button !== 0',
    'event.metaKey',
    'event.ctrlKey',
    'event.shiftKey',
    'event.altKey',
    "anchor.hasAttribute('download')",
    "anchor.target && anchor.target !== '_self'",
    'destination.origin !== window.location.origin',
    'isSamePageHash',
    'destination.pathname === current.pathname',
    'destination.search === current.search',
    'destination.hash.length > 0',
    'window.addEventListener(\'beforeunload\', warnIfUnsaved)',
    'window.removeEventListener(\'beforeunload\', warnIfUnsaved)',
    "event.returnValue = ''",
  ]) {
    assert.match(
      src,
      new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `principle detail navigation guard must include ${term}`,
    );
  }
});

test('principle detail back and retry controls use HeroUI Button primitives', () => {
  const pageSrc = dash('compliance/[principleId]/page.tsx');
  const cardSrc = dash('compliance/[principleId]/standard-editor-card.tsx');

  assert.match(pageSrc, /<Button[\s\S]{0,320}onPress=\{navigateBackToCompliance\}/);
  assert.match(pageSrc, /startContent=\{\s*<ChevronLeft/);
  assert.doesNotMatch(
    pageSrc,
    /<button[\s\S]{0,320}(navigateBackToCompliance|Back to Compliance)/,
    'principle detail back navigation should not use a route-local raw button',
  );

  assert.match(cardSrc, /from '@heroui\/react'/);
  assert.match(cardSrc, /<Button[\s\S]{0,260}onPress=\{\(\) => onRetrySave\(standard\.id, form\)\}/);
  assert.doesNotMatch(
    cardSrc,
    /<button[\s\S]{0,260}onRetrySave/,
    'standard retry control should not use a raw button',
  );
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

test('principle detail uses shared loading and error state primitives', () => {
  const src = dash('compliance/[principleId]/page.tsx');

  assert.match(src, /from '@\/components\/ui\/states'/);
  assert.match(src, /LoadingState/);
  assert.match(src, /ErrorState/);
  assert.match(src, /apiErrorMessage/);
  assert.match(src, /setLoadError/);
  assert.doesNotMatch(src, /animate-pulse/);
  assert.doesNotMatch(src, /text-center py-12/);
  assert.doesNotMatch(src, /Principle not found\.<\/p>/);
});

test('a board mutation failure shows a toast and keeps the existing list (no partial data loss)', () => {
  const src = dash('board/page.tsx');
  assert.match(src, /toast\(/);
  assert.match(src, /logClientError/);
});

test('the shared UI foundation exposes reusable page, state, form, list, status, and evidence primitives', () => {
  const expectedExports: Array<[string, string[]]> = [
    ['ui/app-page.tsx', ['AppPage', 'AppSection']],
    ['ui/status.tsx', ['StatusChip', 'StatusDot', 'EvidenceChip', 'ReviewFlag', 'DeadlineBadge']],
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

test('shared state primitives keep long text and actions inside narrow layouts', () => {
  const src = component('ui/states.tsx');

  assert.match(src, /w-full/);
  assert.match(src, /min-w-0/);
  assert.match(src, /overflow-hidden/);
  assert.match(src, /break-words/);
  assert.match(src, /max-w-full/);
  assert.match(src, /role=\{role\}/);
  assert.match(src, /aria-live=\{ariaLive\}/);
  assert.match(src, /flex-wrap justify-center gap-2/);
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
        'documents/use-documents-workflow.ts',
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
        /Checkbox/,
      ],
    },
    {
      file: 'board/page.tsx',
      extraFiles: ['board/board-member-modal.tsx', 'board/board-member-list-panel.tsx'],
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
  const listPanelSrc = optionalDash('board/board-member-list-panel.tsx');
  const evidencePath = dashPath('board/board-evidence.tsx');
  assert.ok(existsSync(evidencePath), 'board trustee evidence helpers should be split out of page.tsx');
  const evidenceSrc = readFileSync(evidencePath, 'utf8');

  assert.match(pageSrc, /TrusteeEvidencePromptCards/);
  assert.match(listPanelSrc, /BoardEvidenceChips/);
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
  assert.match(summarySrc, /statusPanelClassName/);
  assert.doesNotMatch(summarySrc, /rounded-lg border border-gray-200 bg-gray-50 p-3/);
});

test('board summary waits for a successful load instead of showing zero-count placeholders', () => {
  const pageSrc = dash('board/page.tsx');

  assert.match(pageSrc, /const boardDataReady = !loading && !loadError/);
  assert.match(pageSrc, /\{boardDataReady && \(\s*<BoardSummaryPanel summary=\{summary\} \/>/);
  assert.match(pageSrc, /\{boardDataReady && <TrusteeEvidencePromptCards \/>/);
});

test('board evidence and mobile member cards use shared status panel tones', () => {
  const evidenceSrc = dash('board/board-evidence.tsx');
  const listPanelSrc = dash('board/board-member-list-panel.tsx');

  assert.match(evidenceSrc, /statusPanelClassName/);
  assert.match(listPanelSrc, /statusPanelClassName/);
  assert.doesNotMatch(evidenceSrc, /rounded-lg border border-gray-200 bg-white p-4/);
  assert.doesNotMatch(listPanelSrc, /rounded-lg border border-gray-200 bg-white p-4/);
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

test('board trustee evidence checkboxes use HeroUI Checkbox controls', () => {
  const modalSrc = dash('board/board-member-modal.tsx');

  assert.match(modalSrc, /Checkbox/);
  assert.match(modalSrc, /from '@heroui\/react'/);
  assert.match(modalSrc, /isSelected=\{formConductSigned\}/);
  assert.match(modalSrc, /isSelected=\{formInduction\}/);
  assert.doesNotMatch(modalSrc, /type="checkbox"/);
  assert.doesNotMatch(modalSrc, /h-4 w-4 rounded border-gray-300/);
});

test('board member list panel is extracted from the oversized route file', () => {
  const pageSrc = dash('board/page.tsx');
  const panelPath = dashPath('board/board-member-list-panel.tsx');
  assert.ok(existsSync(panelPath), 'board member list panel should be split out of page.tsx');
  const panelSrc = readFileSync(panelPath, 'utf8');

  assert.match(pageSrc, /BoardMemberListPanel/);
  assert.doesNotMatch(pageSrc, /Board register ready/);
  assert.doesNotMatch(pageSrc, /table and mobile card views/);
  assert.doesNotMatch(pageSrc, /function formatDate|const formatDate/);
  assert.match(panelSrc, /Board register ready/);
  assert.match(panelSrc, /table and mobile card views/);
  assert.match(panelSrc, /BoardEvidenceChips/);
  assert.match(panelSrc, /formatDate/);
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
  assert.match(previewSrc, /statusPanelClassName/);
  assert.doesNotMatch(previewSrc, /border border-gray-200 bg-white p-5 shadow-sm/);
});

test('export loading, warning, and sign-off error states use shared primitives', () => {
  const pageSrc = dash('export/page.tsx');
  const previewSrc = dash('export/export-report-preview.tsx');

  assert.match(pageSrc, /from '@\/components\/ui\/form-alert'/);
  assert.match(pageSrc, /FormAlert/);
  assert.match(pageSrc, /ErrorState/);
  assert.match(pageSrc, /ReviewWarningState/);
  assert.match(pageSrc, /Before exporting/);
  assert.match(pageSrc, /const \[loadError, setLoadError\]/);
  assert.match(pageSrc, /setLoadError\('Could not load export data/);
  assert.match(pageSrc, /loadError && !loading/);
  assert.match(pageSrc, /onPress=\{fetchSummary\}/);
  assert.match(pageSrc, /const nextSummary = summaryRes\.data as ComplianceSummary \| null/);
  assert.match(pageSrc, /const nextSignoff = signoffRes\.data as ComplianceSignoffResponse \| null/);
  assert.match(pageSrc, /if \(!nextSummary \|\| !nextSignoff\)/);
  assert.match(pageSrc, /throw new Error\('Export data response missing summary or sign-off payload'\)/);
  assert.doesNotMatch(pageSrc, /CircleAlert/);
  assert.doesNotMatch(pageSrc, /role="alert" className=/);
  assert.doesNotMatch(pageSrc, /bg-red-50/);

  assert.match(previewSrc, /from '@\/components\/ui\/states'/);
  assert.match(previewSrc, /LoadingState/);
  assert.doesNotMatch(previewSrc, /animate-pulse/);
});

test('export approval-readiness issue UI is extracted and uses shared review primitives', () => {
  const pageSrc = dash('export/page.tsx');
  const readinessPath = dashPath('export/export-approval-readiness.tsx');
  assert.ok(existsSync(readinessPath), 'export approval-readiness UI should be split out of page.tsx');
  const readinessSrc = readFileSync(readinessPath, 'utf8');

  assert.match(pageSrc, /ApprovalReadinessIssues/);
  assert.match(pageSrc, /ConditionalReviewPrompts/);
  assert.match(pageSrc, /countApprovalReadinessBlockers/);
  assert.match(pageSrc, /approvalReadinessBlockerCodes/);
  assert.doesNotMatch(pageSrc, /border-amber-200/);
  assert.doesNotMatch(pageSrc, /bg-amber-50/);
  assert.doesNotMatch(pageSrc, /evidenceGapLabel/);

  assert.match(readinessSrc, /export function ApprovalReadinessIssues/);
  assert.match(readinessSrc, /export function ConditionalReviewPrompts/);
  assert.match(readinessSrc, /export function countApprovalReadinessBlockers/);
  assert.match(readinessSrc, /export function approvalReadinessBlockerCodes/);
  assert.match(readinessSrc, /from '@\/components\/ui\/status'/);
  assert.match(readinessSrc, /ReviewFlag/);
  assert.match(readinessSrc, /StatusChip/);
  assert.match(readinessSrc, /statusPanelClassName/);
  assert.doesNotMatch(readinessSrc, /border border-gray-200 bg-white p-4 shadow-sm/);
  assert.doesNotMatch(readinessSrc, /border-amber-200/);
  assert.doesNotMatch(readinessSrc, /bg-amber-50/);
});

test('documents workflow surfaces conditional obligation evidence prompts from the organisation profile', () => {
  const src = [
    dash('documents/page.tsx'),
    optionalDash('documents/use-documents-workflow.ts'),
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

test('documents workflow state is extracted from the oversized route file', () => {
  const pageSrc = dash('documents/page.tsx');
  const hookPath = dashPath('documents/use-documents-workflow.ts');
  assert.ok(existsSync(hookPath), 'document workflow state should be split out of page.tsx');
  const hookSrc = readFileSync(hookPath, 'utf8');

  assert.match(pageSrc, /useDocumentsWorkflow/);
  assert.doesNotMatch(pageSrc, /useState<DocumentResponse\[\]>/);
  assert.doesNotMatch(pageSrc, /const fetchDocuments = useCallback/);
  assert.doesNotMatch(pageSrc, /getTrustedDocumentDownloadUrl/);
  assert.match(hookSrc, /export function useDocumentsWorkflow/);
  assert.match(hookSrc, /const fetchDocuments = useCallback/);
  assert.match(hookSrc, /getTrustedDocumentDownloadUrl/);
  assert.match(hookSrc, /conditionalObligationPrompts/);
  assert.match(hookSrc, /uploadDisabledReason/);
  assert.match(hookSrc, /linkDisabledReason/);
});

test('documents summary and evidence cards use shared status panel tones', () => {
  const pageSrc = dash('documents/page.tsx');
  const panelSrc = optionalDash('documents/document-profile-prompts.tsx');

  assert.match(pageSrc, /statusPanelClassName/);
  assert.match(panelSrc, /statusPanelClassName/);
  assert.doesNotMatch(pageSrc, /rounded-lg border border-gray-200 bg-gray-50 p-3/);
  assert.doesNotMatch(pageSrc, /rounded-lg border border-gray-200 bg-white p-4/);
  assert.doesNotMatch(panelSrc, /rounded-lg border border-gray-200 bg-white p-4/);
});

test('documents summary waits for a successful load instead of showing zero-count placeholders', () => {
  const pageSrc = dash('documents/page.tsx');

  assert.match(pageSrc, /const documentDataReady = !loading && !loadError/);
  assert.match(pageSrc, /\{documentDataReady && \(\s*<section className=\{statusPanelClassName\('brand', 'p-5 shadow-sm'\)\}>/);
  assert.match(pageSrc, /\{documentDataReady && \(\s*<AppSection\s+title="Evidence pack"/);
  assert.match(pageSrc, /\{documentDataReady && \(\s*<DocumentProfilePromptsPanel/);
  assert.match(pageSrc, /\{documentDataReady && \(\s*<AppSection\s+title="Operational register signals"/);
});

test('documents profile-triggered evidence UX is extracted from the oversized route file', () => {
  const pageSrc = dash('documents/page.tsx');
  const hookSrc = optionalDash('documents/use-documents-workflow.ts');
  const panelPath = dashPath('documents/document-profile-prompts.tsx');
  assert.ok(existsSync(panelPath), 'document profile prompts should be split out of page.tsx');
  const panelSrc = readFileSync(panelPath, 'utf8');

  assert.match(pageSrc, /DocumentProfilePromptsPanel/);
  assert.doesNotMatch(pageSrc, /buildDocumentProfilePrompts/);
  assert.match(hookSrc, /buildDocumentProfilePrompts/);
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

test('primary add actions use icon-library icons instead of route-local inline svg', () => {
  for (const file of ['documents/page.tsx', 'board/page.tsx', 'deadlines/page.tsx']) {
    const src = dash(file);
    assert.match(src, /from 'lucide-react'/, `${file} should use the shared icon library for primary add actions`);
    assert.match(src, /<Plus\b/, `${file} should render the add icon through lucide-react`);
    assert.doesNotMatch(src, /<svg\b/, `${file} should not carry hand-drawn inline SVG markup`);
  }
});

test('remaining P0 dashboard route chrome uses lucide icons instead of inline svg', () => {
  const expectations: Array<[string, string[]]> = [
    ['export/page.tsx', ['Download']],
    ['compliance/page.tsx', ['ChevronDown']],
    ['compliance/[principleId]/page.tsx', ['ChevronLeft']],
  ];

  for (const [file, icons] of expectations) {
    const src = dash(file);
    assert.match(src, /from 'lucide-react'/, `${file} should use lucide-react for route chrome icons`);
    for (const icon of icons) {
      assert.match(src, new RegExp(`<${icon}\\b`), `${file} should render ${icon} through lucide-react`);
    }
    assert.doesNotMatch(src, /<svg\b/, `${file} should not carry hand-drawn inline SVG markup`);
  }
});

test('shared UI chrome uses lucide icons instead of inline svg', () => {
  const expectations: Array<[string, string[]]> = [
    ['back-to-top.tsx', ['ArrowUp']],
    ['breadcrumbs.tsx', ['ChevronRight']],
    ['copy-link-button.tsx', ['Check', 'Link2']],
    ['theme-toggle.tsx', ['Monitor', 'Moon', 'Sun']],
    ['toast.tsx', ['Check', 'CircleAlert']],
    ['ui/states.tsx', ['CircleAlert', 'Clock', 'LoaderCircle', 'LockKeyhole', 'TriangleAlert']],
  ];

  for (const [file, icons] of expectations) {
    const src = component(file);
    assert.match(src, /from 'lucide-react'/, `${file} should use lucide-react for shared chrome icons`);
    for (const icon of icons) {
      assert.match(src, new RegExp(`<${icon}\\b`), `${file} should render ${icon} through lucide-react`);
    }
    assert.doesNotMatch(src, /<svg\b/, `${file} should not carry hand-drawn inline SVG markup`);
  }
});

test('shared utility icon controls use HeroUI Button rather than raw button markup', () => {
  for (const file of ['back-to-top.tsx', 'copy-link-button.tsx', 'theme-toggle.tsx']) {
    const src = component(file);
    assert.match(src, /from '@heroui\/react'/, `${file} should use HeroUI for icon button semantics`);
    assert.match(src, /<Button\b/, `${file} should render a HeroUI Button`);
    assert.match(src, /isIconOnly/, `${file} should keep the compact icon-only affordance explicit`);
    assert.doesNotMatch(src, /<button\b/, `${file} should not render a route-local raw button`);
  }
});

test('dashboard layout navigation uses lucide icons instead of inline svg', () => {
  const src = dash('layout.tsx');
  const icons = [
    'BookOpenCheck',
    'Building2',
    'CalendarDays',
    'ClipboardCheck',
    'CreditCard',
    'Download',
    'FileText',
    'LayoutDashboard',
    'LogOut',
    'Menu',
    'ShieldCheck',
    'UserRoundCog',
    'UsersRound',
    'X',
  ];

  assert.match(src, /from 'lucide-react'/, 'dashboard layout should use lucide-react for shell icons');
  for (const icon of icons) {
    assert.match(src, new RegExp(`<${icon}\\b`), `dashboard layout should render ${icon} through lucide-react`);
  }
  assert.doesNotMatch(src, /<svg\b/, 'dashboard layout should not carry hand-drawn inline SVG markup');
});

test('app shell and error chrome use lucide icons instead of inline svg', () => {
  const expectations: Array<[string, string, string[]]> = [
    ['app', 'error.tsx', ['RefreshCcw']],
    ['app', 'not-found.tsx', ['ArrowLeft']],
    ['dashboard', 'error.tsx', ['RefreshCcw']],
    ['app', '(auth)/layout.tsx', ['ArrowLeft', 'ShieldCheck']],
    ['app', '(marketing)/layout.tsx', ['ShieldCheck']],
    ['app', '(marketing)/MobileNav.tsx', ['Menu', 'X']],
  ];

  for (const [scope, file, icons] of expectations) {
    const src = scope === 'dashboard' ? dash(file) : app(file);
    assert.match(src, /from 'lucide-react'/, `${file} should use lucide-react for app shell icons`);
    for (const icon of icons) {
      assert.match(src, new RegExp(`<${icon}\\b`), `${file} should render ${icon} through lucide-react`);
    }
    assert.doesNotMatch(src, /<svg\b/, `${file} should not carry hand-drawn inline SVG markup`);
  }
});

test('workflow status controls use lucide icons instead of inline svg', () => {
  const expectations: Array<[string, string, string[]]> = [
    ['component', 'cookie-consent.tsx', ['CircleAlert']],
    ['component', 'session-timeout.tsx', ['Clock']],
    ['dashboard', 'compliance/[principleId]/standard-editor-card.tsx', ['Check', 'CircleAlert', 'LoaderCircle']],
    ['dashboard', 'documents/document-list-panel.tsx', ['X']],
    ['dashboard', 'export/export-report-preview.tsx', ['Building2', 'CircleCheck', 'FileText', 'ListChecks', 'ShieldCheck', 'UsersRound']],
  ];

  for (const [scope, file, icons] of expectations) {
    const src = scope === 'dashboard' ? dash(file) : component(file);
    assert.match(src, /from 'lucide-react'/, `${file} should use lucide-react for workflow status icons`);
    for (const icon of icons) {
      assert.match(src, new RegExp(`<${icon}\\b`), `${file} should render ${icon} through lucide-react`);
    }
    assert.doesNotMatch(src, /<svg\b/, `${file} should not carry hand-drawn inline SVG markup`);
  }
});

test('marketing blog client uses lucide icons instead of inline svg', () => {
  const src = app('(marketing)/blog/BlogClient.tsx');
  const icons = ['ArrowRight', 'BookOpen', 'FileText', 'Search', 'ShieldCheck'];

  assert.match(src, /from 'lucide-react'/, 'BlogClient should use lucide-react for marketing blog icons');
  for (const icon of icons) {
    assert.match(src, new RegExp(`<${icon}\\b`), `BlogClient should render ${icon} through lucide-react`);
  }
  assert.doesNotMatch(src, /<svg\b/, 'BlogClient should not carry hand-drawn inline SVG markup');
});

test('marketing blog search and CTA use HeroUI controls instead of route-local form/link styling', () => {
  const src = app('(marketing)/blog/BlogClient.tsx');

  assert.match(src, /import \{ Button, Input \} from '@heroui\/react'/);
  assert.match(src, /<Input\b/);
  assert.match(src, /startContent=\{<Search/);
  assert.match(src, /onValueChange=\{setSearch\}/);
  assert.match(src, /<Button\s+as=\{Link\}\s+href="\/register"/);
  assert.doesNotMatch(src, /<input\b/);
  assert.doesNotMatch(src, /inline-flex items-center rounded-lg bg-teal-primary px-6/);
});

test('public marketing and cookie action controls use HeroUI Button primitives', () => {
  const expectations: Array<['app' | 'component', string]> = [
    ['app', '(marketing)/MobileNav.tsx'],
    ['app', '(marketing)/blog/BlogClient.tsx'],
    ['component', 'cookie-consent.tsx'],
  ];

  for (const [scope, file] of expectations) {
    const src = scope === 'app' ? app(file) : component(file);
    assert.match(src, /from '@heroui\/react'/, `${file} should use HeroUI for public action controls`);
    assert.match(src, /<Button\b/, `${file} should render HeroUI Button controls`);
    assert.doesNotMatch(src, /<button\b/, `${file} should not keep raw public action buttons`);
  }

  const mobileNav = app('(marketing)/MobileNav.tsx');
  assert.match(mobileNav, /dark:bg-gray-900/, 'mobile nav menu should have dark-mode surface styling');
  assert.match(mobileNav, /dark:text-gray-200/, 'mobile nav menu links should have dark-mode text styling');
});

test('auth routes use lucide icons instead of route-local inline svg', () => {
  const expectations: Array<[string, string[]]> = [
    ['register/page.tsx', ['Check', 'Circle']],
    ['reset-password/page.tsx', ['Check']],
    ['forgot-password/page.tsx', ['Mail']],
    ['verify-email/page.tsx', ['Mail', 'Check', 'CircleAlert']],
  ];

  for (const [file, icons] of expectations) {
    const src = app(`(auth)/${file}`);
    assert.match(src, /from 'lucide-react'/, `${file} should use lucide-react for auth icons`);
    for (const icon of icons) {
      assert.match(src, new RegExp(`<${icon}\\b`), `${file} should render ${icon} through lucide-react`);
    }
    assert.doesNotMatch(src, /<svg\b/, `${file} should not carry hand-drawn inline SVG markup`);
  }
});

test('auth password visibility controls use the shared HeroUI icon button primitive', () => {
  const sharedPath = join(WEB, 'src', 'components', 'ui', 'password-visibility-button.tsx');
  assert.ok(existsSync(sharedPath), 'shared password visibility button primitive should exist');

  const primitive = readFileSync(sharedPath, 'utf8');
  assert.match(primitive, /from '@heroui\/react'/);
  assert.match(primitive, /<Button\b/);
  assert.match(primitive, /isIconOnly/);
  assert.match(primitive, /from 'lucide-react'/);
  assert.match(primitive, /<Eye\b/);
  assert.match(primitive, /<EyeOff\b/);

  const routes = [
    '(auth)/login/page.tsx',
    '(auth)/register/page.tsx',
    '(auth)/reset-password/page.tsx',
    '(auth)/accept-invite/page.tsx',
  ];

  for (const route of routes) {
    const src = app(route);
    assert.match(src, /PasswordVisibilityButton/, `${route} should use the shared password visibility control`);
    assert.doesNotMatch(
      src,
      /<button[\s\S]{0,240}(showPassword|setShowPassword|showConfirm|setShowConfirm|Show passwords|Hide passwords)/,
      `${route} should not keep a route-local raw password visibility button`,
    );
  }
});

test('auth form errors use the shared FormAlert primitive instead of repeated raw red alert blocks', () => {
  const routes = [
    '(auth)/login/page.tsx',
    '(auth)/register/page.tsx',
    '(auth)/forgot-password/page.tsx',
    '(auth)/reset-password/page.tsx',
    '(auth)/accept-invite/page.tsx',
    '(auth)/verify-email/page.tsx',
  ];

  for (const route of routes) {
    const src = app(route);
    assert.match(src, /from '@\/components\/ui\/form-alert'/, `${route} should import the shared form alert`);
    assert.match(src, /<FormAlert/, `${route} should render FormAlert for form-level errors`);
    assert.doesNotMatch(src, /bg-red-50 border border-red-200/, `${route} should not duplicate alert styling`);
    assert.doesNotMatch(src, /role="alert"/, `${route} should leave alert semantics to FormAlert`);
  }

  const primitive = component('ui/form-alert.tsx');
  assert.match(primitive, /export function FormAlert/);
  assert.match(primitive, /role="alert"/);
  assert.match(primitive, /aria-live="assertive"/);
  assert.match(primitive, /TriangleAlert/);
});

test('marketing routes use lucide icons instead of route-local inline svg', () => {
  const expectations: Array<[string, string[]]> = [
    ['page.tsx', ['CircleCheck', 'FolderOpen', 'UsersRound', 'CalendarDays', 'FileText', 'Clock', 'ChevronDown']],
    ['features/page.tsx', ['CircleCheck', 'FolderOpen', 'UsersRound', 'CalendarDays', 'FileText', 'Check']],
    ['pricing/page.tsx', ['Check', 'X', 'ChevronDown']],
    ['blog/[slug]/page.tsx', ['ArrowLeft', 'Share2']],
  ];

  for (const [file, icons] of expectations) {
    const src = app(`(marketing)/${file}`);
    assert.match(src, /from 'lucide-react'/, `${file} should use lucide-react for marketing icons`);
    for (const icon of icons) {
      assert.match(src, new RegExp(`<${icon}\\b`), `${file} should render ${icon} through lucide-react`);
    }
    assert.doesNotMatch(src, /<svg\b/, `${file} should not carry hand-drawn inline SVG markup`);
  }
});

test('platform audit no longer asks to clean route inline SVGs after route pages are clear', () => {
  const audit = repo('docs/platform-completion-audit.md');
  assert.doesNotMatch(audit, /clean remaining inline SVG/i);
  assert.doesNotMatch(audit, /inline-icon cleanup/i);
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

test('deadlines summary and profile cards use shared status panel tones', () => {
  const pageSrc = dash('deadlines/page.tsx');
  const panelSrc = optionalDash('deadlines/deadline-profile-prompts.tsx');

  assert.match(pageSrc, /statusPanelClassName/);
  assert.match(panelSrc, /statusPanelClassName/);
  assert.doesNotMatch(pageSrc, /rounded-lg border border-gray-200 bg-gray-50 p-3/);
  assert.doesNotMatch(pageSrc, /rounded-lg border border-gray-200 bg-white p-4/);
  assert.doesNotMatch(panelSrc, /rounded-lg border border-gray-200 bg-white p-4/);
});

test('deadlines summary waits for a successful load instead of showing zero-count placeholders', () => {
  const pageSrc = dash('deadlines/page.tsx');

  assert.match(pageSrc, /const deadlineDataReady = !loading && !loadError/);
  assert.match(pageSrc, /\{deadlineDataReady && \(\s*<section className=\{statusPanelClassName\('brand', 'p-5 shadow-sm'\)\}>/);
  assert.match(pageSrc, /\{deadlineDataReady && \(\s*<AppSection\s+title="Regulatory cadence"/);
  assert.match(pageSrc, /\{deadlineDataReady && \(\s*<DeadlineProfilePromptsPanel/);
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

test('deadlines delete confirmation modal is extracted from the oversized route file', () => {
  const pageSrc = dash('deadlines/page.tsx');
  const modalPath = dashPath('deadlines/deadline-delete-modal.tsx');
  assert.ok(existsSync(modalPath), 'deadline delete modal should be split out of page.tsx');
  const modalSrc = readFileSync(modalPath, 'utf8');

  assert.match(pageSrc, /DeadlineDeleteModal/);
  assert.doesNotMatch(pageSrc, /<Modal isOpen=\{deleteModal\.isOpen\}/);
  assert.doesNotMatch(pageSrc, /<ModalHeader>Delete deadline<\/ModalHeader>/);
  assert.doesNotMatch(pageSrc, /This cannot be undone/);
  assert.match(modalSrc, /Delete deadline/);
  assert.match(modalSrc, /Remove \{selectedDeadline \?/);
  assert.match(modalSrc, /This cannot be undone/);
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
  assert.match(src, /!registersDataReady \? \(/);
  assert.match(src, /<AnnualReportCard[\s\S]*?saveDisabled=\{!canSaveAnnual\}/);
  assert.match(src, /<FinancialControlsCard[\s\S]*?saveDisabled=\{!canSaveFinancial\}/);
  assert.match(src, /isDisabled=\{saving \|\| saveDisabled\}/);
  assert.match(src, /LockedFeatureState/);
});

test('registers overview waits for the selected year to load before showing summary numbers', () => {
  const pageSrc = dash('registers/page.tsx');

  assert.match(pageSrc, /const registersDataReady = !loading && !loadError && hasLoadedSelectedYear/);
  assert.match(pageSrc, /\{registersDataReady && \(\s*<RegisterOverviewPanel/);
  assert.match(pageSrc, /\) : !registersDataReady \? \(/);
});

test('phase 6C regulator page presents source-cited readiness without legal certainty claims', () => {
  const src = dash('regulator/page.tsx');
  const imports: Array<[string, string[]]> = [
    ['@/components/ui/app-page', ['AppPage', 'AppSection']],
    ['@/components/ui/status', ['ReviewFlag', 'StatusChip', 'statusPanelClassName']],
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

test('regulator readiness cards use shared status panel tones', () => {
  const src = dash('regulator/page.tsx');

  assert.match(src, /statusPanelClassName/);
  assert.doesNotMatch(src, /rounded-lg border border-teal-primary\/20 bg-white p-5/);
  assert.doesNotMatch(src, /rounded-lg border border-gray-200 bg-gray-50 p-3/);
  assert.doesNotMatch(src, /rounded-lg border border-gray-200 bg-white p-4/);
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

test('regulator official-source links use compact link styling rather than pill badges', () => {
  const src = dash('regulator/page.tsx');

  assert.doesNotMatch(src, /rounded-full\s+border/, 'regulator source links should not read as pill badges');
  assert.match(src, /rounded-md border border-gray-200 px-2.5 py-1/);
});

test('platform audit distinguishes decorative pills from functional toggles and status dots', () => {
  const auditScript = repo('scripts/platform-completion-audit.mjs');

  assert.doesNotMatch(auditScript, /gradient\|blur-\|rounded-full/);
  assert.match(auditScript, /pillLikeDecorativePattern/);
  assert.match(auditScript, /hasDecorativeStylingRisk/);
});

test('platform audit summary follows the remaining route findings instead of stale decorative-pill wording', () => {
  const audit = repo('docs/platform-completion-audit.md');

  assert.doesNotMatch(audit, /visual treatment on decorative or pill-heavy pages/i);
  assert.doesNotMatch(audit, /visual treatment on flagged P0 routes/i);
  assert.match(audit, /deployed browser QA for every route/i);
});

test('platform audit scans route-local extracted components for static dark-mode evidence', () => {
  const auditScript = repo('scripts/platform-completion-audit.mjs');
  const audit = repo('docs/platform-completion-audit.md');

  assert.match(auditScript, /routeSurfaceContent/);
  assert.doesNotMatch(audit, /`\/board`[^\n]+dark-mode relies mostly on layout/i);
  assert.doesNotMatch(audit, /`\/registers`[^\n]+dark-mode relies mostly on layout/i);
});

test('marketing navigation CTAs avoid pill-badge styling', () => {
  const desktopNav = app('(marketing)/layout.tsx');
  const mobileNav = app('(marketing)/MobileNav.tsx');

  assert.doesNotMatch(desktopNav, /rounded-full/);
  assert.doesNotMatch(desktopNav, /backdrop-blur-/);
  assert.doesNotMatch(mobileNav, /rounded-full/);
  assert.match(desktopNav, /rounded-md/);
  assert.match(mobileNav, /rounded-md/);
});

test('marketing feature copy avoids legal-certainty compliance claims', () => {
  const features = app('(marketing)/features/page.tsx');

  assert.doesNotMatch(features, /stay compliant/i);
  assert.match(features, /stay organised around compliance/i);
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
  assert.match(panelSrc, /statusPanelClassName/);
  assert.doesNotMatch(panelSrc, /rounded-lg border border-gray-200 bg-white p-4/);
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
  assert.match(cardsSrc, /statusPanelClassName/);
  assert.doesNotMatch(cardsSrc, /rounded-lg border border-gray-200 bg-white p-5/);
});

test('register financial control checklist uses HeroUI Checkbox controls', () => {
  const cardsSrc = dash('registers/register-compliance-cards.tsx');

  assert.match(cardsSrc, /Checkbox/);
  assert.match(cardsSrc, /from '@heroui\/react'/);
  assert.match(cardsSrc, /isSelected=\{checked\}/);
  assert.match(cardsSrc, /onValueChange=\{onChange\}/);
  assert.doesNotMatch(cardsSrc, /type="checkbox"/);
  assert.doesNotMatch(cardsSrc, /h-4 w-4 rounded border-gray-300/);
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
  assert.match(panelSrc, /statusPanelClassName/);
  assert.doesNotMatch(panelSrc, /rounded-lg border border-gray-200 bg-gray-50 p-3/);
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

test('team feedback uses the shared inline status primitive instead of route-local alert styling', () => {
  const src = dash('team/page.tsx');
  const states = component('ui/states.tsx');

  assert.match(states, /export function InlineStatus/);
  assert.match(src, /InlineStatus/);
  assert.match(src, /tone=\{error \? 'danger' : 'success'\}/);
  assert.doesNotMatch(src, /border-rose-200 bg-rose-50/);
  assert.doesNotMatch(src, /border-emerald-200 bg-emerald-50/);
});

test('phase 6C billing preserves Stripe redirect validation while clarifying plan gates', () => {
  const src = dash('billing/page.tsx');
  const imports: Array<[string, string[]]> = [
    ['@/components/ui/app-page', ['AppPage', 'AppSection']],
    ['@/components/ui/states', ['LoadingState', 'ErrorState', 'ReviewWarningState']],
    ['@/components/ui/status', ['ReviewFlag', 'StatusChip', 'StatusTile']],
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
  assert.match(src, /<StatusTile\b/);
  assert.doesNotMatch(src, /function GateTile/);
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
  assert.match(marketing, /dark:bg-gray-950\/9[05]/);
  assert.match(marketing, /dark:border-gray-800/);
  assert.match(marketing, /dark:bg-gray-950/);
  assert.match(marketing, /dark:\[&_button\]:text-gray-300/);
  assert.match(marketing, /dark:\[&_nav>a\]:text-gray-200/);

  const auth = app('(auth)/layout.tsx');
  assert.match(auth, /dark:bg-gray-950/);
  assert.match(auth, /dark:text-gray-100/);
});

test('root layout declares smooth scroll behavior expected by Next route transitions', () => {
  const layoutSrc = app('layout.tsx');
  const globalCss = app('globals.css');

  assert.match(globalCss, /scroll-behavior:\s*smooth/);
  assert.match(layoutSrc, /data-scroll-behavior="smooth"/);
});

test('public SEO and sharing URLs use the canonical production app origin', () => {
  const siteOrigin = lib('site-origin.ts');
  assert.match(siteOrigin, /export const PRODUCTION_WEB_ORIGIN = 'https:\/\/app\.charitypilot\.ie'/);
  assert.match(siteOrigin, /export function absoluteSiteUrl/);

  const surfaces = [
    ['root layout', app('layout.tsx')],
    ['sitemap', app('sitemap.ts')],
    ['robots', app('robots.ts')],
    ['JSON-LD', component('json-ld.tsx')],
    ['blog share links', app('(marketing)/blog/[slug]/page.tsx')],
  ] as const;

  for (const [label, src] of surfaces) {
    assert.match(src, /PRODUCTION_WEB_ORIGIN|absoluteSiteUrl/, `${label} should use the shared canonical origin helper`);
    assert.doesNotMatch(src, /https:\/\/charitypilot\.ie(?![.\w-])/, `${label} must not hard-code the apex production URL`);
  }

  assert.match(app('layout.tsx'), /metadataBase:\s*new URL\(PRODUCTION_WEB_ORIGIN\)/);
  assert.match(app('robots.ts'), /sitemap:\s*absoluteSiteUrl\('\/sitemap\.xml'\)/);
  assert.match(component('json-ld.tsx'), /mainEntityOfPage:\s*absoluteSiteUrl\(`\/blog\/\$\{slug\}`\)/);
  assert.match(app('(marketing)/blog/[slug]/page.tsx'), /const canonicalUrl = absoluteSiteUrl\(`\/blog\/\$\{meta\.slug\}`\)/);
});

test('dashboard primary actions use the shared action button styling', () => {
  const actionButtonPath = join(WEB, 'src', 'components', 'ui', 'action-button.tsx');
  assert.ok(existsSync(actionButtonPath), 'shared action button helper should exist');
  const actionButton = readFileSync(actionButtonPath, 'utf8');

  assert.match(actionButton, /primaryActionButtonClassName/);
  assert.match(actionButton, /dark:bg-teal-bright/);
  assert.match(actionButton, /dark:text-gray-950/);

  const dashboardFiles = [
    'board/page.tsx',
    'board/board-member-list-panel.tsx',
    'board/board-member-modal.tsx',
    'billing/page.tsx',
    'compliance/page.tsx',
    'compliance/[principleId]/page.tsx',
    'dashboard/page.tsx',
    'deadlines/page.tsx',
    'deadlines/deadline-form-modal.tsx',
    'deadlines/deadline-list-panel.tsx',
    'documents/page.tsx',
    'documents/document-list-panel.tsx',
    'documents/document-upload-modal.tsx',
    'documents/document-link-modal.tsx',
    'export/page.tsx',
    'organisation/page.tsx',
    'organisation/organisation-profile-form.tsx',
    'registers/page.tsx',
    'registers/register-compliance-cards.tsx',
    'registers/register-record-lists.tsx',
    'registers/register-record-modal.tsx',
    'regulator/page.tsx',
    'team/page.tsx',
  ];

  for (const file of dashboardFiles) {
    const src = dash(file);
    assert.doesNotMatch(
      src,
      /className="[^"]*bg-teal-primary text-white[^"]*"/,
      `${file} should not keep route-local primary button classes`,
    );
  }
});

test('public and auth primary CTAs use the shared action button styling', () => {
  const ctaFiles = [
    '(auth)/accept-invite/page.tsx',
    '(auth)/forgot-password/page.tsx',
    '(auth)/login/page.tsx',
    '(auth)/register/page.tsx',
    '(auth)/reset-password/page.tsx',
    '(auth)/verify-email/page.tsx',
    '(marketing)/layout.tsx',
    '(marketing)/MobileNav.tsx',
    '(marketing)/pricing/page.tsx',
  ];

  for (const file of ctaFiles) {
    const src = app(file);
    assert.match(
      src,
      /primaryActionButtonClassName|primaryActionButtonClasses/,
      `${file} should import shared primary action styling`,
    );
    assert.doesNotMatch(
      src,
      /className="[^"]*bg-teal-primary text-white[^"]*"/,
      `${file} should not keep route-local primary CTA classes`,
    );
    assert.doesNotMatch(
      src,
      /\? 'bg-teal-primary text-white'/,
      `${file} should not keep conditional route-local primary CTA classes`,
    );
  }
});

test('remaining public action controls use shared action button styling', () => {
  const backToTop = component('back-to-top.tsx');
  const blogPost = app('(marketing)/blog/[slug]/page.tsx');
  const blogClient = app('(marketing)/blog/BlogClient.tsx');

  assert.match(backToTop, /primaryActionButtonClasses/);
  assert.doesNotMatch(backToTop, /fixed bottom-6 right-6[^"]*bg-teal-primary text-white/);

  assert.match(blogPost, /primaryActionButtonClasses/);
  assert.doesNotMatch(blogPost, /inline-flex items-center justify-center rounded-lg bg-teal-primary/);

  assert.match(blogClient, /primaryActionButtonClasses/);
  assert.doesNotMatch(blogClient, /className="bg-teal-primary px-6 font-semibold text-white/);
});
