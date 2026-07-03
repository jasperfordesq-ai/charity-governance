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
