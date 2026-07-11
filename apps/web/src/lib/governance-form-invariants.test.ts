import assert from 'node:assert/strict';
import test from 'node:test';
import { AnnualReportFilingStatus } from '@charitypilot/shared';
import {
  annualReportFilingInvariantReason,
  boardMemberFormInvariantReason,
  fundraisingFormInvariantReason,
} from './governance-form-invariants';

const validBoardState = {
  appointedDate: '2026-04-01',
  termEndDate: '2029-04-01',
  conductSigned: true,
  conductSignedDate: '2026-04-02',
  inductionCompleted: true,
  inductionDate: '2026-04-03',
};

test('board form rejects reversed terms and completed evidence without its date', () => {
  assert.equal(boardMemberFormInvariantReason(validBoardState), '');
  assert.equal(
    boardMemberFormInvariantReason({ ...validBoardState, termEndDate: '2026-03-31' }),
    'Set the term end date on or after the appointment date.',
  );
  assert.equal(
    boardMemberFormInvariantReason({ ...validBoardState, conductSignedDate: '' }),
    'Add the conduct signing date before marking the code of conduct as signed.',
  );
  assert.equal(
    boardMemberFormInvariantReason({ ...validBoardState, inductionDate: '' }),
    'Add the induction date before marking induction as completed.',
  );
});

test('board form keeps optional evidence dates valid when their completion flags are false', () => {
  assert.equal(boardMemberFormInvariantReason({
    ...validBoardState,
    termEndDate: '',
    conductSigned: false,
    conductSignedDate: '',
    inductionCompleted: false,
    inductionDate: '',
  }), '');
  assert.equal(boardMemberFormInvariantReason({ ...validBoardState, termEndDate: validBoardState.appointedDate }), '');
});

test('fundraising form compares dates only when both ends of the range are present', () => {
  assert.equal(fundraisingFormInvariantReason('2026-06-02', '2026-06-01'), 'Set the fundraising end date on or after the start date.');
  assert.equal(fundraisingFormInvariantReason('2026-06-01', '2026-06-01'), '');
  assert.equal(fundraisingFormInvariantReason('2026-06-01', ''), '');
  assert.equal(fundraisingFormInvariantReason('', '2026-06-02'), '');
});

test('Annual Report form requires a filing date only for Filed status', () => {
  assert.equal(
    annualReportFilingInvariantReason(AnnualReportFilingStatus.FILED, null),
    'Add the filed date before saving an Annual Report status of Filed.',
  );
  assert.equal(annualReportFilingInvariantReason(AnnualReportFilingStatus.FILED, '2026-10-31'), '');
  assert.equal(annualReportFilingInvariantReason(AnnualReportFilingStatus.IN_PROGRESS, null), '');
  assert.equal(annualReportFilingInvariantReason(AnnualReportFilingStatus.BOARD_APPROVED, '2026-10-31'), '');
});
