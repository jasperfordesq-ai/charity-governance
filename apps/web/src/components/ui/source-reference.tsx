import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';

export type SourceReference = {
  name: ReactNode;
  url: string;
  lastChecked?: string | null;
};

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

export function SourceReferenceLink({
  source,
  className,
}: {
  source: SourceReference;
  className?: string;
}) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      className={classes(
        'rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-teal-dark transition-colors hover:border-teal-primary hover:bg-teal-primary/10 dark:border-gray-700 dark:text-teal-bright dark:hover:border-teal-bright',
        className,
      )}
    >
      {source.name}
    </a>
  );
}

export function SourceReferenceList({
  sources,
  label = 'Sources',
  max = 3,
  className,
}: {
  sources: SourceReference[];
  label?: string;
  max?: number;
  className?: string;
}) {
  const visibleSources = sources.slice(0, max);
  const remainingCount = Math.max(0, sources.length - visibleSources.length);

  if (visibleSources.length === 0) {
    return (
      <p className={classes('text-xs leading-5 text-gray-500 dark:text-gray-400', className)}>
        {label}: current guidance
      </p>
    );
  }

  return (
    <div className={classes('flex flex-wrap items-center gap-2 text-xs leading-5', className)}>
      <span className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}:</span>
      {visibleSources.map((source) => (
        <SourceReferenceLink key={source.url} source={source} />
      ))}
      {remainingCount > 0 ? (
        <span className="rounded-md border border-gray-200 px-2.5 py-1 font-medium text-gray-500 dark:border-gray-700 dark:text-gray-400">
          +{remainingCount} more
        </span>
      ) : null}
    </div>
  );
}

export function SourceReferenceCard({
  source,
  description,
  label = 'Official source',
  className,
}: {
  source: SourceReference;
  description?: ReactNode;
  label?: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      className={classes(
        'block rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition-colors hover:border-teal-primary/50 hover:bg-teal-primary/5 dark:border-gray-800 dark:bg-gray-950 dark:hover:border-teal-light/50 dark:hover:bg-teal-light/5',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-50">{source.name}</h3>
        <span className="inline-flex items-center gap-1 rounded-md border border-teal-primary/20 px-2.5 py-1 text-xs font-medium text-teal-dark dark:border-teal-light/30 dark:text-teal-bright">
          {label}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </div>
      {description ? (
        <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">{description}</p>
      ) : null}
    </a>
  );
}

export function SourceReferenceNote({
  source,
  label = 'Source',
  className,
}: {
  source: SourceReference;
  label?: string;
  className?: string;
}) {
  return (
    <p className={classes('text-xs leading-5 text-gray-500 dark:text-gray-400', className)}>
      {label}: <SourceReferenceLink source={source} className="border-0 px-0 py-0 underline-offset-4 hover:bg-transparent hover:underline dark:border-0" />
      {source.lastChecked ? <> (checked {source.lastChecked}).</> : null}
    </p>
  );
}
