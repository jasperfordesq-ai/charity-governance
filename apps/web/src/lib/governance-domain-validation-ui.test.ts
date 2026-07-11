import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dashboard = (...parts: string[]) =>
  readFileSync(join(process.cwd(), 'src', 'app', '(dashboard)', ...parts), 'utf8')
    .replace(/\r\n/g, '\n');

test('board save blocking is wired to the invariant reason and accessible conditional dates', () => {
  const workflow = dashboard('board', 'use-board-workflow.ts');
  const modal = dashboard('board', 'board-member-modal.tsx');

  assert.match(workflow, /boardMemberFormInvariantReason\(\{/);
  assert.match(workflow, /termEndDate: formTermEnd/);
  assert.match(workflow, /conductSignedDate: formConductDate/);
  assert.match(workflow, /inductionDate: formInductionDate/);
  assert.match(modal, /isRequired=\{formConductSigned\}/);
  assert.match(modal, /isRequired=\{formInduction\}/);
  assert.match(modal, /aria-describedby="board-disabled-hint"/);
  assert.match(modal, /submitDisabled=\{Boolean\(formDisabledReason\) \|\| saving \|\| accessDisabled\}/);
});

test('register forms block reversed fundraising dates and Filed status without evidence', () => {
  const workflow = dashboard('registers', 'use-registers-workflow.ts');
  const page = dashboard('registers', 'page.tsx');
  const cards = dashboard('registers', 'register-compliance-cards.tsx');
  const modal = dashboard('registers', 'register-record-modal.tsx');

  assert.match(workflow, /fundraisingFormInvariantReason\(form\.startDate, form\.endDate\)/);
  assert.match(workflow, /annualReportFilingInvariantReason\(annual\.filingStatus, annual\.filedDate\)/);
  assert.match(workflow, /annualFilingDisabledReason \|\| 'Refresh this reporting year before saving Annual Report readiness\.'/);
  assert.match(page, /saveDisabledReason=\{annualFilingDisabledReason\}/);
  assert.match(cards, /isRequired=\{annual\.filingStatus === AnnualReportFilingStatus\.FILED\}/);
  assert.match(cards, /id="annual-filing-evidence-hint"/);
  assert.match(cards, /isDisabled=\{saving \|\| saveDisabled\}/);
  assert.match(modal, /submitDisabled=\{!canManage \|\| Boolean\(formDisabledReason\) \|\| saving\}/);
});
