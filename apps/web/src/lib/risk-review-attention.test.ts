import assert from 'node:assert/strict';
import test from 'node:test';
import type { RiskRecordResponse } from '@charitypilot/shared';
import { riskReviewAttention } from '../app/(dashboard)/registers/risk-review-attention';

const risk = (id: string, reviewDate: string | null, status = 'OPEN') =>
  ({ id, reviewDate, status } as RiskRecordResponse);

test('risk review attention uses each open risk review date without claiming that its control failed', () => {
  const result = riskReviewAttention([
    risk('future', '2026-10-01T00:00:00.000Z'),
    risk('today', '2026-09-29T00:00:00.000Z'),
    risk('older', '2026-08-01T00:00:00.000Z', 'MONITORING'),
    risk('unscheduled', null),
    risk('closed', '2026-01-01T00:00:00.000Z', 'CLOSED'),
  ], '2026-09-29');

  assert.deepEqual(result.due.map((item) => item.id), ['older', 'today']);
  assert.deepEqual(result.unscheduled.map((item) => item.id), ['unscheduled']);
});
