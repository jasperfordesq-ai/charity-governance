'use client';

import { Button, Checkbox, Input } from '@heroui/react';
import { DataList, DataListItems } from '@/components/ui/data-list';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { EmptyState, ErrorState, LoadingState, PermissionHint, SaveStatusIndicator } from '@/components/ui/states';
import { DeadlineBadge, StatusChip, type StatusTone, statusPanelClassName } from '@/components/ui/status';
import type { DeadlineView } from '@/lib/deadline-contract';
import {
  generatedDeadlineLabel,
  generationSourceLabel,
  isGeneratedDeadline,
} from '@/lib/deadline-contract';
import { deadlineMeta, formatCivilDate } from '@/lib/deadline-display';

// Retain the route's established domain name while delegating all arithmetic
// to the shared civil-calendar-backed helper.
const classifyDeadline = deadlineMeta;

export function DeadlineListPanel({
  loading,
  loadError,
  sortedDeadlines,
  deadlineSearchText,
  toggleDeadlineId,
  deletingDeadlineId,
  saving,
  canManage,
  onRetry,
  onAdd,
  onEdit,
  onDelete,
  onToggleComplete,
  onSearchTextChange,
}: {
  loading: boolean;
  loadError: string;
  sortedDeadlines: DeadlineView[];
  deadlineSearchText: string;
  toggleDeadlineId: string | null;
  deletingDeadlineId: string | null;
  saving: boolean;
  canManage: boolean;
  onRetry: () => void | Promise<void>;
  onAdd: () => void;
  onEdit: (deadline: DeadlineView) => void;
  onDelete: (deadline: DeadlineView) => void;
  onToggleComplete: (deadline: DeadlineView) => void | Promise<void>;
  onSearchTextChange: (value: string) => void;
}) {
  const deadlineMutationStatus: 'idle' | 'saving' | 'saved' | 'error' =
    toggleDeadlineId || deletingDeadlineId ? 'saving' : 'idle';

  return (
    <DataList
      title="Deadline list"
      description="Current items are ordered by completion state and due date. Completed or superseded generated occurrences remain in the read-only history below."
      actions={deadlineMutationStatus === 'idle' ? undefined : (
        <SaveStatusIndicator status={deadlineMutationStatus} />
      )}
    >
      <Input
        label="Search current deadlines"
        placeholder="Search by title, notes, or due date"
        value={deadlineSearchText}
        onValueChange={onSearchTextChange}
        isClearable
        onClear={() => onSearchTextChange('')}
      />
      {loading ? (
        <LoadingState title="Loading deadlines" description="Checking your governance calendar." />
      ) : loadError && sortedDeadlines.length === 0 ? (
        <ErrorState
          title="Deadlines could not be loaded"
          description={loadError}
          action={(
            <Button size="sm" variant="flat" onPress={onRetry}>
              Try again
            </Button>
          )}
        />
      ) : sortedDeadlines.length === 0 ? (
        <EmptyState
          title={deadlineSearchText.trim() ? 'No matching deadlines' : 'No deadlines yet'}
          description={deadlineSearchText.trim()
            ? 'Try another title, note, or YYYY-MM-DD due date.'
            : 'Auto-generated dates will appear once the organisation profile is set up. Add any board, funder, AGM, audit, or reporting dates you already know.'}
          action={canManage && !deadlineSearchText.trim() ? (
            <Button size="sm" className={primaryActionButtonClassName} onPress={onAdd}>
              Add first deadline
            </Button>
          ) : undefined}
        />
      ) : (
        <div className="space-y-3">
          {loadError ? (
            <ErrorState
              title="Some deadline data may be out of date"
              description={loadError}
              action={(
                <Button size="sm" variant="flat" onPress={onRetry}>
                  Refresh
                </Button>
              )}
            />
          ) : null}
          <DataListItems divided={false}>
            <div className="space-y-3 p-3">
              {!canManage ? (
                <PermissionHint>
                  Deadline changes are available to organisation owners and administrators. Members have read-only access.
                </PermissionHint>
              ) : null}
              {sortedDeadlines.map((deadline) => {
                const meta = classifyDeadline(deadline);
                const generated = isGeneratedDeadline(deadline);
                const sourceLabel = generationSourceLabel(deadline);
                const rowTone: StatusTone =
                  meta.dueState === 'overdue'
                    ? 'danger'
                    : meta.dueState === 'due-soon'
                      ? 'warning'
                      : 'neutral';
                return (
                  <article
                    key={deadline.id}
                    aria-labelledby={`deadline-title-${deadline.id}`}
                    className={statusPanelClassName(rowTone, 'p-4')}
                  >
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex min-w-0 gap-3">
                        <Checkbox
                          isSelected={deadline.isComplete}
                          aria-label={`Mark ${deadline.title}, due ${formatCivilDate(deadline.dueDate)}, as ${deadline.isComplete ? 'incomplete' : 'complete'}`}
                          size="sm"
                          color="success"
                          isDisabled={
                            Boolean(toggleDeadlineId) ||
                            Boolean(deletingDeadlineId) ||
                            !canManage ||
                            (generated && deadline.isComplete)
                          }
                          onValueChange={() => void onToggleComplete(deadline)}
                          className="mt-0.5 shrink-0"
                        />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 id={`deadline-title-${deadline.id}`} className={`break-words text-sm font-semibold ${deadline.isComplete ? 'text-gray-500 line-through dark:text-gray-400' : 'text-gray-950 dark:text-gray-50'}`}>
                              {deadline.title}
                            </h3>
                            {generated ? (
                              <StatusChip tone="info">{generatedDeadlineLabel(deadline)}</StatusChip>
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
                            Due {formatCivilDate(deadline.dueDate, true)}
                          </p>
                          {generated ? (
                            <div className="mt-1 space-y-1 text-xs leading-5 text-gray-500 dark:text-gray-400">
                              <p>
                                Calculated planning date{sourceLabel ? ` · ${sourceLabel}` : ''}
                                {deadline.generationRuleVersion ? ` · Rule ${deadline.generationRuleVersion}` : ''}. Confirm the authoritative date in the relevant regulator portal.
                              </p>
                              <p>
                                Completion is one-way. A later occurrence is created only after the relevant verified organisation input—such as a new financial year end, actual AGM/member action, or confirmed ARD—is recorded.
                              </p>
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <DeadlineBadge tone={meta.dueState} ariaLabel={`Deadline status: ${meta.badgeLabel}`}>
                          {meta.badgeLabel}
                        </DeadlineBadge>
                        {!generated && canManage ? (
                          <>
                            <Button
                              size="sm"
                              variant="flat"
                              onPress={() => onEdit(deadline)}
                              isDisabled={Boolean(toggleDeadlineId) || Boolean(deletingDeadlineId) || saving}
                            >
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="flat"
                              color="danger"
                              onPress={() => onDelete(deadline)}
                              isLoading={deletingDeadlineId === deadline.id}
                              isDisabled={
                                Boolean(toggleDeadlineId) ||
                                (Boolean(deletingDeadlineId) && deletingDeadlineId !== deadline.id) ||
                                saving
                              }
                            >
                              Delete
                            </Button>
                          </>
                        ) : null}
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
  );
}
