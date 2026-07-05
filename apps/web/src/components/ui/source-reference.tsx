import type { ReactNode } from 'react';

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
