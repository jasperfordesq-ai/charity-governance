'use client';

import { logClientError } from '@/lib/client-logger';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import {
  Button,
  useDisclosure,
} from '@heroui/react';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { apiErrorMessage, isApiNotFoundError } from '@/lib/errors';
import { useToast } from '@/components/toast';
import { AppPage } from '@/components/ui/app-page';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { DeadlineDeleteModal } from './deadline-delete-modal';
import { DeadlineFormModal } from './deadline-form-modal';
import { DeadlineListPanel, summarizeDeadlines } from './deadline-list-panel';
import { DeadlineOverviewPanels } from './deadline-overview-panels';
import { DeadlineProfilePromptsPanel, buildDeadlineProfilePrompts } from './deadline-profile-prompts';
import type { CreateDeadlineRequest, DeadlineResponse, OrganisationResponse, UpdateDeadlineRequest } from '@charitypilot/shared';

const dateInDays = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

export default function DeadlinesPage() {
  useDocumentTitle('Deadlines');
  const [deadlines, setDeadlines] = useState<DeadlineResponse[]>([]);
  const [organisation, setOrganisation] = useState<OrganisationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [organisationProfileError, setOrganisationProfileError] = useState('');
  const [toggleDeadlineId, setToggleDeadlineId] = useState<string | null>(null);
  const [deleteDeadlineId, setDeleteDeadlineId] = useState<string | null>(null);
  const [deletingDeadlineId, setDeletingDeadlineId] = useState<string | null>(null);

  const deadlineModal = useDisclosure();
  const deleteModal = useDisclosure();
  const [editingDeadline, setEditingDeadline] = useState<DeadlineResponse | null>(null);
  const [formTitle, setFormTitle] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formDueDate, setFormDueDate] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const fetchDeadlines = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    setLoadError('');
    try {
      const res = await api.get('/deadlines');
      setDeadlines(res.data?.data ?? res.data ?? []);
    } catch (err) {
      const message = apiErrorMessage(err, 'Deadlines could not be loaded. Please try again.');
      logClientError('Failed to load deadlines', err);
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchOrganisationProfile = useCallback(async () => {
    setOrganisationProfileError('');
    try {
      const res = await api.get('/organisations');
      setOrganisation(res.data?.data ?? res.data ?? null);
    } catch (err) {
      if (isApiNotFoundError(err)) {
        setOrganisation(null);
        return;
      }
      const message = apiErrorMessage(err, 'Organisation profile could not be loaded for conditional review dates.');
      logClientError('Failed to load organisation profile for deadline prompts', err);
      setOrganisationProfileError(message);
    }
  }, []);

  useEffect(() => {
    fetchDeadlines(true);
    fetchOrganisationProfile();
  }, [fetchDeadlines, fetchOrganisationProfile]);

  const sortedDeadlines = useMemo(() => {
    return [...deadlines].sort((a, b) => {
      if (a.isComplete !== b.isComplete) return a.isComplete ? 1 : -1;
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    });
  }, [deadlines]);

  const summary = useMemo(() => summarizeDeadlines(sortedDeadlines), [sortedDeadlines]);

  const deadlineSearchText = useMemo(() => {
    return deadlines
      .map((deadline) => `${deadline.title} ${deadline.description ?? ''}`.toLowerCase())
      .join(' ');
  }, [deadlines]);

  const conditionalProfile = organisation?.conditionalObligationProfile ?? null;

  const conditionalDeadlinePrompts = useMemo(() => {
    return buildDeadlineProfilePrompts(organisation?.conditionalObligationProfile, deadlineSearchText);
  }, [deadlineSearchText, organisation?.conditionalObligationProfile]);

  const missingConditionalDeadlineCount = conditionalDeadlinePrompts.filter((item) => !item.reviewDateAlreadyScheduled).length;
  const deadlineDataReady = !loading && !loadError;

  const formDisabledReason = useMemo(() => {
    if (!formTitle.trim()) return 'Add a title before saving.';
    if (!formDueDate) return 'Choose the due date before saving.';
    return '';
  }, [formDueDate, formTitle]);
  const selectedDeleteDeadline = useMemo(
    () => deadlines.find((deadline) => deadline.id === deleteDeadlineId) ?? null,
    [deadlines, deleteDeadlineId],
  );

  const resetForm = () => {
    setEditingDeadline(null);
    setFormTitle('');
    setFormDescription('');
    setFormDueDate('');
    setFormError('');
  };

  const openAdd = () => {
    resetForm();
    deadlineModal.onOpen();
  };

  const scheduleConditionalDeadline = (item: (typeof conditionalDeadlinePrompts)[number]) => {
    setEditingDeadline(null);
    setFormTitle(`${item.label} review`);
    setFormDescription(`${item.recommendedAction}\n\nStandards: ${item.standardCodes.join(', ')}`);
    setFormDueDate(dateInDays(30));
    setFormError('');
    deadlineModal.onOpen();
  };

  const openEdit = (deadline: DeadlineResponse) => {
    setEditingDeadline(deadline);
    setFormTitle(deadline.title);
    setFormDescription(deadline.description ?? '');
    setFormDueDate(deadline.dueDate.slice(0, 10));
    setFormError('');
    deadlineModal.onOpen();
  };

  const openDelete = (deadline: DeadlineResponse) => {
    setDeleteDeadlineId(deadline.id);
    deleteModal.onOpen();
  };

  const handleSaveDeadline = async () => {
    if (formDisabledReason) {
      setFormError(formDisabledReason);
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      if (editingDeadline) {
        const body: UpdateDeadlineRequest = {
          title: formTitle.trim(),
          description: formDescription.trim() || null,
          dueDate: formDueDate,
          reminderDays: editingDeadline.reminderDays,
        };
        await api.patch(`/deadlines/${editingDeadline.id}`, body);
      } else {
        const body: CreateDeadlineRequest = {
          title: formTitle.trim(),
          description: formDescription.trim() || undefined,
          dueDate: formDueDate,
          reminderDays: [30, 7, 1],
        };
        await api.post('/deadlines', body);
      }

      resetForm();
      deadlineModal.onClose();
      await fetchDeadlines();
      toast(editingDeadline ? 'Deadline updated' : 'Deadline added');
    } catch (err) {
      const message = apiErrorMessage(err, 'Deadline could not be saved. Please review the fields and try again.');
      logClientError('Failed to save deadline', err);
      setFormError(message);
      toast('Failed to save deadline', 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleComplete = async (deadline: DeadlineResponse) => {
    setToggleDeadlineId(deadline.id);
    try {
      await api.patch(`/deadlines/${deadline.id}`, {
        isComplete: !deadline.isComplete,
      });
      await fetchDeadlines();
      toast(deadline.isComplete ? 'Deadline reopened' : 'Deadline completed');
    } catch (err) {
      logClientError('Toggle failed', err);
      toast(apiErrorMessage(err, 'Failed to update deadline'), 'error');
    } finally {
      setToggleDeadlineId(null);
    }
  };

  const handleDeleteDeadline = async () => {
    if (!deleteDeadlineId) return;

    setDeletingDeadlineId(deleteDeadlineId);
    try {
      await api.delete(`/deadlines/${deleteDeadlineId}`);
      await fetchDeadlines();
      deleteModal.onClose();
      setDeleteDeadlineId(null);
      toast('Deadline deleted');
    } catch (err) {
      logClientError('Delete deadline failed', err);
      toast(apiErrorMessage(err, 'Failed to delete deadline'), 'error');
    } finally {
      setDeletingDeadlineId(null);
    }
  };

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
