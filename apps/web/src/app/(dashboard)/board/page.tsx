'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Card,
  Button,
  Input,
  Chip,
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from '@heroui/react';
import { api } from '@/lib/api';
import type {
  BoardMemberResponse,
  CreateBoardMemberRequest,
  UpdateBoardMemberRequest,
} from '@charitypilot/shared';

export default function BoardPage() {
  const [members, setMembers] = useState<BoardMemberResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);

  // Add / Edit modal
  const memberModal = useDisclosure();
  const [editing, setEditing] = useState<BoardMemberResponse | null>(null);
  const [saving, setSaving] = useState(false);

  // Form fields
  const [formName, setFormName] = useState('');
  const [formRole, setFormRole] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formAppointed, setFormAppointed] = useState('');
  const [formTermEnd, setFormTermEnd] = useState('');
  const [formConductSigned, setFormConductSigned] = useState(false);
  const [formConductDate, setFormConductDate] = useState('');
  const [formInduction, setFormInduction] = useState(false);
  const [formInductionDate, setFormInductionDate] = useState('');

  const fetchMembers = useCallback(async () => {
    try {
      const res = await api.get('/board-members');
      setMembers(res.data?.data ?? res.data ?? []);
    } catch (err) {
      console.error('Failed to load board members', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  /* ── Reset form ── */
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
    setEditing(null);
  };

  /* ── Open add modal ── */
  const openAdd = () => {
    resetForm();
    memberModal.onOpen();
  };

  /* ── Open edit modal ── */
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
    memberModal.onOpen();
  };

  /* ── Save handler ── */
  const handleSave = async () => {
    if (!formName.trim() || !formRole.trim() || !formAppointed) return;

    setSaving(true);
    try {
      if (editing) {
        // Update
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
        // Create
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
      fetchMembers();
    } catch (err) {
      console.error('Save failed', err);
    } finally {
      setSaving(false);
    }
  };

  /* ── Toggle active / inactive ── */
  const toggleActive = async (member: BoardMemberResponse) => {
    try {
      await api.patch(`/board-members/${member.id}`, {
        isActive: !member.isActive,
      });
      fetchMembers();
    } catch (err) {
      console.error('Toggle failed', err);
    }
  };

  /* ── Derived data ── */
  const now = new Date();
  const displayMembers = members.filter((m) => showInactive || m.isActive);

  const yearsServed = (appointedDate: string) => {
    const d = new Date(appointedDate);
    return (now.getTime() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Board Members Register</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage your charity trustees. Track code of conduct, induction, and term limits.
          </p>
        </div>
        <Button className="bg-teal-primary text-white hover:bg-teal-dark" onPress={openAdd}>
          <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add Member
        </Button>
      </div>

      {/* Active/Inactive toggle */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={showInactive}
          aria-label="Show inactive members"
          onClick={() => setShowInactive(!showInactive)}
          className={`
            relative inline-flex h-6 w-11 items-center rounded-full transition-colors
            ${showInactive ? 'bg-teal-primary' : 'bg-gray-300'}
          `}
        >
          <span
            className={`
              inline-block h-4 w-4 transform rounded-full bg-white transition-transform
              ${showInactive ? 'translate-x-6' : 'translate-x-1'}
            `}
          />
        </button>
        <span className="text-sm text-gray-600">Show inactive members</span>
      </div>

      {/* Members table */}
      {loading ? (
        <Card className="p-6 animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-1/3 mb-5" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex gap-4 mb-3">
              <div className="h-3 bg-gray-200 rounded w-1/5" />
              <div className="h-3 bg-gray-200 rounded w-1/6" />
              <div className="h-3 bg-gray-200 rounded w-1/6" />
              <div className="h-3 bg-gray-200 rounded w-1/6" />
              <div className="h-3 bg-gray-200 rounded w-1/6" />
            </div>
          ))}
        </Card>
      ) : displayMembers.length === 0 ? (
        <Card className="p-12 border border-gray-200 text-center">
          <div className="text-gray-400 mb-3">
            <svg className="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
            </svg>
          </div>
          <p className="text-gray-500 mb-2">No board members added yet.</p>
          <p className="text-sm text-gray-400">Add your charity trustees to track their governance duties.</p>
        </Card>
      ) : (
        <>
        {/* Mobile card layout */}
        <div className="sm:hidden space-y-3">
          {displayMembers.map((m) => {
            const years = yearsServed(m.appointedDate);
            const nearNineYears = years >= 8;
            const overNineYears = years >= 9;
            return (
              <Card key={m.id} className="border border-gray-200 shadow-sm p-4">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-800">{m.name}</p>
                    <p className="text-xs text-gray-500">{m.role}</p>
                    {m.email && <p className="text-xs text-gray-400">{m.email}</p>}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {m.isActive ? (
                      <Chip size="sm" color="success" variant="dot">Active</Chip>
                    ) : (
                      <Chip size="sm" color="default" variant="dot">Inactive</Chip>
                    )}
                    {nearNineYears && m.isActive && (
                      <Chip size="sm" color={overNineYears ? 'danger' : 'warning'} variant="flat">
                        {Math.floor(years)}y served
                      </Chip>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                  <div>
                    <span className="text-gray-400">Appointed</span>
                    <p className="text-gray-600">{new Date(m.appointedDate).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                  </div>
                  <div>
                    <span className="text-gray-400">Term End</span>
                    <p className="text-gray-600">{m.termEndDate ? new Date(m.termEndDate).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not set'}</p>
                  </div>
                  <div>
                    <span className="text-gray-400">Conduct</span>
                    <div className="mt-0.5">{m.conductSigned ? <Chip size="sm" color="success" variant="flat">Signed</Chip> : <Chip size="sm" color="warning" variant="flat">Unsigned</Chip>}</div>
                  </div>
                  <div>
                    <span className="text-gray-400">Induction</span>
                    <div className="mt-0.5">{m.inductionCompleted ? <Chip size="sm" color="success" variant="flat">Done</Chip> : <Chip size="sm" color="warning" variant="flat">Pending</Chip>}</div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="flat" className="flex-1" onPress={() => openEdit(m)}>Edit</Button>
                  <Button size="sm" variant="flat" color={m.isActive ? 'warning' : 'success'} className="flex-1" onPress={() => toggleActive(m)}>
                    {m.isActive ? 'Deactivate' : 'Activate'}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>

        {/* Desktop table layout */}
        <Card className="border border-gray-200 shadow-sm overflow-hidden hidden sm:block">
          <div className="overflow-x-auto">
            <Table aria-label="Board members" removeWrapper>
              <TableHeader>
                <TableColumn>NAME</TableColumn>
                <TableColumn>ROLE</TableColumn>
                <TableColumn className="hidden md:table-cell">APPOINTED</TableColumn>
                <TableColumn className="hidden lg:table-cell">TERM END</TableColumn>
                <TableColumn>CONDUCT</TableColumn>
                <TableColumn>INDUCTION</TableColumn>
                <TableColumn>STATUS</TableColumn>
                <TableColumn>ACTIONS</TableColumn>
              </TableHeader>
              <TableBody>
                {displayMembers.map((m) => {
                  const years = yearsServed(m.appointedDate);
                  const nearNineYears = years >= 8;
                  const overNineYears = years >= 9;

                  return (
                    <TableRow key={m.id}>
                      <TableCell>
                        <div>
                          <p className="text-sm font-medium text-gray-800">{m.name}</p>
                          {m.email && (
                            <p className="text-xs text-gray-400">{m.email}</p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-gray-600">{m.role}</span>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <span className="text-sm text-gray-500">
                          {new Date(m.appointedDate).toLocaleDateString('en-IE', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </span>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {m.termEndDate ? (
                          <span className="text-sm text-gray-500">
                            {new Date(m.termEndDate).toLocaleDateString('en-IE', {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-300">Not set</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {m.conductSigned ? (
                          <Chip size="sm" color="success" variant="flat">Signed</Chip>
                        ) : (
                          <Chip size="sm" color="warning" variant="flat">Unsigned</Chip>
                        )}
                      </TableCell>
                      <TableCell>
                        {m.inductionCompleted ? (
                          <Chip size="sm" color="success" variant="flat">Done</Chip>
                        ) : (
                          <Chip size="sm" color="warning" variant="flat">Pending</Chip>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {m.isActive ? (
                            <Chip size="sm" color="success" variant="dot">Active</Chip>
                          ) : (
                            <Chip size="sm" color="default" variant="dot">Inactive</Chip>
                          )}
                          {nearNineYears && m.isActive && (
                            <Chip size="sm" color={overNineYears ? 'danger' : 'warning'} variant="flat">
                              {Math.floor(years)}y served
                            </Chip>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="flat"
                            onPress={() => openEdit(m)}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="flat"
                            color={m.isActive ? 'warning' : 'success'}
                            onPress={() => toggleActive(m)}
                          >
                            {m.isActive ? 'Deactivate' : 'Activate'}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
        </>
      )}

      {/* ── Add / Edit Modal ── */}
      <Modal isOpen={memberModal.isOpen} onOpenChange={memberModal.onOpenChange} size="2xl">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>{editing ? 'Edit Board Member' : 'Add Board Member'}</ModalHeader>
              <ModalBody>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    label="Full Name"
                    placeholder="e.g. Mary O'Brien"
                    value={formName}
                    onValueChange={setFormName}
                    isRequired
                  />
                  <Input
                    label="Role"
                    placeholder="e.g. Chairperson, Secretary, Treasurer, Trustee"
                    value={formRole}
                    onValueChange={setFormRole}
                    isRequired
                  />
                  <Input
                    label="Email (optional)"
                    placeholder="mary@example.com"
                    type="email"
                    value={formEmail}
                    onValueChange={setFormEmail}
                  />
                  <Input
                    label="Date Appointed"
                    type="date"
                    value={formAppointed}
                    onValueChange={setFormAppointed}
                    isRequired
                  />
                  <Input
                    label="Term End Date (optional)"
                    type="date"
                    value={formTermEnd}
                    onValueChange={setFormTermEnd}
                  />
                  <div />

                  {/* Conduct signed */}
                  <div className="sm:col-span-2 space-y-3">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        id="conductSigned"
                        checked={formConductSigned}
                        onChange={(e) => setFormConductSigned(e.target.checked)}
                        className="w-4 h-4 rounded border-gray-300 text-teal-primary focus:ring-teal-primary"
                      />
                      <label htmlFor="conductSigned" className="text-sm text-gray-700">
                        Code of Conduct signed
                      </label>
                      {formConductSigned && (
                        <Input
                          label="Date Signed"
                          type="date"
                          value={formConductDate}
                          onValueChange={setFormConductDate}
                          className="w-48"
                          size="sm"
                        />
                      )}
                    </div>

                    {/* Induction */}
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        id="inductionCompleted"
                        checked={formInduction}
                        onChange={(e) => setFormInduction(e.target.checked)}
                        className="w-4 h-4 rounded border-gray-300 text-teal-primary focus:ring-teal-primary"
                      />
                      <label htmlFor="inductionCompleted" className="text-sm text-gray-700">
                        Induction completed
                      </label>
                      {formInduction && (
                        <Input
                          label="Induction Date"
                          type="date"
                          value={formInductionDate}
                          onValueChange={setFormInductionDate}
                          className="w-48"
                          size="sm"
                        />
                      )}
                    </div>
                  </div>
                </div>
              </ModalBody>
              <ModalFooter>
                <Button variant="flat" onPress={() => { resetForm(); onClose(); }}>
                  Cancel
                </Button>
                <Button
                  className="bg-teal-primary text-white hover:bg-teal-dark"
                  onPress={handleSave}
                  isLoading={saving}
                  isDisabled={!formName.trim() || !formRole.trim() || !formAppointed}
                >
                  {editing ? 'Update' : 'Add Member'}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}
