'use client';

import { Button } from '@heroui/react';
import { AppSection } from '@/components/ui/app-page';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { StatusChip, statusPanelClassName, type StatusTone } from '@/components/ui/status';
import type { DeadlineReminderHistoryEntry, DeadlineView } from '@/lib/deadline-contract';
import { formatCivilDate } from '@/lib/civil-date';

function reminderTone(status: string, reconciliationOutcome?: string | null): StatusTone {
  if (status === 'SENT') return 'success';
  if (status === 'UNCERTAIN' && reconciliationOutcome) return 'warning';
  if (status === 'FAILED' || status === 'UNCERTAIN') return 'danger';
  if (status === 'SENDING') return 'warning';
  return 'neutral';
}

function reminderLabel(status: string, reconciliationOutcome?: string | null): string {
  if (status === 'SENT') return 'Provider accepted';
  if (status === 'UNCERTAIN' && reconciliationOutcome === 'ACCEPTED_CONFIRMED') return 'Reconciled: provider accepted';
  if (status === 'UNCERTAIN' && reconciliationOutcome === 'NOT_ACCEPTED_CONFIRMED') return 'Reconciled: provider did not accept';
  if (status === 'UNCERTAIN' && reconciliationOutcome) return 'Reconciled: outcome unknown';
  if (status === 'SENDING') return 'Sending';
  if (status === 'UNCERTAIN') return 'Needs reconciliation';
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function reconciliationLabel(outcome: string): string {
  if (outcome === 'ACCEPTED_CONFIRMED') return 'Provider acceptance confirmed; duplicate suppressed';
  if (outcome === 'NOT_ACCEPTED_CONFIRMED') return 'Provider non-acceptance confirmed; fresh attempt allowed';
  return 'Outcome acknowledged as unknowable';
}

function formatInstant(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Time unavailable';
  return parsed.toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function DeadlineReminderHistoryPanel({
  reminders,
  deadlines,
  loading,
  error,
  hasMore,
  total,
  onRetry,
  onLoadMore,
}: {
  reminders: DeadlineReminderHistoryEntry[];
  deadlines: DeadlineView[];
  loading: boolean;
  error: string;
  hasMore: boolean;
  total: number;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  const deadlineById = new Map(deadlines.map((deadline) => [deadline.id, deadline]));

  return (
    <AppSection
      title="Reminder delivery history"
      description="Delivery attempts are recorded separately from deadline status. Unresolved uncertain outcomes are suppressed until restricted provider reconciliation; only proof that the provider never accepted or created the message can enable a fresh attempt."
      actions={<StatusChip tone="neutral">{total} attempts</StatusChip>}
    >
      {loading && reminders.length === 0 ? (
        <LoadingState title="Loading reminder history" description="Checking recorded email delivery attempts." />
      ) : error ? (
        <ErrorState
          title="Reminder history could not be loaded"
          description={error}
          action={<Button size="sm" variant="flat" onPress={onRetry}>Try again</Button>}
        />
      ) : reminders.length === 0 ? (
        <EmptyState
          title="No reminder attempts yet"
          description="Attempts will appear after a configured 30, 14, or 7-day reminder window is reached."
        />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {reminders.map((reminder) => {
              const deadline = deadlineById.get(reminder.deadlineId);
              const title = reminder.deadlineTitle || deadline?.title || 'Archived deadline';
              const dueDate = reminder.deadlineDueDate || deadline?.dueDate;
              return (
                <article
                  key={reminder.id}
                  aria-labelledby={`reminder-history-${reminder.id}`}
                  className={statusPanelClassName(
                    reminderTone(String(reminder.status), reminder.reconciliationOutcome),
                    'p-4',
                  )}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <h3 id={`reminder-history-${reminder.id}`} className="break-words text-sm font-semibold text-gray-950 dark:text-gray-50">
                        {title}
                      </h3>
                      <p className="mt-1 break-all text-xs text-gray-600 dark:text-gray-300">
                        {reminder.email}
                      </p>
                    </div>
                    <StatusChip tone={reminderTone(String(reminder.status), reminder.reconciliationOutcome)}>
                      {reminderLabel(String(reminder.status), reminder.reconciliationOutcome)}
                    </StatusChip>
                  </div>
                  <dl className="mt-3 grid grid-cols-1 gap-2 text-xs text-gray-600 dark:text-gray-300 sm:grid-cols-2">
                    <div><dt className="font-semibold">Reminder window</dt><dd>{reminder.reminderDays} days before</dd></div>
                    {reminder.legacyDeliveryStatus ? (
                      <div><dt className="font-semibold">Legacy system status</dt><dd>{reminder.legacyDeliveryStatus} (unverified)</dd></div>
                    ) : null}
                    {reminder.deliveryTimingKnown ? (
                      <>
                        {reminder.reservedAt ? <div><dt className="font-semibold">Reserved</dt><dd>{formatInstant(reminder.reservedAt)}</dd></div> : null}
                        {reminder.attemptedAt ? <div><dt className="font-semibold">Attempted</dt><dd>{formatInstant(reminder.attemptedAt)}</dd></div> : null}
                        {reminder.providerRequestStartedAt ? <div><dt className="font-semibold">Provider request started</dt><dd>{formatInstant(reminder.providerRequestStartedAt)}</dd></div> : null}
                        {reminder.sentAt ? <div><dt className="font-semibold">Provider accepted</dt><dd>{formatInstant(reminder.sentAt)}</dd></div> : null}
                      </>
                    ) : (
                      reminder.legacyRecordedAt ? (
                        <div><dt className="font-semibold">Legacy timestamp</dt><dd>{formatInstant(reminder.legacyRecordedAt)} (original meaning unverified)</dd></div>
                      ) : null
                    )}
                    {reminder.reconciliationOutcome && reminder.reconciledAt ? (
                      <div><dt className="font-semibold">Operator reconciliation</dt><dd>{reconciliationLabel(String(reminder.reconciliationOutcome))} on {formatInstant(reminder.reconciledAt)}</dd></div>
                    ) : null}
                    {dueDate ? <div><dt className="font-semibold">Deadline due</dt><dd>{formatCivilDate(dueDate)}</dd></div> : null}
                    {reminder.error ? <div><dt className="font-semibold">Delivery note</dt><dd>{reminder.error}</dd></div> : null}
                  </dl>
                  {!reminder.deadlineSnapshotKnown ? (
                    <p className="mt-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
                      Exact legacy email title, due date, schedule version, and lifecycle timing were not recorded. The title and due date shown are cutover context only.
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>
          {hasMore ? (
            <div className="flex justify-center">
              <Button size="sm" variant="flat" onPress={onLoadMore} isLoading={loading}>
                Load more reminder attempts
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </AppSection>
  );
}
