import type { ReactNode } from 'react';
import {
  EvidenceChip,
  ReviewFlag,
  statusPanelClassName,
  type EvidenceStatus,
  type ReviewFlagTone,
} from '@/components/ui/status';
import { ReviewWarningState } from '@/components/ui/states';

type EvidencePrompt = {
  label: string;
  status?: EvidenceStatus;
  note?: ReactNode;
};

type EvidenceSource = {
  label: string;
  detail?: ReactNode;
  status?: EvidenceStatus;
};

type EvidenceReviewFlag = {
  label: string;
  tone?: ReviewFlagTone;
};

const evidenceRowClassName = statusPanelClassName(
  'neutral',
  'flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between',
);

export function EvidencePromptList({ prompts }: { prompts: Array<string | EvidencePrompt> }) {
  if (prompts.length === 0) return null;

  return (
    <ul className="space-y-2">
      {prompts.map((prompt, index) => {
        const item = typeof prompt === 'string' ? { label: prompt, status: 'missing' as EvidenceStatus } : prompt;
        return (
          <li
            key={`${item.label}-${index}`}
            className={evidenceRowClassName}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-950 dark:text-gray-50">{item.label}</p>
              {item.note ? <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">{item.note}</p> : null}
            </div>
            <EvidenceChip status={item.status ?? 'missing'} />
          </li>
        );
      })}
    </ul>
  );
}

export function EvidenceSourceList({ sources }: { sources: Array<string | EvidenceSource> }) {
  if (sources.length === 0) return null;

  return (
    <ul className="space-y-2">
      {sources.map((source, index) => {
        const item = typeof source === 'string' ? { label: source, status: 'ready' as EvidenceStatus } : source;
        return (
          <li
            key={`${item.label}-${index}`}
            className={evidenceRowClassName}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-950 dark:text-gray-50">{item.label}</p>
              {item.detail ? <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">{item.detail}</p> : null}
            </div>
            <EvidenceChip status={item.status ?? 'ready'} />
          </li>
        );
      })}
    </ul>
  );
}

export function EvidenceReadiness({
  title = 'Evidence readiness',
  description,
  prompts = [],
  sources = [],
  flags = [],
}: {
  title?: ReactNode;
  description?: ReactNode;
  prompts?: Array<string | EvidencePrompt>;
  sources?: Array<string | EvidenceSource>;
  flags?: Array<string | EvidenceReviewFlag>;
}) {
  const hasPrompts = prompts.length > 0;
  const hasSources = sources.length > 0;
  const hasFlags = flags.length > 0;

  if (!hasPrompts && !hasSources && !hasFlags) {
    return (
      <ReviewWarningState
        title="No evidence mapped yet"
        description="Add evidence prompts or source records when this governance area is ready to review."
      />
    );
  }

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-50">{title}</h2>
        {description ? <p className="text-sm leading-6 text-gray-600 dark:text-gray-300">{description}</p> : null}
      </div>

      {hasFlags ? (
        <div className="flex flex-wrap gap-2" aria-label="Evidence review flags">
          {flags.map((flag, index) => {
            const item = typeof flag === 'string' ? { label: flag, tone: 'needs-review' as ReviewFlagTone } : flag;
            return (
              <ReviewFlag key={`${item.label}-${index}`} tone={item.tone ?? 'needs-review'}>
                {item.label}
              </ReviewFlag>
            );
          })}
        </div>
      ) : null}

      {hasPrompts ? <EvidencePromptList prompts={prompts} /> : null}
      {hasSources ? <EvidenceSourceList sources={sources} /> : null}
    </section>
  );
}
