'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { canManageGovernance } from '@/lib/governance-permissions';

export const GOVERNING_ACT_KINDS = [
  'BOARD_MEETING',
  'DIRECTORS_WRITTEN_RESOLUTION',
  'MEMBER_WRITTEN_RESOLUTION',
  'ANNUAL_GENERAL_MEETING',
  'EXTRAORDINARY_GENERAL_MEETING',
] as const;

export const GOVERNING_ACT_STATUSES = [
  'SCHEDULED',
  'HELD',
  'DRAFT',
  'CIRCULATED',
  'APPROVED',
  'SUPERSEDED',
] as const;

export type GoverningActKind = (typeof GOVERNING_ACT_KINDS)[number];
export type GoverningActStatus = (typeof GOVERNING_ACT_STATUSES)[number];

export type Resolution = {
  id: string;
  itemNumber: string | null;
  text: string;
  carried: boolean;
  abstentions: string | null;
};

export type GoverningAct = {
  id: string;
  kind: GoverningActKind;
  status: GoverningActStatus;
  actDate: string;
  reference: string;
  title: string;
  statutoryBasis: string | null;
  approvedAtActId: string | null;
  approvedAt: string | null;
  notes: string | null;
  updatedAt: string;
  resolutions: Resolution[];
};

export type GoverningActVoidRecord = {
  id: string;
  reference: string;
  kind: string;
  status: string;
  actDate: string;
  title: string;
  resolutionCount: number;
  reason: string;
  voidedByEmail: string;
  voidedAt: string;
};

export type ActForm = {
  kind: GoverningActKind;
  status: GoverningActStatus;
  actDate: string;
  reference: string;
  title: string;
  statutoryBasis: string;
  notes: string;
};

const EMPTY_FORM: ActForm = {
  kind: 'BOARD_MEETING',
  status: 'SCHEDULED',
  actDate: '',
  reference: '',
  title: '',
  statutoryBasis: '',
  notes: '',
};

/** Statuses that make a governing act usable as evidence of approval. */
export const EVIDENCED_STATUSES: GoverningActStatus[] = ['APPROVED'];

function messageFrom(err: unknown, fallback: string): string {
  const response = (err as { response?: { data?: { error?: string; message?: string } } })?.response;
  return response?.data?.error || response?.data?.message || fallback;
}

export function useMinuteBookWorkflow() {
  const { user } = useAuth();
  const canManage = canManageGovernance(user?.role);

  const [acts, setActs] = useState<GoverningAct[]>([]);
  const [voids, setVoids] = useState<GoverningActVoidRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [kindFilter, setKindFilter] = useState<GoverningActKind | ''>('');
  const [statusFilter, setStatusFilter] = useState<GoverningActStatus | ''>('');

  const [modalMode, setModalMode] = useState<'closed' | 'create' | 'edit'>('closed');
  const [editingAct, setEditingAct] = useState<GoverningAct | null>(null);
  const [form, setForm] = useState<ActForm>(EMPTY_FORM);

  const [voidTarget, setVoidTarget] = useState<GoverningAct | null>(null);
  const [voidReason, setVoidReason] = useState('');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      // No year parameter: the whole minute book, every year.
      const [actsRes, voidsRes] = await Promise.all([
        api.get('/governing-acts'),
        api.get('/governing-acts/voids'),
      ]);
      setActs((actsRes.data?.data ?? []) as GoverningAct[]);
      setVoids((voidsRes.data?.data ?? []) as GoverningActVoidRecord[]);
    } catch (err) {
      setLoadError(messageFrom(err, 'The minute book could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const visibleActs = useMemo(
    () =>
      acts.filter(
        (act) =>
          (kindFilter === '' || act.kind === kindFilter) &&
          (statusFilter === '' || act.status === statusFilter),
      ),
    [acts, kindFilter, statusFilter],
  );

  /** Counts that should be impossible to miss on the page. */
  const attention = useMemo(() => {
    const unapproved = acts.filter((a) => a.status === 'DRAFT' || a.status === 'CIRCULATED');
    const superseded = acts.filter((a) => a.status === 'SUPERSEDED');
    const withoutResolutions = acts.filter(
      (a) => a.status === 'APPROVED' && a.resolutions.length === 0,
    );
    return { unapproved, superseded, withoutResolutions };
  }, [acts]);

  const openCreate = useCallback(() => {
    if (!canManage) return;
    setEditingAct(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setModalMode('create');
  }, [canManage]);

  const openEdit = useCallback(
    (act: GoverningAct) => {
      if (!canManage) return;
      setEditingAct(act);
      setForm({
        kind: act.kind,
        status: act.status,
        actDate: act.actDate.slice(0, 10),
        reference: act.reference,
        title: act.title,
        statutoryBasis: act.statutoryBasis ?? '',
        notes: act.notes ?? '',
      });
      setFormError('');
      setModalMode('edit');
    },
    [canManage],
  );

  const closeModal = useCallback(() => {
    setModalMode('closed');
    setEditingAct(null);
    setFormError('');
  }, []);

  const updateForm = useCallback((patch: Partial<ActForm>) => {
    setForm((current) => ({ ...current, ...patch }));
  }, []);

  const submitAct = useCallback(async () => {
    if (!canManage) return;
    setFormError('');

    if (!form.actDate) return setFormError('Give the date the act took place.');
    if (!form.reference.trim()) return setFormError('Give a reference, for example BM-2026-08-07.');
    if (!form.title.trim()) return setFormError('Give a title.');

    setSaving(true);
    try {
      const body = {
        kind: form.kind,
        status: form.status,
        actDate: form.actDate,
        reference: form.reference.trim(),
        title: form.title.trim(),
        statutoryBasis: form.statutoryBasis.trim() || null,
        notes: form.notes.trim() || null,
      };

      if (modalMode === 'edit' && editingAct) {
        await api.patch(`/governing-acts/${editingAct.id}`, {
          ...body,
          expectedUpdatedAt: editingAct.updatedAt,
        });
      } else {
        await api.post('/governing-acts', body);
      }
      closeModal();
      await fetchAll();
    } catch (err) {
      setFormError(messageFrom(err, 'The governing act could not be saved.'));
    } finally {
      setSaving(false);
    }
  }, [canManage, closeModal, editingAct, fetchAll, form, modalMode]);

  const addResolution = useCallback(
    async (actId: string, text: string, itemNumber: string) => {
      if (!canManage || !text.trim()) return;
      setSaving(true);
      setFormError('');
      try {
        await api.post(`/governing-acts/${actId}/resolutions`, {
          text: text.trim(),
          itemNumber: itemNumber.trim() || null,
        });
        await fetchAll();
      } catch (err) {
        setFormError(messageFrom(err, 'The resolution could not be added.'));
      } finally {
        setSaving(false);
      }
    },
    [canManage, fetchAll],
  );

  const openVoid = useCallback(
    (act: GoverningAct) => {
      if (!canManage) return;
      setVoidTarget(act);
      setVoidReason('');
      setFormError('');
    },
    [canManage],
  );

  const closeVoid = useCallback(() => {
    setVoidTarget(null);
    setVoidReason('');
    setFormError('');
  }, []);

  const confirmVoid = useCallback(async () => {
    if (!canManage || !voidTarget) return;
    if (voidReason.trim().length < 20) {
      setFormError('Give a reason of at least 20 characters. It is kept in the audit trail.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      await api.post(`/governing-acts/${voidTarget.id}/void`, {
        expectedUpdatedAt: voidTarget.updatedAt,
        reason: voidReason.trim(),
      });
      closeVoid();
      await fetchAll();
    } catch (err) {
      setFormError(messageFrom(err, 'The governing act could not be removed.'));
    } finally {
      setSaving(false);
    }
  }, [canManage, closeVoid, fetchAll, voidReason, voidTarget]);

  return {
    acts,
    visibleActs,
    voids,
    attention,
    loading,
    loadError,
    saving,
    formError,
    canManage,
    kindFilter,
    setKindFilter,
    statusFilter,
    setStatusFilter,
    modalMode,
    editingAct,
    form,
    updateForm,
    openCreate,
    openEdit,
    closeModal,
    submitAct,
    addResolution,
    voidTarget,
    voidReason,
    setVoidReason,
    openVoid,
    closeVoid,
    confirmVoid,
    refresh: fetchAll,
  };
}
