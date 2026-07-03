import type { ReactNode } from 'react';

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
        <svg className="h-8 w-8 animate-spin text-teal-primary dark:text-teal-bright" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      }
    />
  );
}

export function EmptyState(props: BaseStateProps) {
  return (
    <StateShell
      {...props}
      icon={
        <svg className="h-8 w-8 text-gray-400 dark:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
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
        <svg className="h-8 w-8 text-rose-700 dark:text-rose-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008v.008H12v-.008zM10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
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
        <svg className="h-8 w-8 text-gray-500 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 0h10.5A1.5 1.5 0 0118.75 12v7.5A1.5 1.5 0 0117.25 21H6.75a1.5 1.5 0 01-1.5-1.5V12a1.5 1.5 0 011.5-1.5z" />
        </svg>
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
        <svg className="h-8 w-8 text-amber-700 dark:text-amber-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4.5m0 3h.008v.008H12V16.5zM2.25 12a9.75 9.75 0 1119.5 0 9.75 9.75 0 01-19.5 0z" />
        </svg>
      }
    />
  );
}
