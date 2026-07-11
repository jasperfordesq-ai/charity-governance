'use client';

import { useDocumentTitle } from '@/lib/use-title';
import { Button } from '@heroui/react';
import { Plus } from 'lucide-react';
import { AppPage } from '@/components/ui/app-page';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { DeadlineDeleteModal } from './deadline-delete-modal';
import { DeadlineCompletionModal } from './deadline-completion-modal';
import { DeadlineFormModal } from './deadline-form-modal';
import { DeadlineListPanel } from './deadline-list-panel';
import { DeadlineOverviewPanels } from './deadline-overview-panels';
import { DeadlineProfilePromptsPanel } from './deadline-profile-prompts';
import { DeadlineHistoryPanel } from './deadline-history-panel';
import { DeadlineReminderHistoryPanel } from './deadline-reminder-history-panel';
import { useDeadlinesWorkflow } from './use-deadlines-workflow';

export default function DeadlinesPage() {
  useDocumentTitle('Deadlines');
  const {
    canManage,
    conditionalDeadlinePrompts,
    conditionalProfile,
    completionModal,
    confirmGeneratedCompletion,
    cancelGeneratedCompletion,
    deadlineDataReady,
    deadlineModal,
    deadlineHistory,
    deadlineSearchText,
    deleteDeadlineId,
    deleteModal,
    deletingDeadlineId,
    editingDeadline,
    fetchDeadlineHistory,
    fetchDeadlines,
    fetchOrganisationProfile,
    fetchReminderHistory,
    formDescription,
    formDisabledReason,
    formDueDate,
    formError,
    formTitle,
    handleDeleteDeadline,
    handleCompletionModalOpenChange,
    handleSaveDeadline,
    historyError,
    historyHasMore,
    historyLoading,
    historyPage,
    loading,
    loadError,
    missingConditionalDeadlineCount,
    openAdd,
    openDelete,
    openEdit,
    organisationProfileError,
    pendingGeneratedCompletion,
    reminderHistory,
    reminderHistoryError,
    reminderHistoryHasMore,
    reminderHistoryLoading,
    reminderHistoryPage,
    reminderHistoryTotal,
    resetForm,
    saving,
    scheduleConditionalDeadline,
    selectedDeleteDeadline,
    setDeleteDeadlineId,
    setDeadlineSearchText,
    setFormDescription,
    setFormDueDate,
    setFormTitle,
    sortedDeadlines,
    summary,
    toggleComplete,
    toggleDeadlineId,
    visibleDeadlines,
  } = useDeadlinesWorkflow();

  return (
    <AppPage
      eyebrow="Governance calendar"
      title="Deadline Tracker"
      description="Keep annual returns, board approvals, funder dates, and internal review deadlines visible before they become filing problems."
      actions={canManage ? (
        <Button className={primaryActionButtonClassName} onPress={openAdd}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add deadline
        </Button>
      ) : undefined}
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
          canManage={canManage}
          onRetry={fetchOrganisationProfile}
          onSchedule={scheduleConditionalDeadline}
        />
      )}

      <DeadlineListPanel
        loading={loading}
        loadError={loadError}
        sortedDeadlines={visibleDeadlines}
        deadlineSearchText={deadlineSearchText}
        toggleDeadlineId={toggleDeadlineId}
        deletingDeadlineId={deletingDeadlineId}
        saving={saving}
        canManage={canManage}
        onRetry={() => fetchDeadlines(true)}
        onAdd={openAdd}
        onEdit={openEdit}
        onDelete={openDelete}
        onToggleComplete={toggleComplete}
        onSearchTextChange={setDeadlineSearchText}
      />

      <DeadlineHistoryPanel
        history={deadlineHistory}
        loading={historyLoading}
        error={historyError}
        hasMore={historyHasMore}
        onRetry={() => fetchDeadlineHistory(1)}
        onLoadMore={() => fetchDeadlineHistory(historyPage + 1)}
      />

      {canManage ? (
        <DeadlineReminderHistoryPanel
          reminders={reminderHistory}
          deadlines={[...sortedDeadlines, ...deadlineHistory]}
          loading={reminderHistoryLoading}
          error={reminderHistoryError}
          hasMore={reminderHistoryHasMore}
          total={reminderHistoryTotal}
          onRetry={() => fetchReminderHistory(1)}
          onLoadMore={() => fetchReminderHistory(reminderHistoryPage + 1)}
        />
      ) : null}

      <DeadlineFormModal
        isOpen={canManage && deadlineModal.isOpen}
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
        isOpen={canManage && deleteModal.isOpen}
        onOpenChange={deleteModal.onOpenChange}
        selectedDeadline={selectedDeleteDeadline}
        deleting={Boolean(deletingDeadlineId) && deletingDeadlineId === deleteDeadlineId}
        deleteDisabled={!deleteDeadlineId || Boolean(deletingDeadlineId)}
        onCancel={() => setDeleteDeadlineId(null)}
        onDelete={handleDeleteDeadline}
      />

      <DeadlineCompletionModal
        isOpen={canManage && completionModal.isOpen}
        onOpenChange={handleCompletionModalOpenChange}
        deadline={pendingGeneratedCompletion}
        confirming={Boolean(toggleDeadlineId) && toggleDeadlineId === pendingGeneratedCompletion?.id}
        onCancel={cancelGeneratedCompletion}
        onConfirm={confirmGeneratedCompletion}
      />
    </AppPage>
  );
}
