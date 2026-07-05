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
import { AppPage, AppSection } from '@/components/ui/app-page';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { ReviewFlag, StatusChip, statusPanelClassName } from '@/components/ui/status';
import { DeadlineDeleteModal } from './deadline-delete-modal';
import { DeadlineFormModal } from './deadline-form-modal';
import { DeadlineListPanel, summarizeDeadlines } from './deadline-list-panel';
import { DeadlineProfilePromptsPanel, buildDeadlineProfilePrompts } from './deadline-profile-prompts';
import type { CreateDeadlineRequest, DeadlineResponse, OrganisationResponse, UpdateDeadlineRequest } from '@charitypilot/shared';

const regulatoryMilestones = [
  {
    title: 'Annual Report filing',
    cadence: '10 months after financial year end',
    detail: 'Use the organisation profile year-end date so the app can generate this deadline automatically.',
  },
  {
    title: 'Compliance Record Form approval',
    cadence: 'Before Annual Report submission',
    detail: 'The board should approve the annual Governance Code position and keep the record as evidence.',
  },
  {
    title: 'Financial controls review',
    cadence: 'At least annually',
    detail: 'Review budgets, reconciliations, reserves, approval limits, restricted funds, and management accounts.',
  },
  {
    title: 'Risk and insurance review',
    cadence: 'At least annually',
    detail: 'Refresh the risk register and confirm insurance cover remains appropriate for activities.',
  },
];

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
        <section className={statusPanelClassName('brand', 'p-5 shadow-sm')}>
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-3xl">
              <ReviewFlag tone="draft">Review-ready schedule</ReviewFlag>
              <h2 className="mt-3 text-lg font-semibold text-gray-950 dark:text-gray-50">
                Scan what needs trustee attention next.
              </h2>
              <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
                Priority badges separate overdue, due-soon, upcoming, and complete work so board packs can focus on the right dates.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:min-w-[28rem]">
              <div className={statusPanelClassName('neutral', 'p-3')}>
                <p className="text-xs text-gray-500 dark:text-gray-400">Open</p>
                <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{summary.open}</p>
              </div>
              <div className={statusPanelClassName('danger', 'p-3')}>
                <p className="text-xs text-gray-500 dark:text-gray-400">Overdue</p>
                <p className="text-xl font-bold text-rose-700 dark:text-rose-300">{summary.overdue}</p>
              </div>
              <div className={statusPanelClassName('warning', 'p-3')}>
                <p className="text-xs text-gray-500 dark:text-gray-400">Due soon</p>
                <p className="text-xl font-bold text-amber-700 dark:text-amber-300">{summary.dueSoon}</p>
              </div>
              <div className={statusPanelClassName('info', 'p-3')}>
                <p className="text-xs text-gray-500 dark:text-gray-400">System</p>
                <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{summary.system}</p>
              </div>
            </div>
          </div>
        </section>
      )}

      {deadlineDataReady && (
        <AppSection
          title="Regulatory cadence"
          description="Core dates to keep in view for Irish registered charities. Add custom dates for funders, CRO, audits, AGMs, and internal reviews."
        >
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
            {regulatoryMilestones.map((item) => (
              <div key={item.title} className={statusPanelClassName('neutral', 'p-4')}>
                <StatusChip tone="brand">{item.cadence}</StatusChip>
                <h3 className="mt-3 text-sm font-semibold text-gray-950 dark:text-gray-50">{item.title}</h3>
                <p className="mt-2 text-xs leading-5 text-gray-600 dark:text-gray-300">{item.detail}</p>
              </div>
            ))}
          </div>
        </AppSection>
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
