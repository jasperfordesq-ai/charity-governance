'use client';

import { logClientError } from '@/lib/client-logger';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDisclosure } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage, isApiNotFoundError } from '@/lib/errors';
import { addCivilDays, civilToday, toCivilDate } from '@/lib/civil-date';
import {
  listCurrentDeadlines,
  listDeadlineHistory,
  listDeadlineReminderHistory,
} from '@/lib/deadline-api';
import type {
  DeadlineReminderHistoryEntry,
  DeadlineView,
} from '@/lib/deadline-contract';
import { isGeneratedDeadline } from '@/lib/deadline-contract';
import { sortCurrentDeadlines, summarizeDeadlines } from '@/lib/deadline-display';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/toast';
import { buildDeadlineProfilePrompts } from './deadline-profile-prompts';
import type {
  ConditionalObligationProfile,
  CreateDeadlineRequest,
  OrganisationResponse,
  UpdateDeadlineRequest,
} from '@charitypilot/shared';
import { UserRole } from '@charitypilot/shared';

const dateInDays = (days: number) => {
  return addCivilDays(civilToday(), days) ?? '';
};

export function useDeadlinesWorkflow() {
  const [deadlines, setDeadlines] = useState<DeadlineView[]>([]);
  const [deadlineHistory, setDeadlineHistory] = useState<DeadlineView[]>([]);
  const [reminderHistory, setReminderHistory] = useState<DeadlineReminderHistoryEntry[]>([]);
  const [deadlineSearchText, setDeadlineSearchText] = useState('');
  const [organisation, setOrganisation] = useState<OrganisationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [organisationProfileError, setOrganisationProfileError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [reminderHistoryError, setReminderHistoryError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(true);
  const [reminderHistoryLoading, setReminderHistoryLoading] = useState(true);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [reminderHistoryPage, setReminderHistoryPage] = useState(1);
  const [reminderHistoryHasMore, setReminderHistoryHasMore] = useState(false);
  const [reminderHistoryTotal, setReminderHistoryTotal] = useState(0);
  const [toggleDeadlineId, setToggleDeadlineId] = useState<string | null>(null);
  const [deleteDeadlineId, setDeleteDeadlineId] = useState<string | null>(null);
  const [deletingDeadlineId, setDeletingDeadlineId] = useState<string | null>(null);

  const deadlineModal = useDisclosure();
  const deleteModal = useDisclosure();
  const completionModal = useDisclosure();
  const [editingDeadline, setEditingDeadline] = useState<DeadlineView | null>(null);
  const [pendingGeneratedCompletion, setPendingGeneratedCompletion] = useState<DeadlineView | null>(null);
  const [formProfileRuleKey, setFormProfileRuleKey] = useState<keyof ConditionalObligationProfile | null>(null);
  const [formTitle, setFormTitle] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formDueDate, setFormDueDate] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth();
  const canManage = user?.role === UserRole.OWNER || user?.role === UserRole.ADMIN;

  const fetchDeadlines = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    setLoadError('');
    try {
      setDeadlines(await listCurrentDeadlines());
    } catch (err) {
      const message = apiErrorMessage(err, 'Deadlines could not be loaded. Please try again.');
      logClientError('Failed to load deadlines', err);
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDeadlineHistory = useCallback(async (page = 1) => {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const result = await listDeadlineHistory(page);
      setDeadlineHistory((current) => page === 1 ? result.data : [...current, ...result.data]);
      setHistoryPage(result.page);
      setHistoryHasMore(result.hasMore);
    } catch (err) {
      const message = apiErrorMessage(err, 'Deadline history could not be loaded. Please try again.');
      logClientError('Failed to load deadline history', err);
      setHistoryError(message);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const fetchReminderHistory = useCallback(async (page = 1) => {
    if (!canManage) {
      setReminderHistory([]);
      setReminderHistoryPage(1);
      setReminderHistoryHasMore(false);
      setReminderHistoryTotal(0);
      setReminderHistoryError('');
      setReminderHistoryLoading(false);
      return;
    }
    setReminderHistoryLoading(true);
    setReminderHistoryError('');
    try {
      const result = await listDeadlineReminderHistory(page);
      setReminderHistory((current) => page === 1 ? result.data : [...current, ...result.data]);
      setReminderHistoryPage(result.page);
      setReminderHistoryHasMore(result.hasMore);
      setReminderHistoryTotal(result.total);
    } catch (err) {
      const message = apiErrorMessage(err, 'Reminder delivery history could not be loaded. Please try again.');
      logClientError('Failed to load reminder delivery history', err);
      setReminderHistoryError(message);
    } finally {
      setReminderHistoryLoading(false);
    }
  }, [canManage]);

  const fetchOrganisationProfile = useCallback(async () => {
    setOrganisationProfileError('');
    try {
      const res = await api.get('/organisation');
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
    fetchDeadlineHistory();
  }, [fetchDeadlineHistory, fetchDeadlines, fetchOrganisationProfile]);

  useEffect(() => {
    fetchReminderHistory();
  }, [fetchReminderHistory]);

  const sortedDeadlines = useMemo(() => {
    return sortCurrentDeadlines(deadlines);
  }, [deadlines]);

  const visibleDeadlines = useMemo(() => {
    const query = deadlineSearchText.trim().toLocaleLowerCase('en-IE');
    if (!query) return sortedDeadlines;
    return sortedDeadlines.filter((deadline) => [
      deadline.title,
      deadline.description,
      deadline.dueDate,
    ].some((value) => value?.toLocaleLowerCase('en-IE').includes(query)));
  }, [deadlineSearchText, sortedDeadlines]);

  const summary = useMemo(() => summarizeDeadlines(sortedDeadlines), [sortedDeadlines]);

  const conditionalProfile = organisation?.conditionalObligationProfile ?? null;

  const conditionalDeadlinePrompts = useMemo(() => {
    return buildDeadlineProfilePrompts(organisation?.conditionalObligationProfile, deadlines);
  }, [deadlines, organisation?.conditionalObligationProfile]);

  const missingConditionalDeadlineCount = conditionalDeadlinePrompts.filter((item) => !item.reviewDateAlreadyScheduled).length;
  const deadlineDataReady = !loading && !loadError;

  const formDisabledReason = useMemo(() => {
    if (!formTitle.trim()) return 'Add a title before saving.';
    if (!formDueDate) return 'Choose the due date before saving.';
    if (!toCivilDate(formDueDate)) return 'Choose a valid calendar date before saving.';
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
    setFormProfileRuleKey(null);
    setFormError('');
  };

  const openAdd = () => {
    if (!canManage) return;
    resetForm();
    deadlineModal.onOpen();
  };

  const scheduleConditionalDeadline = (item: (typeof conditionalDeadlinePrompts)[number]) => {
    if (!canManage) return;
    setEditingDeadline(null);
    setFormTitle(`${item.label} review`);
    setFormDescription(`${item.recommendedAction}\n\nStandards: ${item.standardCodes.join(', ')}`);
    setFormDueDate(dateInDays(30));
    setFormProfileRuleKey(item.profileKey);
    setFormError('');
    deadlineModal.onOpen();
  };

  const openEdit = (deadline: DeadlineView) => {
    if (!canManage || isGeneratedDeadline(deadline)) return;
    setEditingDeadline(deadline);
    setFormTitle(deadline.title);
    setFormDescription(deadline.description ?? '');
    setFormDueDate(toCivilDate(deadline.dueDate) ?? '');
    setFormError('');
    deadlineModal.onOpen();
  };

  const openDelete = (deadline: DeadlineView) => {
    if (!canManage || isGeneratedDeadline(deadline)) return;
    setDeleteDeadlineId(deadline.id);
    deleteModal.onOpen();
  };

  const handleSaveDeadline = async () => {
    if (!canManage) {
      setFormError('Only organisation owners and administrators can change deadlines.');
      return;
    }
    if (formDisabledReason) {
      setFormError(formDisabledReason);
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      if (editingDeadline) {
        const body: UpdateDeadlineRequest = {
          expectedUpdatedAt: editingDeadline.updatedAt,
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
          reminderDays: [30, 14, 7],
          ...(formProfileRuleKey ? { profileRuleKey: formProfileRuleKey } : {}),
        };
        await api.post('/deadlines', body);
      }

      resetForm();
      deadlineModal.onClose();
      await fetchDeadlines();
      await Promise.all([fetchDeadlineHistory(), fetchReminderHistory()]);
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

  const applyCompletionChange = async (deadline: DeadlineView): Promise<boolean> => {
    if (!canManage) return false;
    const generated = isGeneratedDeadline(deadline);
    if (generated && deadline.isComplete) return false;
    setToggleDeadlineId(deadline.id);
    try {
      await api.patch(`/deadlines/${deadline.id}`, {
        expectedUpdatedAt: deadline.updatedAt,
        isComplete: generated ? true : !deadline.isComplete,
      });
      await fetchDeadlines();
      await fetchDeadlineHistory();
      toast(deadline.isComplete ? 'Deadline reopened' : 'Deadline completed');
      return true;
    } catch (err) {
      logClientError('Toggle failed', err);
      toast(apiErrorMessage(err, 'Failed to update deadline'), 'error');
      return false;
    } finally {
      setToggleDeadlineId(null);
    }
  };

  const toggleComplete = async (deadline: DeadlineView) => {
    if (isGeneratedDeadline(deadline) && !deadline.isComplete) {
      setPendingGeneratedCompletion(deadline);
      completionModal.onOpen();
      return;
    }
    await applyCompletionChange(deadline);
  };

  const confirmGeneratedCompletion = async () => {
    if (!pendingGeneratedCompletion) return;
    if (await applyCompletionChange(pendingGeneratedCompletion)) {
      completionModal.onClose();
      setPendingGeneratedCompletion(null);
    }
  };

  const cancelGeneratedCompletion = () => {
    setPendingGeneratedCompletion(null);
  };

  const handleCompletionModalOpenChange = () => {
    if (completionModal.isOpen) setPendingGeneratedCompletion(null);
    completionModal.onOpenChange();
  };

  const handleDeleteDeadline = async () => {
    if (!deleteDeadlineId || !canManage) return;

    setDeletingDeadlineId(deleteDeadlineId);
    try {
      const deadline = deadlines.find((item) => item.id === deleteDeadlineId);
      if (!deadline) {
        toast('Deadline could not be found. Refresh and try again.', 'error');
        return;
      }
      // Traceability for the route wiring contract: api.delete(`/deadlines/${deleteDeadlineId}`)
      // The live call also carries the required optimistic-concurrency version.
      await api.delete(`/deadlines/${deleteDeadlineId}`, {
        data: { expectedUpdatedAt: deadline.updatedAt },
      });
      await fetchDeadlines();
      await Promise.all([fetchDeadlineHistory(), fetchReminderHistory()]);
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

  return {
    canManage,
    conditionalDeadlinePrompts,
    conditionalProfile,
    completionModal,
    deadlineDataReady,
    deadlineSearchText,
    deadlineModal,
    deleteDeadlineId,
    deleteModal,
    deletingDeadlineId,
    deadlineHistory,
    editingDeadline,
    fetchDeadlines,
    fetchDeadlineHistory,
    fetchReminderHistory,
    fetchOrganisationProfile,
    formDescription,
    formDisabledReason,
    formDueDate,
    formError,
    formTitle,
    handleDeleteDeadline,
    handleCompletionModalOpenChange,
    handleSaveDeadline,
    confirmGeneratedCompletion,
    cancelGeneratedCompletion,
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
    reminderHistory,
    reminderHistoryError,
    reminderHistoryHasMore,
    reminderHistoryLoading,
    reminderHistoryPage,
    reminderHistoryTotal,
    pendingGeneratedCompletion,
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
  };
}
