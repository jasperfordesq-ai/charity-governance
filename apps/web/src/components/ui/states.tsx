import type { ReactNode } from 'react';
import { CircleAlert, Clock, LoaderCircle, LockKeyhole, TriangleAlert } from 'lucide-react';

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
        'flex flex-col items-center justify-center rounded-lg border text-center',
        toneClasses[tone],
        variant === 'page' ? 'min-h-[360px] px-6 py-12' : 'px-4 py-6',
      )}
    >
      {icon ? <div className="mb-3 text-current">{icon}</div> : null}
      <h2 className={classes('font-semibold tracking-normal', variant === 'page' ? 'text-xl' : 'text-base')}>
        {title}
      </h2>
      {description ? (
        <p className="mt-2 max-w-xl text-sm leading-6 text-gray-600 dark:text-gray-300">{description}</p>
      ) : null}
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
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
