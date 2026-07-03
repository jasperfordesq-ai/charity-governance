import type { ReactNode } from 'react';

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

export function FieldGroup({
  title,
  description,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={classes('space-y-4', className)}>
      {title ? <legend className="text-base font-semibold text-gray-950 dark:text-gray-50">{title}</legend> : null}
      {description ? (
        <p className={classes('text-sm leading-6 text-gray-600 dark:text-gray-300', title ? '-mt-3' : false)}>
          {description}
        </p>
      ) : null}
      <div className="grid gap-4">{children}</div>
    </fieldset>
  );
}

export function FormHint({
  children,
  tone = 'neutral',
  id,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'warning' | 'danger' | 'success';
  id?: string;
}) {
  const toneClasses = {
    neutral: 'text-gray-600 dark:text-gray-300',
    warning: 'text-amber-800 dark:text-amber-200',
    danger: 'text-rose-700 dark:text-rose-200',
    success: 'text-emerald-700 dark:text-emerald-200',
  };

  return (
    <p id={id} className={classes('text-sm leading-6', toneClasses[tone])}>
      {children}
    </p>
  );
}

export function ValidationSummary({
  title = 'Please review the following',
  errors,
}: {
  title?: ReactNode;
  errors: ReactNode[];
}) {
  if (errors.length === 0) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100"
    >
      <p className="text-sm font-semibold">{title}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6">
        {errors.map((error, index) => (
          <li key={index}>{error}</li>
        ))}
      </ul>
    </div>
  );
}

export function StickyFormActions({
  children,
  align = 'end',
}: {
  children: ReactNode;
  align?: 'start' | 'end' | 'between';
}) {
  const alignClasses = {
    start: 'justify-start',
    end: 'justify-end',
    between: 'justify-between',
  };

  return (
    <div className="sticky bottom-0 z-10 -mx-4 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95 sm:-mx-6 sm:px-6">
      <div className={classes('flex flex-wrap items-center gap-2', alignClasses[align])}>{children}</div>
    </div>
  );
}
