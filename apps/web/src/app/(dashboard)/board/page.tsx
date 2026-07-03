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
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
  useDisclosure,
} from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useToast } from '@/components/toast';
import { AppPage } from '@/components/ui/app-page';
import { DataList, DataListItems, DataListTable } from '@/components/ui/data-list';
import { FieldGroup, FormHint, ValidationSummary } from '@/components/ui/forms';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { ReviewFlag, StatusChip } from '@/components/ui/status';
import { BoardEvidenceChips, TrusteeEvidencePromptCards, getTrusteeEvidence } from './board-evidence';
import type {
  BoardMemberResponse,
  CreateBoardMemberRequest,
  UpdateBoardMemberRequest,
} from '@charitypilot/shared';

const formatDate = (value: string | null | undefined) => {
  if (!value) return 'Not set';
  return new Date(value).toLocaleDateString('en-IE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

export default function BoardPage() {
  useDocumentTitle('Board Members');
  const [members, setMembers] = useState<BoardMemberResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [mutatingMemberId, setMutatingMemberId] = useState<string | null>(null);
  const { toast } = useToast();

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

  const summary = useMemo(() => {
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
    if (!formName.trim()) return 'Add the trustee name before saving.';
    if (!formRole.trim()) return 'Add the trustee role before saving.';
    if (!formAppointed) return 'Add the appointment date before saving.';
    return '';
  }, [formAppointed, formName, formRole]);

  const resetForm = () => {
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
  };

  const openAdd = () => {
    resetForm();
    memberModal.onOpen();
  };

  const openEdit = (member: BoardMemberResponse) => {
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
  };

  const handleSave = async () => {
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
      const message = apiErrorMessage(err, 'Failed to save board member');
      logClientError('Save failed', err);
      setFormError(message);
      toast(message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (member: BoardMemberResponse) => {
    setMutatingMemberId(member.id);
    try {
      await api.patch(`/board-members/${member.id}`, {
        isActive: !member.isActive,
      });
      await fetchMembers();
      toast(member.isActive ? 'Board member marked inactive' : 'Board member reactivated');
    } catch (err) {
      const message = apiErrorMessage(err, 'Failed to update board member');
      logClientError('Toggle failed', err);
      toast(message, 'error');
    } finally {
      setMutatingMemberId(null);
    }
  };

  return (
    <AppPage
      eyebrow="Trustee register"
      title="Board Members Register"
      description="Maintain a review-ready trustee register with conduct, induction, appointment, and term evidence for Irish charity governance workflows."
      actions={(
        <Button className="bg-teal-primary text-white hover:bg-teal-dark" onPress={openAdd}>
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add trustee
        </Button>
      )}
    >
      <section className="rounded-lg border border-teal-primary/20 bg-white p-5 shadow-sm dark:border-teal-light/20 dark:bg-gray-900">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <ReviewFlag tone="draft">Review-ready register</ReviewFlag>
            <h2 className="mt-3 text-lg font-semibold text-gray-950 dark:text-gray-50">
              Keep trustee evidence visible before annual review.
            </h2>
            <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
              Track who is active, when each trustee was appointed, and whether conduct and induction evidence is ready for board review.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:min-w-[28rem]">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
              <p className="text-xs text-gray-500 dark:text-gray-400">Active</p>
              <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{summary.active}</p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
              <p className="text-xs text-gray-500 dark:text-gray-400">Conduct gaps</p>
              <p className="text-xl font-bold text-amber-700 dark:text-amber-300">{summary.conductMissing}</p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
              <p className="text-xs text-gray-500 dark:text-gray-400">Induction gaps</p>
              <p className="text-xl font-bold text-amber-700 dark:text-amber-300">{summary.inductionMissing}</p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
              <p className="text-xs text-gray-500 dark:text-gray-400">Term review</p>
              <p className="text-xl font-bold text-rose-700 dark:text-rose-300">{summary.termReview}</p>
            </div>
          </div>
        </div>
      </section>

      <TrusteeEvidencePromptCards />

      <DataList
        title="Trustees"
        description="The active view is the default register. Toggle inactive members when you need historic appointment evidence."
        actions={(
          <div className="flex items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={showInactive}
              aria-label="Show inactive members"
              onClick={() => setShowInactive((value) => !value)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${showInactive ? 'bg-teal-primary' : 'bg-gray-300 dark:bg-gray-700'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${showInactive ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
            <span className="text-sm text-gray-600 dark:text-gray-300">Show inactive</span>
          </div>
        )}
      >
        {loading ? (
          <LoadingState title="Loading board register" description="Checking trustee appointment and evidence records." />
        ) : loadError && displayMembers.length === 0 ? (
          <ErrorState
            title="Board register could not be loaded"
            description={loadError}
            action={(
              <Button size="sm" variant="flat" onPress={() => fetchMembers(true)}>
                Try again
              </Button>
            )}
          />
        ) : displayMembers.length === 0 ? (
          <EmptyState
            title={showInactive ? 'No trustees in this view' : 'No active trustees added yet'}
            description={showInactive ? 'No active or inactive trustees are available.' : 'Add trustees so conduct, induction, appointment, and term evidence can be reviewed before annual sign-off.'}
            action={(
              <Button size="sm" className="bg-teal-primary text-white hover:bg-teal-dark" onPress={openAdd}>
                Add first trustee
              </Button>
            )}
          />
        ) : (
          <div className="space-y-3">
            {loadError ? (
              <ErrorState
                title="Some trustee data may be out of date"
                description={loadError}
                action={(
                  <Button size="sm" variant="flat" onPress={() => fetchMembers(true)}>
                    Refresh
                  </Button>
                )}
              />
            ) : null}
            <div aria-live="polite" className="sr-only">
              {mutatingMemberId ? 'Updating trustee status' : 'Board register ready'}
            </div>

            {/* Keep table and mobile card views at field parity for trustee evidence review. */}
            <div className="sm:hidden">
              <DataListItems divided={false}>
                <div className="space-y-3 p-3">
                  {displayMembers.map((member) => (
                    <article key={member.id} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
                      <div className="flex flex-col gap-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="break-words text-sm font-semibold text-gray-950 dark:text-gray-50">{member.name}</h3>
                            <p className="text-xs text-gray-600 dark:text-gray-300">{member.role}</p>
                            {member.email ? <p className="break-words text-xs text-gray-500 dark:text-gray-400">{member.email}</p> : null}
                          </div>
                          <StatusChip tone={member.isActive ? 'success' : 'neutral'}>
                            {member.isActive ? 'Active' : 'Inactive'}
                          </StatusChip>
                        </div>
                        <dl className="grid grid-cols-2 gap-3 text-xs text-gray-600 dark:text-gray-300">
                          <div>
                            <dt className="font-medium text-gray-500 dark:text-gray-400">Appointed</dt>
                            <dd>{formatDate(member.appointedDate)}</dd>
                          </div>
                          <div>
                            <dt className="font-medium text-gray-500 dark:text-gray-400">Term end</dt>
                            <dd>{formatDate(member.termEndDate)}</dd>
                          </div>
                          <div>
                            <dt className="font-medium text-gray-500 dark:text-gray-400">Conduct date</dt>
                            <dd>{formatDate(member.conductSignedDate)}</dd>
                          </div>
                          <div>
                            <dt className="font-medium text-gray-500 dark:text-gray-400">Induction date</dt>
                            <dd>{formatDate(member.inductionDate)}</dd>
                          </div>
                        </dl>
                        <BoardEvidenceChips member={member} />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="flat"
                            onPress={() => openEdit(member)}
                            isDisabled={Boolean(mutatingMemberId) || saving}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="flat"
                            color={member.isActive ? 'warning' : 'success'}
                            onPress={() => toggleActive(member)}
                            isLoading={mutatingMemberId === member.id}
                            isDisabled={Boolean(mutatingMemberId) && mutatingMemberId !== member.id}
                          >
                            {member.isActive ? 'Deactivate' : 'Activate'}
                          </Button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </DataListItems>
            </div>

            <div className="hidden sm:block">
              <DataListTable label="Board members" scrollHintId="board-register-scroll-hint">
                <Table aria-label="Board members" removeWrapper>
                  <TableHeader>
                    <TableColumn>Name</TableColumn>
                    <TableColumn>Role</TableColumn>
                    <TableColumn className="hidden md:table-cell">Appointed</TableColumn>
                    <TableColumn className="hidden lg:table-cell">Term end</TableColumn>
                    <TableColumn>Evidence</TableColumn>
                    <TableColumn>Status</TableColumn>
                    <TableColumn>Actions</TableColumn>
                  </TableHeader>
                  <TableBody>
                    {displayMembers.map((member) => (
                      <TableRow key={member.id}>
                        <TableCell>
                          <div className="min-w-44">
                            <p className="text-sm font-medium text-gray-950 dark:text-gray-50">{member.name}</p>
                            {member.email ? <p className="text-xs text-gray-500 dark:text-gray-400">{member.email}</p> : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-gray-700 dark:text-gray-300">{member.role}</span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="text-sm text-gray-600 dark:text-gray-300">{formatDate(member.appointedDate)}</span>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <span className="text-sm text-gray-600 dark:text-gray-300">{formatDate(member.termEndDate)}</span>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-2">
                            <BoardEvidenceChips member={member} />
                            <dl className="grid min-w-48 grid-cols-1 gap-1 text-xs text-gray-600 dark:text-gray-300 xl:grid-cols-2">
                              <div>
                                <dt className="font-medium text-gray-500 dark:text-gray-400">Conduct date</dt>
                                <dd>{formatDate(member.conductSignedDate)}</dd>
                              </div>
                              <div>
                                <dt className="font-medium text-gray-500 dark:text-gray-400">Induction date</dt>
                                <dd>{formatDate(member.inductionDate)}</dd>
                              </div>
                            </dl>
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusChip tone={member.isActive ? 'success' : 'neutral'}>
                            {member.isActive ? 'Active' : 'Inactive'}
                          </StatusChip>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="flat"
                              onPress={() => openEdit(member)}
                              isDisabled={Boolean(mutatingMemberId) || saving}
                            >
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="flat"
                              color={member.isActive ? 'warning' : 'success'}
                              onPress={() => toggleActive(member)}
                              isLoading={mutatingMemberId === member.id}
                              isDisabled={Boolean(mutatingMemberId) && mutatingMemberId !== member.id}
                            >
                              {member.isActive ? 'Deactivate' : 'Activate'}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </DataListTable>
            </div>
          </div>
        )}
      </DataList>

      <Modal isOpen={memberModal.isOpen} onOpenChange={memberModal.onOpenChange} size="2xl" scrollBehavior="inside">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>{editing ? 'Edit trustee' : 'Add trustee'}</ModalHeader>
              <ModalBody className="gap-5">
                <ValidationSummary errors={formError ? [formError] : []} />
                <FieldGroup
                  title="Trustee details"
                  description="Record the name, role, contact, and appointment dates that should appear in the trustee register."
                >
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Input
                      label="Full name"
                      placeholder="Mary O'Brien"
                      value={formName}
                      onValueChange={setFormName}
                      isRequired
                    />
                    <Input
                      label="Role"
                      placeholder="Chairperson, secretary, treasurer, trustee"
                      value={formRole}
                      onValueChange={setFormRole}
                      isRequired
                    />
                    <Input
                      label="Email"
                      placeholder="mary@example.com"
                      type="email"
                      value={formEmail}
                      onValueChange={setFormEmail}
                    />
                    <Input
                      label="Date appointed"
                      type="date"
                      value={formAppointed}
                      onValueChange={setFormAppointed}
                      isRequired
                    />
                    <Input
                      label="Term end date"
                      type="date"
                      value={formTermEnd}
                      onValueChange={setFormTermEnd}
                    />
                  </div>
                </FieldGroup>

                <FieldGroup
                  title="Conduct and induction evidence"
                  description="Use these fields to make trustee evidence prompts clear before annual review."
                >
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
                      <label className="flex items-start gap-3 text-sm font-medium text-gray-800 dark:text-gray-200">
                        <input
                          type="checkbox"
                          checked={formConductSigned}
                          onChange={(event) => setFormConductSigned(event.target.checked)}
                          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-teal-primary focus:ring-teal-primary dark:border-gray-700 dark:bg-gray-900"
                        />
                        Code of conduct signed
                      </label>
                      {formConductSigned ? (
                        <Input
                          label="Date signed"
                          type="date"
                          value={formConductDate}
                          onValueChange={setFormConductDate}
                          className="mt-3"
                        />
                      ) : (
                        <FormHint tone="warning">Add the signing date once the trustee conduct record is ready.</FormHint>
                      )}
                    </div>
                    <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
                      <label className="flex items-start gap-3 text-sm font-medium text-gray-800 dark:text-gray-200">
                        <input
                          type="checkbox"
                          checked={formInduction}
                          onChange={(event) => setFormInduction(event.target.checked)}
                          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-teal-primary focus:ring-teal-primary dark:border-gray-700 dark:bg-gray-900"
                        />
                        Induction completed
                      </label>
                      {formInduction ? (
                        <Input
                          label="Induction date"
                          type="date"
                          value={formInductionDate}
                          onValueChange={setFormInductionDate}
                          className="mt-3"
                        />
                      ) : (
                        <FormHint tone="warning">Add the induction date once the trustee has completed onboarding.</FormHint>
                      )}
                    </div>
                  </div>
                  <FormHint id="board-disabled-hint" tone={formDisabledReason ? 'warning' : 'neutral'}>
                    {formDisabledReason || 'Saving updates the trustee register after the API confirms the change.'}
                  </FormHint>
                </FieldGroup>
              </ModalBody>
              <ModalFooter>
                <Button variant="flat" onPress={() => { resetForm(); onClose(); }} isDisabled={saving}>
                  Cancel
                </Button>
                <Button
                  className="bg-teal-primary text-white hover:bg-teal-dark"
                  onPress={handleSave}
                  isLoading={saving}
                  isDisabled={Boolean(formDisabledReason) || saving}
                  aria-describedby="board-disabled-hint"
                >
                  {editing ? 'Save trustee' : 'Add trustee'}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </AppPage>
  );
}
