'use client';

import { Button } from '@heroui/react';
import { AppPage } from '@/components/ui/app-page';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { ErrorState, LoadingState } from '@/components/ui/states';

export function PrincipleLoadingState({ currentYear }: { currentYear: number }) {
  return (
    <AppPage
      eyebrow={`Reporting year ${currentYear}`}
      title="Loading principle"
      description="Preparing the standard editor and evidence prompts for this reporting year."
    >
      <LoadingState
        variant="page"
        title="Loading compliance principle"
        description="Checking standards, records, evidence prompts, and approval-readiness."
      />
    </AppPage>
  );
}

export function PrincipleLoadErrorState({
  currentYear,
  loadError,
  onBack,
}: {
  currentYear: number;
  loadError: string;
  onBack: () => void;
}) {
  return (
    <AppPage
      eyebrow={`Reporting year ${currentYear}`}
      title="Compliance principle"
      description="Open a valid Governance Code principle to edit standards, evidence, and explanations."
    >
      <ErrorState
        variant="page"
        title={loadError ? 'Compliance principle could not be loaded' : 'Principle not found'}
        description={loadError || 'This principle is not available for the current organisation workspace.'}
        action={(
          <Button className={primaryActionButtonClassName} onPress={onBack}>
            Back to Compliance
          </Button>
        )}
      />
    </AppPage>
  );
}
