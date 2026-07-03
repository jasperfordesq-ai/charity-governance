import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Concern: plan gating / tenant isolation / state integrity (UI). These guarantees are
// "page X correctly APPLIES already-unit-tested logic Y" (plan-feature detection, trusted
// outbound-URL allow-listing, double-submit guards). The logic itself is proven by its own
// unit test; this source-scan proves the page is wired to it, and fails the moment a page
// stops applying the guard. CJS-safe (reads source; loads no ESM/React modules).

const WEB = process.cwd(); // apps/web
const dash = (p: string) => readFileSync(join(WEB, 'src', 'app', '(dashboard)', p), 'utf8');
const app = (p: string) => readFileSync(join(WEB, 'src', 'app', p), 'utf8');
const component = (p: string) => readFileSync(join(WEB, 'src', 'components', p), 'utf8');

test('dashboard applies the plan-feature + subscription-lapse helpers (gracefully gates, never errors)', () => {
  const src = dash('dashboard/page.tsx');
  assert.match(src, /from '@\/lib\/plan-feature'/);
  assert.ok(src.includes('isPlanFeatureUnavailable'), 'hides the registers card on a plan denial');
  assert.ok(src.includes('isSubscriptionLapseError'), 'shows the subscription-lapse banner');
});

test('registers gates the whole page behind a Complete upsell on a plan-feature denial', () => {
  const src = dash('registers/page.tsx');
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
for (const file of DOUBLE_SUBMIT_GUARDED) {
  test(`${file} guards its primary mutation against double-submit (isLoading)`, () => {
    const src = dash(file);
    assert.match(src, /isLoading=\{/, `${file} must have an isLoading-guarded submit button`);
  });
}

test('documents blocks an oversize upload inline before any request (no wasted 4xx round-trip)', () => {
  const src = dash('documents/page.tsx');
  assert.match(src, /MAX_FILE_SIZE/);
});

test('organisation warns before discarding unsaved edits (no silent data loss)', () => {
  const src = dash('organisation/page.tsx');
  assert.match(src, /beforeunload/);
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

test('the per-standard compliance editor announces its save state (Saving / Saved / Save failed)', () => {
  const src = dash('compliance/[principleId]/page.tsx');
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
  assert.match(exportPage, /COMPLIANCE_APPROVAL_INCOMPLETE/);
  assert.match(exportPage, /fetchApprovalReadiness/);
  assert.match(exportPage, /freshApprovalReadiness/);
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
    imports: Array<[string, string[]]>;
    sourceTerms: string[];
    patterns?: RegExp[];
  }> = [
    {
      file: 'documents/page.tsx',
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
      imports: [
        ['@/components/ui/app-page', ['AppPage', 'AppSection']],
        ['@/components/ui/states', ['LoadingState', 'EmptyState', 'ErrorState']],
        ['@/components/ui/data-list', ['DataListTable', 'DataListItems']],
        ['@/components/ui/status', ['EvidenceChip', 'ReviewFlag', 'StatusChip']],
        ['@/components/ui/forms', ['FieldGroup', 'FormHint', 'ValidationSummary']],
      ],
      sourceTerms: [
        'mutatingMemberId',
        'Trustee evidence prompts',
        'table and mobile card views',
        'aria-live="polite"',
        'review-ready',
      ],
      patterns: [
        /isDisabled=\{[^}]*mutatingMemberId/,
        /<TableCell>\s*<div className="space-y-2">[\s\S]*?renderEvidenceChips\(member\)[\s\S]*?conductSignedDate[\s\S]*?inductionDate[\s\S]*?<\/div>\s*<\/TableCell>/,
        /apiErrorMessage/,
      ],
    },
    {
      file: 'organisation/page.tsx',
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

  for (const { file, imports, sourceTerms, patterns = [] } of expectations) {
    const src = dash(file);
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

test('phase 6C registers keeps Complete gating and adds operational review-ready UX primitives', () => {
  const src = dash('registers/page.tsx');
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
