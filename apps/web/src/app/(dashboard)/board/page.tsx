'use client';

import { useDocumentTitle } from '@/lib/use-title';
import { Button } from '@heroui/react';
import { Plus } from 'lucide-react';
import { AppPage } from '@/components/ui/app-page';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { TrusteeEvidencePromptCards } from './board-evidence';
import { BoardMemberListPanel } from './board-member-list-panel';
import { BoardMemberModal } from './board-member-modal';
import { BoardSummaryPanel } from './board-summary-panel';
import { useBoardWorkflow } from './use-board-workflow';

export default function BoardPage() {
  useDocumentTitle('Board Members');
  const {
    boardDataReady,
    canManage,
    displayMembers,
    editing,
    fetchMembers,
    formAppointed,
    formConductDate,
    formConductSigned,
    formDisabledReason,
    formEmail,
    formError,
    formInduction,
    formInductionDate,
    formName,
    formRole,
    formTermEnd,
    handleSave,
    loadError,
    loading,
    memberModal,
    mutatingMemberId,
    openAdd,
    openEdit,
    resetForm,
    saving,
    setFormAppointed,
    setFormConductDate,
    setFormConductSigned,
    setFormEmail,
    setFormInduction,
    setFormInductionDate,
    setFormName,
    setFormRole,
    setFormTermEnd,
    setShowInactive,
    showInactive,
    summary,
    toggleActive,
  } = useBoardWorkflow();

  return (
    <AppPage
      eyebrow="Trustee register"
      title="Board Members Register"
      description={canManage
        ? 'Maintain a review-ready trustee register with conduct, induction, appointment, and term evidence for Irish charity governance workflows.'
        : 'Review trustee conduct, induction, appointment, and term evidence in this read-only board register.'}
      actions={canManage ? (
        <Button className={primaryActionButtonClassName} onPress={openAdd}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add trustee
        </Button>
      ) : undefined}
    >
      {boardDataReady && (
        <BoardSummaryPanel summary={summary} />
      )}

      {boardDataReady && <TrusteeEvidencePromptCards />}

      <BoardMemberListPanel
        canManage={canManage}
        displayMembers={displayMembers}
        fetchMembers={fetchMembers}
        loadError={loadError}
        loading={loading}
        mutatingMemberId={mutatingMemberId}
        onAdd={openAdd}
        onEdit={openEdit}
        onToggleActive={toggleActive}
        saving={saving}
        setShowInactive={setShowInactive}
        showInactive={showInactive}
      />

      <BoardMemberModal
        accessDisabled={!canManage}
        isOpen={canManage && memberModal.isOpen}
        onOpenChange={memberModal.onOpenChange}
        editing={editing}
        formError={formError}
        formName={formName}
        setFormName={setFormName}
        formRole={formRole}
        setFormRole={setFormRole}
        formEmail={formEmail}
        setFormEmail={setFormEmail}
        formAppointed={formAppointed}
        setFormAppointed={setFormAppointed}
        formTermEnd={formTermEnd}
        setFormTermEnd={setFormTermEnd}
        formConductSigned={formConductSigned}
        setFormConductSigned={setFormConductSigned}
        formConductDate={formConductDate}
        setFormConductDate={setFormConductDate}
        formInduction={formInduction}
        setFormInduction={setFormInduction}
        formInductionDate={formInductionDate}
        setFormInductionDate={setFormInductionDate}
        formDisabledReason={formDisabledReason}
        resetForm={resetForm}
        handleSave={handleSave}
        saving={saving}
      />
    </AppPage>
  );
}
