import type { ReactNode } from 'react';
import { CheckCircle2, CircleAlert, Clock, LoaderCircle, LockKeyhole, TriangleAlert } from 'lucide-react';

type StateVariant = 'compact' | 'page';

type BaseStateProps = {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  variant?: StateVariant;
};

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function StateShell({
  title,
  description,
  action,
  variant = 'compact',
  tone = 'neutral',
  role,
  ariaLive,
  icon,
}: BaseStateProps & {
  tone?: 'neutral' | 'danger' | 'warning' | 'locked';
  role?: 'alert' | 'status';
  ariaLive?: 'polite' | 'assertive';
  icon?: ReactNode;
}) {
  const toneClasses = {
    neutral: 'border-gray-200 bg-white text-gray-900 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100',
    danger: 'border-rose-200 bg-rose-50 text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100',
    warning: 'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100',
    locked: 'border-gray-200 bg-gray-50 text-gray-900 dark:border-gray-800 dark:bg-gray-900/80 dark:text-gray-100',
  };

  return (
    <div
      role={role}
      aria-live={ariaLive}
      className={classes(
        'flex w-full min-w-0 flex-col items-center justify-center overflow-hidden rounded-lg border text-center',
        toneClasses[tone],
        variant === 'page' ? 'min-h-[360px] px-6 py-12' : 'px-4 py-6',
      )}
    >
      {icon ? <div className="mb-3 shrink-0 text-current">{icon}</div> : null}
      <h2
        className={classes(
          'max-w-full break-words font-semibold tracking-normal',
          variant === 'page' ? 'text-xl' : 'text-base',
        )}
      >
        {title}
      </h2>
      {description ? (
        <p className="mt-2 max-w-xl break-words text-sm leading-6 text-gray-600 dark:text-gray-300">{description}</p>
      ) : null}
      {action ? <div className="mt-4 flex max-w-full flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export function LoadingState({
  title = 'Loading',
  description,
  variant,
}: Partial<Pick<BaseStateProps, 'title' | 'description' | 'variant'>>) {
  return (
    <StateShell
      title={title}
      description={description}
      variant={variant}
      role="status"
      ariaLive="polite"
      icon={
        <LoaderCircle className="h-8 w-8 animate-spin text-teal-primary dark:text-teal-bright" aria-hidden="true" />
      }
    />
  );
}

export function EmptyState(props: BaseStateProps) {
  return (
    <StateShell
      {...props}
      icon={
        <Clock className="h-8 w-8 text-gray-400 dark:text-gray-500" strokeWidth={1.5} aria-hidden="true" />
      }
    />
  );
}

export function ErrorState(props: BaseStateProps) {
  return (
    <StateShell
      {...props}
      tone="danger"
      role="alert"
      ariaLive="assertive"
      icon={
        <TriangleAlert className="h-8 w-8 text-rose-700 dark:text-rose-300" strokeWidth={1.5} aria-hidden="true" />
      }
    />
  );
}

export function LockedFeatureState(props: BaseStateProps) {
  return (
    <StateShell
      {...props}
      tone="locked"
      icon={
        <LockKeyhole className="h-8 w-8 text-gray-500 dark:text-gray-400" strokeWidth={1.5} aria-hidden="true" />
      }
    />
  );
}

export function ReviewWarningState(props: BaseStateProps) {
  return (
    <StateShell
      {...props}
      tone="warning"
      role="alert"
      ariaLive="polite"
      icon={
        <CircleAlert className="h-8 w-8 text-amber-700 dark:text-amber-300" strokeWidth={1.5} aria-hidden="true" />
      }
    />
  );
}

export function InlineStatus({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const toneClasses = {
    neutral: 'border-gray-200 bg-white text-gray-800 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100',
    warning: 'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100',
    danger: 'border-rose-200 bg-rose-50 text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100',
  };
  const iconClasses = {
    neutral: 'text-gray-500 dark:text-gray-400',
    success: 'text-emerald-700 dark:text-emerald-300',
    warning: 'text-amber-700 dark:text-amber-300',
    danger: 'text-rose-700 dark:text-rose-300',
  };
  const icon =
    tone === 'success' ? (
      <CheckCircle2 className={classes('mt-0.5 h-4 w-4 flex-shrink-0', iconClasses[tone])} aria-hidden="true" />
    ) : tone === 'danger' ? (
      <TriangleAlert className={classes('mt-0.5 h-4 w-4 flex-shrink-0', iconClasses[tone])} aria-hidden="true" />
    ) : (
      <CircleAlert className={classes('mt-0.5 h-4 w-4 flex-shrink-0', iconClasses[tone])} aria-hidden="true" />
    );

  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      aria-live={tone === 'danger' ? 'assertive' : 'polite'}
      className={classes('flex w-full min-w-0 gap-3 overflow-hidden rounded-lg border px-4 py-3 text-sm', toneClasses[tone])}
    >
      {icon}
      <p className="min-w-0 break-words leading-5">{children}</p>
    </div>
  );
}

export function SaveStatusIndicator({
  status,
  retryAction,
}: {
  status: 'idle' | 'saving' | 'saved' | 'error';
  retryAction?: ReactNode;
}) {
  if (status === 'idle') return null;

  const content = {
    saving: {
      label: 'Saving...',
      className: 'text-gray-500 dark:text-gray-400',
      icon: <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />,
    },
    saved: {
      label: 'Saved',
      className: 'font-medium text-emerald-700 dark:text-emerald-300',
      icon: <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />,
    },
    error: {
      label: 'Save failed',
      className: 'font-medium text-rose-600 dark:text-rose-300',
      icon: <TriangleAlert className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />,
    },
  }[status];

  return (
    <span
      role={status === 'error' ? 'alert' : 'status'}
      aria-live={status === 'error' ? 'assertive' : 'polite'}
      className={classes('flex min-w-0 flex-wrap items-center justify-end gap-2 text-xs', content.className)}
    >
      <span className="flex min-w-0 items-center gap-1">
        {content.icon}
        <span>{content.label}</span>
      </span>
      {status === 'error' && retryAction ? retryAction : null}
    </span>
  );
}
