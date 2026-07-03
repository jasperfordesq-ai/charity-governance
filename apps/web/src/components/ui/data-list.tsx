import type { ReactNode } from 'react';

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

export function DataList({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={classes('space-y-3', className)}>
      {(title || description || actions) ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            {title ? <h2 className="text-base font-semibold text-gray-950 dark:text-gray-50">{title}</h2> : null}
            {description ? <p className="text-sm leading-6 text-gray-600 dark:text-gray-300">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function DataListTable({
  children,
  label = 'Data table',
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <div className="sr-only" id="data-list-scroll-hint">
        {label}. On small screens, scroll horizontally to view all columns.
      </div>
      <div
        className="overflow-x-auto"
        role="region"
        aria-label={label}
        aria-describedby="data-list-scroll-hint"
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  );
}

export function DataListItems({
  children,
  divided = true,
}: {
  children: ReactNode;
  divided?: boolean;
}) {
  return (
    <div
      className={classes(
        'rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900',
        divided && 'divide-y divide-gray-200 dark:divide-gray-800',
      )}
    >
      {children}
    </div>
  );
}
