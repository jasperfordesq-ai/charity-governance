import type { ReactNode } from 'react';

type AppPageProps = {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
};

type AppSectionProps = {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
};

export function AppPage({ title, description, eyebrow, actions, children }: AppPageProps) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-4 border-b border-gray-200 pb-5 dark:border-gray-800 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-2">
          {eyebrow ? (
            <p className="text-xs font-semibold uppercase tracking-wide text-teal-primary dark:text-teal-bright">
              {eyebrow}
            </p>
          ) : null}
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-normal text-gray-950 dark:text-gray-50 sm:text-3xl">
              {title}
            </h1>
            {description ? (
              <p className="max-w-3xl text-sm leading-6 text-gray-600 dark:text-gray-300 sm:text-base">
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      <div className="flex flex-col gap-5">{children}</div>
    </div>
  );
}

export function AppSection({ title, description, actions, children }: AppSectionProps) {
  return (
    <section className="space-y-4">
      {(title || description || actions) ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            {title ? (
              <h2 className="text-lg font-semibold tracking-normal text-gray-950 dark:text-gray-50">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="max-w-3xl text-sm leading-6 text-gray-600 dark:text-gray-300">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
