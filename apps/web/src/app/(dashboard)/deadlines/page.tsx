'use client';

import { useEffect, useState, useCallback } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import {
  Card,
  Button,
  Input,
  Textarea,
  Chip,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from '@heroui/react';
import { api } from '@/lib/api';
import { useToast } from '@/components/toast';
import type { DeadlineResponse, CreateDeadlineRequest } from '@charitypilot/shared';

export default function DeadlinesPage() {
  useDocumentTitle('Deadlines');
  const [deadlines, setDeadlines] = useState<DeadlineResponse[]>([]);
  const [loading, setLoading] = useState(true);

  // Add deadline modal
  const addModal = useDisclosure();
  const [formTitle, setFormTitle] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formDueDate, setFormDueDate] = useState('');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const fetchDeadlines = useCallback(async () => {
    try {
      const res = await api.get('/deadlines');
      setDeadlines(res.data?.data ?? res.data ?? []);
    } catch (err) {
      console.error('Failed to load deadlines', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDeadlines();
  }, [fetchDeadlines]);

  /* ── Add deadline ── */
  const handleAdd = async () => {
    if (!formTitle.trim() || !formDueDate) return;

    setSaving(true);
    try {
      const body: CreateDeadlineRequest = {
        title: formTitle.trim(),
        description: formDescription.trim() || undefined,
        dueDate: formDueDate,
        reminderDays: [30, 7, 1],
      };
      await api.post('/deadlines', body);
      setFormTitle('');
      setFormDescription('');
      setFormDueDate('');
      addModal.onClose();
      fetchDeadlines();
      toast('Deadline added');
    } catch (err) {
      console.error('Failed to add deadline', err);
      toast('Failed to add deadline', 'error');
    } finally {
      setSaving(false);
    }
  };

  /* ── Toggle complete ── */
  const toggleComplete = async (deadline: DeadlineResponse) => {
    try {
      await api.patch(`/deadlines/${deadline.id}`, {
        isComplete: !deadline.isComplete,
      });
      fetchDeadlines();
    } catch (err) {
      console.error('Toggle failed', err);
    }
  };

  /* ── Sorting and classification ── */
  const now = new Date();

  const sortedDeadlines = [...deadlines].sort((a, b) => {
    // Incomplete first, then by date ascending
    if (a.isComplete !== b.isComplete) return a.isComplete ? 1 : -1;
    return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
  });

  const getDeadlineStyle = (deadline: DeadlineResponse) => {
    if (deadline.isComplete) {
      return {
        border: 'border-gray-200',
        bg: 'bg-gray-50',
        chipColor: 'default' as const,
        chipLabel: 'Complete',
      };
    }

    const due = new Date(deadline.dueDate);
    // Normalise both dates to midnight to avoid DST/timezone off-by-one
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const daysUntil = Math.round((dueDay.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    if (daysUntil < 0) {
      return {
        border: 'border-red-200',
        bg: 'bg-red-50/50',
        chipColor: 'danger' as const,
        chipLabel: `${Math.abs(daysUntil)} days overdue`,
      };
    }
    if (daysUntil <= 30) {
      return {
        border: 'border-amber-200',
        bg: 'bg-amber-50/50',
        chipColor: 'warning' as const,
        chipLabel: daysUntil === 0 ? 'Due today' : `${daysUntil} days left`,
      };
    }
    return {
      border: 'border-green-200',
      bg: 'bg-white',
      chipColor: 'success' as const,
      chipLabel: `${daysUntil} days left`,
    };
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Deadline Tracker</h1>
          <p className="text-sm text-gray-500 mt-1">
            Keep track of Annual Returns, AGMs, and your custom deadlines.
          </p>
        </div>
        <Button className="bg-teal-primary text-white hover:bg-teal-dark" onPress={addModal.onOpen}>
          <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add Deadline
        </Button>
      </div>

      {/* Deadline list */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} className="p-5 animate-pulse">
              <div className="flex items-center gap-4">
                <div className="w-5 h-5 bg-gray-200 rounded" />
                <div className="flex-1">
                  <div className="h-4 bg-gray-200 rounded w-1/3 mb-2" />
                  <div className="h-3 bg-gray-200 rounded w-1/4" />
                </div>
                <div className="h-6 bg-gray-200 rounded w-20" />
              </div>
            </Card>
          ))}
        </div>
      ) : sortedDeadlines.length === 0 ? (
        <Card className="p-12 border border-gray-200 text-center">
          <div className="text-gray-400 mb-3">
            <svg className="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
            </svg>
          </div>
          <p className="text-gray-500 mb-2">No deadlines yet.</p>
          <p className="text-sm text-gray-400">
            Auto-generated deadlines will appear once your organisation profile is set up.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {sortedDeadlines.map((d) => {
            const style = getDeadlineStyle(d);
            const due = new Date(d.dueDate);

            return (
              <Card
                key={d.id}
                className={`border ${style.border} ${style.bg} shadow-sm transition-all`}
              >
                <div className="flex items-start gap-4 p-4 sm:p-5">
                  {/* Checkbox */}
                  <button
                    type="button"
                    onClick={() => toggleComplete(d)}
                    className={`
                      mt-0.5 flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors
                      ${d.isComplete
                        ? 'bg-green-500 border-green-500 text-white'
                        : 'border-gray-300 hover:border-teal-primary'
                      }
                    `}
                  >
                    {d.isComplete && (
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    )}
                  </button>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`text-sm font-semibold ${d.isComplete ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                          {d.title}
                        </p>
                        {d.description && (
                          <p className={`text-xs mt-0.5 ${d.isComplete ? 'text-gray-300' : 'text-gray-500'}`}>
                            {d.description}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className={`text-xs ${d.isComplete ? 'text-gray-300' : 'text-gray-400'}`}>
                            {due.toLocaleDateString('en-IE', {
                              weekday: 'short',
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })}
                          </span>
                          {d.isAutoGenerated && (
                            <Chip size="sm" variant="flat" color="secondary" className="text-xs" title="Generated automatically from your organisation profile">
                              System deadline
                            </Chip>
                          )}
                        </div>
                      </div>
                      <Chip size="sm" color={style.chipColor} variant="flat" className="flex-shrink-0">
                        {style.chipLabel}
                      </Chip>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Add Deadline Modal ── */}
      <Modal isOpen={addModal.isOpen} onOpenChange={addModal.onOpenChange}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Add Custom Deadline</ModalHeader>
              <ModalBody className="space-y-4">
                <Input
                  label="Title"
                  placeholder="e.g. Submit Annual Report to CRA"
                  value={formTitle}
                  onValueChange={setFormTitle}
                  isRequired
                />
                <Textarea
                  label="Description (optional)"
                  placeholder="Any additional notes..."
                  value={formDescription}
                  onValueChange={setFormDescription}
                  minRows={2}
                />
                <Input
                  label="Due Date"
                  type="date"
                  value={formDueDate}
                  onValueChange={setFormDueDate}
                  isRequired
                />
              </ModalBody>
              <ModalFooter>
                <Button variant="flat" onPress={onClose}>
                  Cancel
                </Button>
                <Button
                  className="bg-teal-primary text-white hover:bg-teal-dark"
                  onPress={handleAdd}
                  isLoading={saving}
                  isDisabled={!formTitle.trim() || !formDueDate}
                >
                  Add Deadline
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}
