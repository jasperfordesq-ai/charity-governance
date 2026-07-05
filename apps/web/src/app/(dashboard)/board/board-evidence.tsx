'use client';

import { AppSection } from '@/components/ui/app-page';
import { EvidenceChip, ReviewFlag, statusPanelClassName } from '@/components/ui/status';
import type { BoardMemberResponse } from '@charitypilot/shared';

const trusteeEvidencePrompts = [
  {
    title: 'Code of conduct',
    detail: 'Signed conduct records support standards 2.3 and 5.7.',
  },
  {
    title: 'Induction',
    detail: 'Induction dates support standards 5.6, 5.7, and succession evidence.',
  },
  {
    title: 'Term review',
    detail: 'Appointment and term dates help trustees review the suggested nine-year limit.',
  },
];

const yearsServed = (appointedDate: string) => {
  const appointed = new Date(appointedDate);
  const now = new Date();
  return (now.getTime() - appointed.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
};

export const getTrusteeEvidence = (member: BoardMemberResponse) => {
  const years = yearsServed(member.appointedDate);
  return {
    years,
    nearNineYears: years >= 8,
    overNineYears: years >= 9,
  };
};

export function TrusteeEvidencePromptCards() {
  return (
    <AppSection
      title="Trustee evidence prompts"
      description="Use these prompts to keep conduct, induction, and trustee term evidence ready for board review."
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {trusteeEvidencePrompts.map((prompt) => (
          <div key={prompt.title} className={statusPanelClassName('neutral', 'p-4')}>
            <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-50">{prompt.title}</h3>
            <p className="mt-2 text-xs leading-5 text-gray-600 dark:text-gray-300">{prompt.detail}</p>
          </div>
        ))}
      </div>
    </AppSection>
  );
}

export function BoardEvidenceChips({ member }: { member: BoardMemberResponse }) {
  const evidence = getTrusteeEvidence(member);

  return (
    <div className="flex flex-wrap gap-2">
      <EvidenceChip status={member.conductSigned ? 'ready' : 'missing'}>
        {member.conductSigned ? 'Conduct signed' : 'Conduct missing'}
      </EvidenceChip>
      <EvidenceChip status={member.inductionCompleted ? 'ready' : 'missing'}>
        {member.inductionCompleted ? 'Induction done' : 'Induction pending'}
      </EvidenceChip>
      {evidence.nearNineYears ? (
        <ReviewFlag tone={evidence.overNineYears ? 'blocked' : 'needs-review'}>
          {Math.floor(evidence.years)}y term review
        </ReviewFlag>
      ) : null}
    </div>
  );
}
