'use client';

import { Button } from '@heroui/react';
import { AppSection } from '@/components/ui/app-page';
import { SourceReferenceList } from '@/components/ui/source-reference';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { StatusChip, statusPanelClassName } from '@/components/ui/status';
import type { DeadlineView } from '@/lib/deadline-contract';
import {
  generatedDeadlineLabel,
  generationSourceLabel,
  generationSourceReferences,
  isGeneratedDeadline,
  isLegacyCompletionDateUnknown,
} from '@/lib/deadline-contract';
import { formatCivilDate } from '@/lib/civil-date';

function formatInstant(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function DeadlineHistoryPanel({
  history,
  loading,
  error,
  hasMore,
  onRetry,
  onLoadMore,
}: {
  history: DeadlineView[];
  loading: boolean;
  error: string;
  hasMore: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  return (
    <AppSection
      title="Deadline history"
      description="Completed and superseded generated occurrences remain read-only so trustees can see what changed without rewriting earlier governance records."
      actions={<StatusChip tone="neutral">{history.length} loaded</StatusChip>}
    >
      {loading && history.length === 0 ? (
        <LoadingState title="Loading deadline history" description="Retrieving completed and superseded occurrences and their provenance." />
      ) : error && history.length === 0 ? (
        <ErrorState
          title="Deadline history could not be loaded"
          description={error}
          action={<Button size="sm" variant="flat" onPress={onRetry}>Try again</Button>}
        />
      ) : history.length === 0 ? (
        <EmptyState
          title="No deadline history yet"
          description="Completed or superseded generated occurrences will appear here and remain separate from current work."
        />
      ) : (
        <div className="space-y-3">
          {error ? (
            <ErrorState
              title="More history could not be loaded"
              description={error}
              action={<Button size="sm" variant="flat" onPress={onRetry}>Retry</Button>}
            />
          ) : null}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {history.map((deadline) => {
              const generated = isGeneratedDeadline(deadline);
              const source = generationSourceLabel(deadline);
              const sourceReferences = generationSourceReferences(deadline);
              const completedAt = formatInstant(deadline.completedDate);
              const legacyCompletionDateUnknown = isLegacyCompletionDateUnknown(deadline);
              const supersededAt = formatInstant(deadline.supersededAt);
              const lifecycleLabel = deadline.supersededAt
                ? 'Superseded'
                : deadline.isComplete
                  ? 'Completed'
                  : 'Current';
              return (
                <article
                  key={deadline.id}
                  aria-labelledby={`history-deadline-${deadline.id}`}
                  className={statusPanelClassName('neutral', 'p-4')}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <h3 id={`history-deadline-${deadline.id}`} className="break-words text-sm font-semibold text-gray-950 dark:text-gray-50">
                        {deadline.title}
                      </h3>
                      <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                        Due {formatCivilDate(deadline.dueDate)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <StatusChip tone={deadline.supersededAt ? 'warning' : deadline.isComplete ? 'success' : 'info'}>
                        {lifecycleLabel}
                      </StatusChip>
                      <StatusChip tone={generated ? 'info' : 'neutral'}>
                        {generatedDeadlineLabel(deadline)}
                      </StatusChip>
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-1 gap-2 text-xs text-gray-600 dark:text-gray-300 sm:grid-cols-2">
                    {completedAt ? (
                      <div><dt className="font-semibold">Completed</dt><dd>{completedAt}</dd></div>
                    ) : legacyCompletionDateUnknown ? (
                      <div className="sm:col-span-2">
                        <dt className="font-semibold">Completed</dt>
                        <dd>Completion date not recorded (legacy)</dd>
                      </div>
                    ) : null}
                    {supersededAt ? <div><dt className="font-semibold">Superseded</dt><dd>{supersededAt}</dd></div> : null}
                    {deadline.supersessionReason ? <div><dt className="font-semibold">Reason</dt><dd>{deadline.supersessionReason}</dd></div> : null}
                    {source ? <div><dt className="font-semibold">Source</dt><dd>{source}</dd></div> : null}
                    {deadline.generationRuleVersion ? <div><dt className="font-semibold">Rule version</dt><dd>{deadline.generationRuleVersion}</dd></div> : null}
                    {deadline.supersededById ? <div><dt className="font-semibold">Successor record</dt><dd className="break-all font-mono">{deadline.supersededById}</dd></div> : null}
                  </dl>
                  {sourceReferences.length ? (
                    <SourceReferenceList
                      sources={sourceReferences}
                      label="Official sources"
                      max={3}
                      className="mt-3"
                    />
                  ) : null}
                </article>
              );
            })}
          </div>
          {hasMore ? (
            <div className="flex justify-center">
              <Button size="sm" variant="flat" isLoading={loading} onPress={onLoadMore}>
                Load more history
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </AppSection>
  );
}
