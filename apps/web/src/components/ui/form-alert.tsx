import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';

type FormAlertProps = {
  children: ReactNode;
  title?: string;
};

export function FormAlert({ children, title = 'Check the details' }: FormAlertProps) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-700 dark:text-rose-300" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <p className="mt-0.5 leading-5 text-rose-800 dark:text-rose-100">{children}</p>
      </div>
    </div>
  );
}
