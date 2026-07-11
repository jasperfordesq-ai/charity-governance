import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const exportSource = (file: string) =>
  readFileSync(join(process.cwd(), 'src', 'app', '(dashboard)', 'export', file), 'utf8')
    .replace(/\r\n/g, '\n');

test('export workflow loads each year sequence-safely and fails approval closed without readiness', () => {
  const workflow = exportSource('use-export-workflow.ts');

  assert.match(workflow, /const loadRequestSeq = useRef\(0\)/);
  assert.match(workflow, /const requestSeq = \+\+loadRequestSeq\.current/);
  assert.match(workflow, /if \(requestSeq !== loadRequestSeq\.current\) return false/);
  assert.match(workflow, /Promise\.allSettled/);
  assert.match(workflow, /setReadinessState\('unavailable'\)/);
  assert.match(workflow, /if \(!freshApprovalReadiness\)/);
  assert.match(workflow, /expectedRevision: submittedSignoff\.revision/);
  assert.match(workflow, /expectedEvidenceHash: freshApprovalReadiness\?\.evidenceHash/);
});

test('sign-off saves preserve newer live drafts and only report Saved for the submitted generation', () => {
  const workflow = exportSource('use-export-workflow.ts');

  assert.match(workflow, /const signoffFormRef = useRef<ExportSignoffForm>/);
  assert.match(workflow, /const signoffDraftGeneration = useRef\(0\)/);
  assert.match(workflow, /const submittedForm = signoffFormRef\.current/);
  assert.match(workflow, /const submittedGeneration = signoffDraftGeneration\.current/);
  assert.match(workflow, /if \(isCurrentSignoffDraftGeneration\(submittedGeneration, signoffDraftGeneration\.current\)\)/);
  assert.match(workflow, /Earlier sign-off changes saved\. Newer edits remain unsaved\./);
  assert.doesNotMatch(workflow, /status: signoffForm\.status/);
});

test('sign-off conflicts preserve the latest live draft, fail refresh safely, and require explicit review', () => {
  const workflow = exportSource('use-export-workflow.ts');
  const panel = exportSource('export-board-approval-panel.tsx');

  assert.match(workflow, /COMPLIANCE_SIGNOFF_REVISION_CONFLICT/);
  assert.match(workflow, /COMPLIANCE_APPROVAL_EVIDENCE_CHANGED/);
  assert.match(workflow, /await loadExportState\(true\)/);
  assert.doesNotMatch(workflow, /const preservedForm = signoffForm/);
  assert.doesNotMatch(workflow, /setSignoffForm\(preservedForm\)/);
  assert.match(workflow, /if \(!preserveForm\) \{[\s\S]*setLoadError\(/);
  assert.match(workflow, /The latest saved position could not be refreshed, so saving remains blocked/);
  assert.match(workflow, /retrySignoffConflictRefresh/);
  assert.match(workflow, /setSignoffConflictRefreshFailed\(!refreshed\)/);
  assert.match(workflow, /setSignoffReviewRequired\(true\)/);
  assert.match(panel, /I have reviewed the refreshed position/);
  assert.match(panel, /Retry loading latest position/);
  assert.match(panel, /Your local form remains preserved/);
  assert.match(panel, /isDisabled=\{!signoffDirty \|\| approvalSaveBlocked \|\| signoffReviewRequired\}/);
});

test('persisted approval drives report status and current and retained exports are separate', () => {
  const workflow = exportSource('use-export-workflow.ts');
  const controls = exportSource('export-controls-panel.tsx');
  const page = exportSource('page.tsx');

  assert.match(workflow, /persistedApprovalPresentation\(signoff, approvalReadiness\)/);
  assert.match(workflow, /handleExport\('current'\)/);
  assert.match(workflow, /handleExport\('approved', signoff\?\.latestApproval\?\.id\)/);
  assert.match(workflow, /version,/);
  assert.match(workflow, /snapshotId/);
  assert.match(workflow, /await api\.get\('\/export\/compliance-report'/);
  assert.match(workflow, /responseType: 'blob'/);
  assert.match(workflow, /openAuthenticatedReport/);
  assert.doesNotMatch(workflow, /api\.getUri/);
  assert.doesNotMatch(page, /signoffStatusLabels\[signoffForm\.status\]/);
  assert.match(controls, /Generate Compliance Report \(working copy\)/);
  assert.match(controls, /Open latest approved snapshot/);
  assert.match(controls, /latestApproval\.snapshotHash/);
});

test('dirty sign-off edits block year and SPA navigation until explicitly discarded', () => {
  const workflow = exportSource('use-export-workflow.ts');
  const panel = exportSource('export-board-approval-panel.tsx');
  const modal = exportSource('export-navigation-confirm-modal.tsx');
  const page = exportSource('page.tsx');

  assert.match(workflow, /isComplianceSignoffDirty\(signoff, signoffForm\)/);
  assert.match(workflow, /Save or discard the unsaved sign-off changes before changing reporting year/);
  assert.match(workflow, /window\.addEventListener\('beforeunload', warnIfSignoffDirty\)/);
  assert.match(workflow, /document\.addEventListener\('click', interceptSignoffNavigation, true\)/);
  assert.match(workflow, /const signoffNavigationBlocked = canManageSignoff && \(signoffDirty \|\| signoffReviewRequired\)/);
  assert.match(workflow, /replaceSignoffForm\(complianceSignoffToDraft\(signoff\)\)/);
  assert.match(panel, /Discard changes/);
  assert.match(panel, /signoffSaveStatus/);
  assert.match(modal, /Discard changes and leave/);
  assert.match(modal, /ariaLabel="Confirm leaving unsaved board sign-off"/);
  assert.match(page, /<ExportNavigationConfirmModal/);
});

test('member exports stay available while sign-off editing and dirty navigation fail closed', () => {
  const workflow = exportSource('use-export-workflow.ts');
  const panel = exportSource('export-board-approval-panel.tsx');
  const controls = exportSource('export-controls-panel.tsx');

  assert.match(workflow, /const roleCanManageSignoff = canManageGovernance\(user\?\.role\)/);
  assert.match(workflow, /const canManageSignoff = roleCanManageSignoff && !signoffEditingRevoked/);
  assert.match(workflow, /if \(!canManageSignoff\) return;/);
  assert.match(workflow, /const signoffDirty = canManageSignoff && isComplianceSignoffDirty/);
  assert.match(workflow, /const signoffNavigationBlocked = canManageSignoff &&/);
  assert.match(workflow, /handleExportCurrent: \(\) => handleExport\('current'\)/);
  assert.match(workflow, /handleExportApproved: \(\) => handleExport\('approved'/);
  assert.match(workflow, /result\.status === 'error'[\s\S]*?failClosedOnForbidden\(result\.error\)/);

  const forbiddenStart = workflow.indexOf('const failClosedOnForbidden');
  const forbiddenEnd = workflow.indexOf('\n\n  useEffect', forbiddenStart);
  const forbiddenHandler = workflow.slice(forbiddenStart, forbiddenEnd);
  assert.match(forbiddenHandler, /isApiForbiddenError\(error\)/);
  assert.match(forbiddenHandler, /setSignoffEditingRevoked\(true\)/);
  assert.match(forbiddenHandler, /clearPrivilegedSignoffState\(\)/);
  assert.match(forbiddenHandler, /void refreshUser\(\)/);
  assert.doesNotMatch(forbiddenHandler, /router\.(?:push|replace)/);

  assert.match(panel, /Only an Owner or Admin can change the approval record/);
  assert.match(panel, /isDisabled=\{!canManageSignoff\}/);
  assert.match(panel, /isReadOnly=\{!canManageSignoff\}/);
  assert.match(panel, /<StatusChip tone="neutral">View only<\/StatusChip>/);
  assert.match(controls, /Generate Compliance Report \(working copy\)/);
  assert.match(controls, /Open latest approved snapshot/);
});

test('dashboard sign-off card never treats an invalidated APPROVED status as current', () => {
  const dashboard = readFileSync(
    join(process.cwd(), 'src', 'app', '(dashboard)', 'dashboard', 'dashboard-summary-cards.tsx'),
    'utf8',
  );

  assert.match(dashboard, /signoffStatus === ComplianceSignoffStatus\.APPROVED && signoff\?\.approvalCurrent/);
  assert.match(dashboard, /label: 'Reapproval required'/);
  assert.match(dashboard, /approvalCurrent && signoff\?\.minuteReference/);
  assert.match(dashboard, /Retained approved snapshot/);
});
