'use client';

import { useDocumentTitle } from '@/lib/use-title';
import { Button } from '@heroui/react';
import { Plus } from 'lucide-react';
import { AppPage } from '@/components/ui/app-page';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { DeadlineDeleteModal } from './deadline-delete-modal';
import { DeadlineFormModal } from './deadline-form-modal';
import { DeadlineListPanel } from './deadline-list-panel';
import { DeadlineOverviewPanels } from './deadline-overview-panels';
import { DeadlineProfilePromptsPanel } from './deadline-profile-prompts';
import { useDeadlinesWorkflow } from './use-deadlines-workflow';

export default function DeadlinesPage() {
  useDocumentTitle('Deadlines');
  const {
    conditionalDeadlinePrompts,
    conditionalProfile,
    deadlineDataReady,
    deadlineModal,
    deleteDeadlineId,
    deleteModal,
    deletingDeadlineId,
    editingDeadline,
    fetchDeadlines,
    fetchOrganisationProfile,
    formDescription,
    formDisabledReason,
    formDueDate,
    formError,
    formTitle,
    handleDeleteDeadline,
    handleSaveDeadline,
    loading,
    loadError,
    missingConditionalDeadlineCount,
    openAdd,
    openDelete,
    openEdit,
    organisationProfileError,
    resetForm,
    saving,
    scheduleConditionalDeadline,
    selectedDeleteDeadline,
    setDeleteDeadlineId,
    setFormDescription,
    setFormDueDate,
    setFormTitle,
    sortedDeadlines,
    summary,
    toggleComplete,
    toggleDeadlineId,
  } = useDeadlinesWorkflow();

  return (
    <AppPage
      eyebrow="Governance calendar"
      title="Deadline Tracker"
      description="Keep annual returns, board approvals, funder dates, and internal review deadlines visible before they become filing problems."
      actions={(
        <Button className={primaryActionButtonClassName} onPress={openAdd}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add deadline
        </Button>
      )}
    >
      {deadlineDataReady && (
        <DeadlineOverviewPanels summary={summary} />
      )}

      {deadlineDataReady && (
        <DeadlineProfilePromptsPanel
          conditionalProfile={conditionalProfile}
          prompts={conditionalDeadlinePrompts}
          missingCount={missingConditionalDeadlineCount}
          error={organisationProfileError}
          saving={saving}
          onRetry={fetchOrganisationProfile}
          onSchedule={scheduleConditionalDeadline}
        />
      )}

      <DeadlineListPanel
        loading={loading}
        loadError={loadError}
        sortedDeadlines={sortedDeadlines}
        toggleDeadlineId={toggleDeadlineId}
        deletingDeadlineId={deletingDeadlineId}
        saving={saving}
        onRetry={() => fetchDeadlines(true)}
        onAdd={openAdd}
        onEdit={openEdit}
        onDelete={openDelete}
        onToggleComplete={toggleComplete}
      />

      <DeadlineFormModal
        isOpen={deadlineModal.isOpen}
        onOpenChange={deadlineModal.onOpenChange}
        editingDeadline={editingDeadline}
        formError={formError}
        formTitle={formTitle}
        setFormTitle={setFormTitle}
        formDescription={formDescription}
        setFormDescription={setFormDescription}
        formDueDate={formDueDate}
        setFormDueDate={setFormDueDate}
        formDisabledReason={formDisabledReason}
        resetForm={resetForm}
        handleSaveDeadline={handleSaveDeadline}
        saving={saving}
      />

      <DeadlineDeleteModal
        isOpen={deleteModal.isOpen}
        onOpenChange={deleteModal.onOpenChange}
        selectedDeadline={selectedDeleteDeadline}
        deleting={Boolean(deletingDeadlineId) && deletingDeadlineId === deleteDeadlineId}
        deleteDisabled={!deleteDeadlineId || Boolean(deletingDeadlineId)}
        onCancel={() => setDeleteDeadlineId(null)}
        onDelete={handleDeleteDeadline}
      />
    </AppPage>
  );
}
