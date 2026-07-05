'use client';

import { Button } from '@heroui/react';
import { ChevronLeft } from 'lucide-react';
import { useDocumentTitle } from '@/lib/use-title';
import { AppPage } from '@/components/ui/app-page';
import { PrincipleEvidencePanel } from './principle-evidence-panel';
import { PrincipleNavigationConfirmModal } from './principle-navigation-confirm-modal';
import { PrincipleLoadingState, PrincipleLoadErrorState } from './principle-detail-states';
import { PrincipleStandardList } from './principle-standard-list';
import { usePrincipleDetailWorkflow } from './use-principle-detail-workflow';

export default function PrincipleDetailPage() {
  useDocumentTitle('Compliance Principle');

  const {
    currentYear,
    flushSave,
    formState,
    leaveWithoutSaving,
    loadError,
    loading,
    navigateBackToCompliance,
    navigationConfirmBusy,
    navigationConfirmError,
    navigationConfirmOpen,
    principle,
    principleMatrixEntries,
    principleMissingExplanations,
    retrySave,
    saveState,
    saveAndContinueNavigation,
    stayOnCompliancePage,
    updateField,
  } = usePrincipleDetailWorkflow();

  if (loading) {
    return <PrincipleLoadingState currentYear={currentYear} />;
  }

  if (!principle) {
    return (
      <PrincipleLoadErrorState
        currentYear={currentYear}
        loadError={loadError}
        onBack={navigateBackToCompliance}
      />
    );
  }

  return (
    <>
      <AppPage
        eyebrow={`Reporting year ${currentYear}`}
        title={`Principle ${principle.number}: ${principle.title}`}
        description={(
          <>
            {principle.description}{' '}
            Changes auto-save after 800ms. Evidence prompts are review aids and not legal advice.
          </>
        )}
        actions={(
          <Button
            type="button"
            size="sm"
            variant="light"
            onPress={navigateBackToCompliance}
            className="mb-3 px-1 text-teal-primary dark:text-teal-bright"
            startContent={<ChevronLeft className="w-4 h-4" aria-hidden="true" />}
          >
            Back to Compliance
          </Button>
        )}
      >
        <PrincipleEvidencePanel
          matrixEntries={principleMatrixEntries}
          missingExplanations={principleMissingExplanations}
        />

        <PrincipleStandardList
          standards={principle.standards}
          formState={formState}
          saveState={saveState}
          updateField={updateField}
          flushSave={flushSave}
          onRetrySave={retrySave}
        />
      </AppPage>
      <PrincipleNavigationConfirmModal
        isOpen={navigationConfirmOpen}
        isSaving={navigationConfirmBusy}
        saveError={navigationConfirmError}
        onKeepEditing={stayOnCompliancePage}
        onLeaveWithoutSaving={leaveWithoutSaving}
        onSaveAndContinue={saveAndContinueNavigation}
      />
    </>
  );
}
