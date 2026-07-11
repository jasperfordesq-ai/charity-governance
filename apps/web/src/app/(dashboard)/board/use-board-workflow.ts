'use client';

import { logClientError } from '@/lib/client-logger';
import { api } from '@/lib/api';
import { apiErrorMessage, isApiForbiddenError } from '@/lib/errors';
import { canManageGovernance } from '@/lib/governance-permissions';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/toast';
import { useDisclosure } from '@heroui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getTrusteeEvidence } from './board-evidence';
import type { BoardSummary } from './board-summary-panel';
import type {
  BoardMemberResponse,
  CreateBoardMemberRequest,
  UpdateBoardMemberRequest,
} from '@charitypilot/shared';

export function useBoardWorkflow() {
  const [members, setMembers] = useState<BoardMemberResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [mutatingMemberId, setMutatingMemberId] = useState<string | null>(null);
  const { toast } = useToast();
  const { user, refreshUser } = useAuth();
  const [governanceAccessRevoked, setGovernanceAccessRevoked] = useState(false);
  const canManage = canManageGovernance(user?.role) && !governanceAccessRevoked;

  const memberModal = useDisclosure();
  const [editing, setEditing] = useState<BoardMemberResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [formName, setFormName] = useState('');
  const [formRole, setFormRole] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formAppointed, setFormAppointed] = useState('');
  const [formTermEnd, setFormTermEnd] = useState('');
  const [formConductSigned, setFormConductSigned] = useState(false);
  const [formConductDate, setFormConductDate] = useState('');
  const [formInduction, setFormInduction] = useState(false);
  const [formInductionDate, setFormInductionDate] = useState('');

  const fetchMembers = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    setLoadError('');
    try {
      const res = await api.get('/board-members');
      setMembers(res.data?.data ?? res.data ?? []);
    } catch (err) {
      const message = apiErrorMessage(err, 'Board members could not be loaded. Please try again.');
      logClientError('Failed to load board members', err);
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMembers(true);
  }, [fetchMembers]);

  const displayMembers = useMemo(() => {
    return members
      .filter((member) => showInactive || member.isActive)
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name));
  }, [members, showInactive]);

  const summary = useMemo<BoardSummary>(() => {
    return members.reduce(
      (acc, member) => {
        if (member.isActive) acc.active += 1;
        else acc.inactive += 1;
        if (member.isActive && !member.conductSigned) acc.conductMissing += 1;
        if (member.isActive && !member.inductionCompleted) acc.inductionMissing += 1;
        if (member.isActive && getTrusteeEvidence(member).nearNineYears) acc.termReview += 1;
        return acc;
      },
      { active: 0, inactive: 0, conductMissing: 0, inductionMissing: 0, termReview: 0 },
    );
  }, [members]);

  const formDisabledReason = useMemo(() => {
    if (!canManage) return 'Only organisation owners and administrators can change the board register.';
    if (!formName.trim()) return 'Add the trustee name before saving.';
    if (!formRole.trim()) return 'Add the trustee role before saving.';
    if (!formAppointed) return 'Add the appointment date before saving.';
    return '';
  }, [canManage, formAppointed, formName, formRole]);

  const boardDataReady = !loading && !loadError;

  const resetForm = useCallback(() => {
    setFormName('');
    setFormRole('');
    setFormEmail('');
    setFormAppointed('');
    setFormTermEnd('');
    setFormConductSigned(false);
    setFormConductDate('');
    setFormInduction(false);
    setFormInductionDate('');
    setFormError('');
    setEditing(null);
  }, []);

  useEffect(() => {
    setGovernanceAccessRevoked(false);
  }, [user?.id, user?.role]);

  useEffect(() => {
    if (canManage) return;
    memberModal.onClose();
    resetForm();
  }, [canManage, memberModal, resetForm]);

  const reconcileForbiddenMutation = useCallback(async (error: unknown) => {
    if (!isApiForbiddenError(error)) return false;
    setGovernanceAccessRevoked(true);
    setMutatingMemberId(null);
    memberModal.onClose();
    resetForm();
    toast('Your role no longer allows board register changes. The page is now read-only.', 'error');
    await refreshUser();
    return true;
  }, [memberModal, refreshUser, resetForm, toast]);

  const openAdd = useCallback(() => {
    if (!canManage) return;
    resetForm();
    memberModal.onOpen();
  }, [canManage, memberModal, resetForm]);

  const openEdit = useCallback((member: BoardMemberResponse) => {
    if (!canManage) return;
    setEditing(member);
    setFormName(member.name);
    setFormRole(member.role);
    setFormEmail(member.email ?? '');
    setFormAppointed(member.appointedDate ? member.appointedDate.slice(0, 10) : '');
    setFormTermEnd(member.termEndDate ? member.termEndDate.slice(0, 10) : '');
    setFormConductSigned(member.conductSigned);
    setFormConductDate(member.conductSignedDate ? member.conductSignedDate.slice(0, 10) : '');
    setFormInduction(member.inductionCompleted);
    setFormInductionDate(member.inductionDate ? member.inductionDate.slice(0, 10) : '');
    setFormError('');
    memberModal.onOpen();
  }, [canManage, memberModal]);

  const handleSave = useCallback(async () => {
    if (!canManage) {
      setFormError('Only organisation owners and administrators can change the board register.');
      return;
    }
    if (formDisabledReason) {
      setFormError(formDisabledReason);
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      if (editing) {
        const body: UpdateBoardMemberRequest = {
          name: formName.trim(),
          role: formRole.trim(),
          email: formEmail.trim() || null,
          appointedDate: formAppointed,
          termEndDate: formTermEnd || null,
          conductSigned: formConductSigned,
          conductSignedDate: formConductSigned && formConductDate ? formConductDate : null,
          inductionCompleted: formInduction,
          inductionDate: formInduction && formInductionDate ? formInductionDate : null,
        };
        await api.patch(`/board-members/${editing.id}`, body);
      } else {
        const body: CreateBoardMemberRequest = {
          name: formName.trim(),
          role: formRole.trim(),
          email: formEmail.trim() || undefined,
          appointedDate: formAppointed,
          termEndDate: formTermEnd || undefined,
          conductSigned: formConductSigned,
          conductSignedDate: formConductSigned && formConductDate ? formConductDate : undefined,
          inductionCompleted: formInduction,
          inductionDate: formInduction && formInductionDate ? formInductionDate : undefined,
        };
        await api.post('/board-members', body);
      }

      resetForm();
      memberModal.onClose();
      await fetchMembers();
      toast(editing ? 'Board member updated' : 'Board member added');
    } catch (err) {
      if (await reconcileForbiddenMutation(err)) return;
      const message = apiErrorMessage(err, 'Failed to save board member');
      logClientError('Save failed', err);
      setFormError(message);
      toast(message, 'error');
    } finally {
      setSaving(false);
    }
  }, [
    canManage,
    editing,
    fetchMembers,
    formAppointed,
    formConductDate,
    formConductSigned,
    formDisabledReason,
    formEmail,
    formInduction,
    formInductionDate,
    formName,
    formRole,
    formTermEnd,
    memberModal,
    reconcileForbiddenMutation,
    resetForm,
    toast,
  ]);

  const toggleActive = useCallback(async (member: BoardMemberResponse) => {
    if (!canManage) return;
    setMutatingMemberId(member.id);
    try {
      await api.patch(`/board-members/${member.id}`, {
        isActive: !member.isActive,
      });
      await fetchMembers();
      toast(member.isActive ? 'Board member marked inactive' : 'Board member reactivated');
    } catch (err) {
      if (await reconcileForbiddenMutation(err)) return;
      const message = apiErrorMessage(err, 'Failed to update board member');
      logClientError('Toggle failed', err);
      toast(message, 'error');
    } finally {
      setMutatingMemberId(null);
    }
  }, [canManage, fetchMembers, reconcileForbiddenMutation, toast]);

  return {
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
  };
}
