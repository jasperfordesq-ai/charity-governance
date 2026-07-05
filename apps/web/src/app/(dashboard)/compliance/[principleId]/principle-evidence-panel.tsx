'use client';

import { ReviewWarningState } from '@/components/ui/states';
import { EvidenceReadiness } from '@/components/governance/evidence-readiness';

type MissingExplanation = {
  standardId: string;
  standardCode: string;
  status: 'NOT_APPLICABLE' | 'EXPLAIN';
};

type PrincipleMatrixEntry = {
  evidenceRequired: string[];
  userTask: string;
};

export function PrincipleEvidencePanel({
  matrixEntries,
  missingExplanations,
}: {
  matrixEntries: PrincipleMatrixEntry[];
  missingExplanations: MissingExplanation[];
}) {
  return (
    <>
      {missingExplanations.length > 0 && (
        <ReviewWarningState
          title="This principle has approval blockers"
          description={`${missingExplanations.length} standard${missingExplanations.length === 1 ? '' : 's'} in this principle need explanations before annual board approval can be saved.`}
        />
      )}

      <EvidenceReadiness
        title="Principle evidence prompts"
        description="Use these prompts to decide what trustee evidence should be recorded for this principle. Applicability depends on your charity profile and trustee judgement."
        prompts={matrixEntries.map((entry) => ({
          label: entry.userTask,
          status: 'review' as const,
          note: entry.evidenceRequired.join(', '),
        }))}
        flags={[
          { label: 'Evidence-led review aid', tone: 'needs-review' },
          { label: 'Not legal advice', tone: 'draft' },
        ]}
      />
    </>
  );
}
