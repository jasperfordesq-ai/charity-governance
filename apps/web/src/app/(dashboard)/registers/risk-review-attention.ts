import type { RiskRecordResponse } from '@charitypilot/shared';

export function riskReviewAttention(risks: RiskRecordResponse[], today: string) {
  const active = risks.filter((risk) => risk.status !== 'CLOSED');
  return {
    due: active.filter((risk) => risk.reviewDate && risk.reviewDate.slice(0, 10) <= today)
      .sort((left, right) => left.reviewDate!.localeCompare(right.reviewDate!)),
    unscheduled: active.filter((risk) => !risk.reviewDate),
  };
}
