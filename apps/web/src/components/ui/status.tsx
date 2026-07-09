import type { ReactNode } from 'react';

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';
type Size = 'sm' | 'md';

const toneClasses: Record<StatusTone, string> = {
  neutral: 'border-gray-300 bg-gray-100 text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200',
  success: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-200',
  warning: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200',
  danger: 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-700 dark:bg-rose-950/60 dark:text-rose-200',
  info: 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-700 dark:bg-sky-950/60 dark:text-sky-200',
  brand: 'border-teal-primary/30 bg-teal-primary/10 text-teal-dark dark:border-teal-bright/40 dark:bg-teal-bright/10 dark:text-teal-bright',
};

const dotToneClasses: Record<StatusTone, string> = {
  neutral: 'bg-gray-400 dark:bg-gray-500',
  success: 'bg-emerald-500 dark:bg-emerald-400',
  warning: 'bg-amber-500 dark:bg-amber-300',
  danger: 'bg-rose-500 dark:bg-rose-400',
  info: 'bg-sky-500 dark:bg-sky-400',
  brand: 'bg-teal-primary dark:bg-teal-bright',
};

const panelToneClasses: Record<StatusTone, string> = {
  neutral: 'border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900',
  success: 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-800 dark:bg-emerald-950/30',
  warning: 'border-amber-200 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/30',
  danger: 'border-rose-200 bg-rose-50/70 dark:border-rose-800 dark:bg-rose-950/30',
  info: 'border-sky-200 bg-sky-50/70 dark:border-sky-800 dark:bg-sky-950/30',
  brand: 'border-teal-primary/20 bg-white dark:border-teal-light/20 dark:bg-gray-900',
};

const sizeClasses: Record<Size, string> = {
  sm: 'min-h-6 px-2 py-0.5 text-xs',
  md: 'min-h-7 px-2.5 py-1 text-sm',
};

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

export function statusPanelClassName(tone: StatusTone = 'neutral', className?: string) {
  return classes('rounded-lg border', panelToneClasses[tone], className);
}

export type StatusChipProps = {
  children: ReactNode;
  tone?: StatusTone;
  size?: Size;
  className?: string;
  ariaLabel?: string;
};

export function StatusChip({
  children,
  tone = 'neutral',
  size = 'sm',
  className,
  ariaLabel,
}: StatusChipProps) {
  return (
    <span
      aria-label={ariaLabel}
      className={classes(
        'inline-flex max-w-full items-center gap-1.5 rounded-md border font-medium leading-5',
        sizeClasses[size],
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusTile({
  title,
  detail,
  tone = 'neutral',
}: {
  title: ReactNode;
  detail: ReactNode;
  tone?: StatusTone;
}) {
  return (
    <div className={statusPanelClassName('neutral', 'p-4')}>
      <StatusChip tone={tone}>{title}</StatusChip>
      <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-300">{detail}</p>
    </div>
  );
}

export function StatusDot({
  tone = 'neutral',
  className,
  ariaLabel,
}: {
  tone?: StatusTone;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <span
      aria-label={ariaLabel}
      className={classes('inline-block h-2.5 w-2.5 shrink-0 rounded-full', dotToneClasses[tone], className)}
    />
  );
}

export type EvidenceStatus = 'ready' | 'partial' | 'missing' | 'review' | 'not-applicable';

const evidenceTone: Record<EvidenceStatus, StatusTone> = {
  ready: 'success',
  partial: 'warning',
  missing: 'danger',
  review: 'info',
  'not-applicable': 'neutral',
};

const evidenceLabel: Record<EvidenceStatus, string> = {
  ready: 'Evidence ready',
  partial: 'Partial evidence',
  missing: 'Evidence missing',
  review: 'Needs review',
  'not-applicable': 'Not applicable',
};

export function EvidenceChip({
  status,
  children,
  size,
}: {
  status: EvidenceStatus;
  children?: ReactNode;
  size?: Size;
}) {
  return (
    <StatusChip tone={evidenceTone[status]} size={size} ariaLabel={evidenceLabel[status]}>
      {children ?? evidenceLabel[status]}
    </StatusChip>
  );
}

export type ReviewFlagTone = 'needs-review' | 'blocked' | 'approved' | 'draft';

const reviewTone: Record<ReviewFlagTone, StatusTone> = {
  'needs-review': 'warning',
  blocked: 'danger',
  approved: 'success',
  draft: 'neutral',
};

export function ReviewFlag({
  tone,
  children,
  ariaLabel,
}: {
  tone: ReviewFlagTone;
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <StatusChip tone={reviewTone[tone]} ariaLabel={ariaLabel}>
      {children}
    </StatusChip>
  );
}

export type DeadlineBadgeTone = 'upcoming' | 'due-soon' | 'overdue' | 'complete';

const deadlineTone: Record<DeadlineBadgeTone, StatusTone> = {
  upcoming: 'info',
  'due-soon': 'warning',
  overdue: 'danger',
  complete: 'success',
};

export function DeadlineBadge({
  tone,
  children,
  ariaLabel,
}: {
  tone: DeadlineBadgeTone;
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <StatusChip tone={deadlineTone[tone]} ariaLabel={ariaLabel}>
      {children}
    </StatusChip>
  );
}
