'use client';

import { logClientError } from '@/lib/client-logger';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
  useDisclosure,
} from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useToast } from '@/components/toast';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { DataList, DataListItems } from '@/components/ui/data-list';
import { FieldGroup, FormHint, ValidationSummary } from '@/components/ui/forms';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { DeadlineBadge, ReviewFlag, StatusChip } from '@/components/ui/status';
import type { CreateDeadlineRequest, DeadlineResponse, UpdateDeadlineRequest } from '@charitypilot/shared';

type DeadlineDueState = 'complete' | 'overdue' | 'due-soon' | 'upcoming';

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

const formatDate = (value: string) => {
  return new Date(value).toLocaleDateString('en-IE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

const daysBetweenTodayAnd = (value: string) => {
  const due = new Date(value);
  const now = new Date();
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((dueDay.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
};

const classifyDeadline = (deadline: DeadlineResponse) => {
  const daysUntil = daysBetweenTodayAnd(deadline.dueDate);
  let dueState: DeadlineDueState = 'upcoming';
  let badgeLabel = `${daysUntil} days left`;
  let priorityLabel = 'Scheduled';

  if (deadline.isComplete) {
    dueState = 'complete';
    badgeLabel = 'Complete';
    priorityLabel = 'Closed';
  } else if (daysUntil < 0) {
    dueState = 'overdue';
    badgeLabel = `${Math.abs(daysUntil)} days overdue`;
    priorityLabel = 'Board priority';
  } else if (daysUntil === 0) {
    dueState = 'due-soon';
    badgeLabel = 'Due today';
    priorityLabel = 'Due now';
  } else if (daysUntil <= 30) {
    dueState = 'due-soon';
    badgeLabel = `${daysUntil} days left`;
    priorityLabel = 'Due soon';
  }

  return {
    daysUntil,
    dueState,
    badgeLabel,
    priorityLabel,
    badgeTone: dueState,
    rowClass:
      dueState === 'overdue'
        ? 'border-rose-200 bg-rose-50/70 dark:border-rose-800 dark:bg-rose-950/30'
        : dueState === 'due-soon'
          ? 'border-amber-200 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/30'
          : dueState === 'complete'
            ? 'border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/70'
            : 'border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900',
  };
};

export default function DeadlinesPage() {
  useDocumentTitle('Deadlines');
  const [deadlines, setDeadlines] = useState<DeadlineResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [toggleDeadlineId, setToggleDeadlineId] = useState<string | null>(null);

  const deadlineModal = useDisclosure();
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

  useEffect(() => {
    fetchDeadlines(true);
  }, [fetchDeadlines]);

  const sortedDeadlines = useMemo(() => {
    return [...deadlines].sort((a, b) => {
      if (a.isComplete !== b.isComplete) return a.isComplete ? 1 : -1;
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    });
  }, [deadlines]);

  const summary = useMemo(() => {
    return sortedDeadlines.reduce(
      (acc, deadline) => {
        const meta = classifyDeadline(deadline);
        if (!deadline.isComplete) acc.open += 1;
        if (meta.dueState === 'overdue') acc.overdue += 1;
        if (meta.dueState === 'due-soon') acc.dueSoon += 1;
        if (deadline.isAutoGenerated) acc.system += 1;
        return acc;
      },
      { open: 0, overdue: 0, dueSoon: 0, system: 0 },
    );
  }, [sortedDeadlines]);

  const formDisabledReason = useMemo(() => {
    if (!formTitle.trim()) return 'Add a title before saving.';
    if (!formDueDate) return 'Choose the due date before saving.';
    return '';
  }, [formDueDate, formTitle]);

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

  const openEdit = (deadline: DeadlineResponse) => {
    setEditingDeadline(deadline);
    setFormTitle(deadline.title);
    setFormDescription(deadline.description ?? '');
    setFormDueDate(deadline.dueDate.slice(0, 10));
    setFormError('');
    deadlineModal.onOpen();
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

  return (
    <AppPage
      eyebrow="Governance calendar"
      title="Deadline Tracker"
      description="Keep annual returns, board approvals, funder dates, and internal review deadlines visible before they become filing problems."
      actions={(
        <Button className="bg-teal-primary text-white hover:bg-teal-dark" onPress={openAdd}>
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add deadline
        </Button>
      )}
    >
      <section className="rounded-lg border border-teal-primary/20 bg-white p-5 shadow-sm dark:border-teal-light/20 dark:bg-gray-900">
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
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
              <p className="text-xs text-gray-500 dark:text-gray-400">Open</p>
              <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{summary.open}</p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
              <p className="text-xs text-gray-500 dark:text-gray-400">Overdue</p>
              <p className="text-xl font-bold text-rose-700 dark:text-rose-300">{summary.overdue}</p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
              <p className="text-xs text-gray-500 dark:text-gray-400">Due soon</p>
              <p className="text-xl font-bold text-amber-700 dark:text-amber-300">{summary.dueSoon}</p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
              <p className="text-xs text-gray-500 dark:text-gray-400">System</p>
              <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{summary.system}</p>
            </div>
          </div>
        </div>
      </section>

      <AppSection
        title="Regulatory cadence"
        description="Core dates to keep in view for Irish registered charities. Add custom dates for funders, CRO, audits, AGMs, and internal reviews."
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
          {regulatoryMilestones.map((item) => (
            <div key={item.title} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
              <StatusChip tone="brand">{item.cadence}</StatusChip>
              <h3 className="mt-3 text-sm font-semibold text-gray-950 dark:text-gray-50">{item.title}</h3>
              <p className="mt-2 text-xs leading-5 text-gray-600 dark:text-gray-300">{item.detail}</p>
            </div>
          ))}
        </div>
      </AppSection>

      <DataList
        title="Deadline list"
        description="Incomplete items appear first, then the nearest due date. Complete items stay visible for evidence history."
      >
        {loading ? (
          <LoadingState title="Loading deadlines" description="Checking your governance calendar." />
        ) : loadError && sortedDeadlines.length === 0 ? (
          <ErrorState
            title="Deadlines could not be loaded"
            description={loadError}
            action={(
              <Button size="sm" variant="flat" onPress={() => fetchDeadlines(true)}>
                Try again
              </Button>
            )}
          />
        ) : sortedDeadlines.length === 0 ? (
          <EmptyState
            title="No deadlines yet"
            description="Auto-generated dates will appear once the organisation profile is set up. Add any board, funder, AGM, audit, or reporting dates you already know."
            action={(
              <Button size="sm" className="bg-teal-primary text-white hover:bg-teal-dark" onPress={openAdd}>
                Add first deadline
              </Button>
            )}
          />
        ) : (
          <div className="space-y-3">
            {loadError ? (
              <ErrorState
                title="Some deadline data may be out of date"
                description={loadError}
                action={(
                  <Button size="sm" variant="flat" onPress={() => fetchDeadlines(true)}>
                    Refresh
                  </Button>
                )}
              />
            ) : null}
            <div aria-live="polite" className="sr-only">
              {toggleDeadlineId ? 'Updating deadline status' : 'Deadline list ready'}
            </div>
            <DataListItems divided={false}>
              <div className="space-y-3 p-3">
                {sortedDeadlines.map((deadline) => {
                  const meta = classifyDeadline(deadline);
                  return (
                    <article key={deadline.id} className={`rounded-lg border p-4 ${meta.rowClass}`}>
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex min-w-0 gap-3">
                          <Button
                            role="checkbox"
                            aria-checked={deadline.isComplete}
                            aria-label={`Mark ${deadline.title} as ${deadline.isComplete ? 'incomplete' : 'complete'}`}
                            isIconOnly
                            size="sm"
                            variant={deadline.isComplete ? 'solid' : 'bordered'}
                            color={deadline.isComplete ? 'success' : 'default'}
                            isLoading={toggleDeadlineId === deadline.id}
                            isDisabled={Boolean(toggleDeadlineId) && toggleDeadlineId !== deadline.id}
                            onPress={() => toggleComplete(deadline)}
                            className="mt-0.5 shrink-0"
                          >
                            {deadline.isComplete ? (
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                              </svg>
                            ) : (
                              <span className="h-3 w-3 rounded-sm border border-current" aria-hidden="true" />
                            )}
                          </Button>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className={`break-words text-sm font-semibold ${deadline.isComplete ? 'text-gray-500 line-through dark:text-gray-400' : 'text-gray-950 dark:text-gray-50'}`}>
                                {deadline.title}
                              </h3>
                              {deadline.isAutoGenerated ? (
                                <StatusChip tone="info">System deadline</StatusChip>
                              ) : (
                                <StatusChip tone="neutral">Custom</StatusChip>
                              )}
                              <StatusChip tone={meta.priorityLabel === 'Board priority' ? 'danger' : meta.priorityLabel === 'Due soon' || meta.priorityLabel === 'Due now' ? 'warning' : 'neutral'}>
                                {meta.priorityLabel}
                              </StatusChip>
                            </div>
                            {deadline.description ? (
                              <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">{deadline.description}</p>
                            ) : (
                              <p className="mt-1 text-sm leading-6 text-gray-500 dark:text-gray-400">No notes added.</p>
                            )}
                            <p className="mt-2 text-xs font-medium text-gray-600 dark:text-gray-300">
                              Due {formatDate(deadline.dueDate)}
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          <DeadlineBadge tone={meta.badgeTone} ariaLabel={`Deadline status: ${meta.badgeLabel}`}>
                            {meta.badgeLabel}
                          </DeadlineBadge>
                          <Button
                            size="sm"
                            variant="flat"
                            onPress={() => openEdit(deadline)}
                            isDisabled={Boolean(toggleDeadlineId) || saving}
                          >
                            Edit
                          </Button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </DataListItems>
          </div>
        )}
      </DataList>

      <Modal isOpen={deadlineModal.isOpen} onOpenChange={deadlineModal.onOpenChange} scrollBehavior="inside">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>{editingDeadline ? 'Edit deadline' : 'Add deadline'}</ModalHeader>
              <ModalBody className="gap-5">
                <ValidationSummary errors={formError ? [formError] : []} />
                <FieldGroup
                  title="Deadline details"
                  description="Use plain names and dates so trustees can scan what is due before board review."
                >
                  <Input
                    label="Title"
                    placeholder="Submit Annual Report to CRA"
                    value={formTitle}
                    onValueChange={setFormTitle}
                    isRequired
                  />
                  <Textarea
                    label="Description"
                    placeholder="Notes, owner, or supporting evidence needed."
                    value={formDescription}
                    onValueChange={setFormDescription}
                    minRows={2}
                  />
                  <Input
                    label="Due date"
                    type="date"
                    value={formDueDate}
                    onValueChange={setFormDueDate}
                    isRequired
                  />
                  <FormHint id="deadline-disabled-hint" tone={formDisabledReason ? 'warning' : 'neutral'}>
                    {formDisabledReason || 'Default reminders are kept at 30, 7, and 1 day before the due date.'}
                  </FormHint>
                </FieldGroup>
              </ModalBody>
              <ModalFooter>
                <Button variant="flat" onPress={() => { resetForm(); onClose(); }} isDisabled={saving}>
                  Cancel
                </Button>
                <Button
                  className="bg-teal-primary text-white hover:bg-teal-dark"
                  onPress={handleSaveDeadline}
                  isLoading={saving}
                  isDisabled={Boolean(formDisabledReason) || saving}
                  aria-describedby="deadline-disabled-hint"
                >
                  {editingDeadline ? 'Save deadline' : 'Add deadline'}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </AppPage>
  );
}
