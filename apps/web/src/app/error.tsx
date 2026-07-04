'use client';

import { logClientError } from '@/lib/client-logger';
import { useEffect } from 'react';
import { CircleAlert, RefreshCcw } from 'lucide-react';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function Error({ error, reset }: ErrorProps) {
  useEffect(() => {
    // Log the error to an error reporting service
    logClientError('Application error boundary failed', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col items-center justify-center px-4">
      <div className="text-center max-w-lg">
        {/* Logo */}
        <div className="mb-10">
          <span className="text-3xl font-extrabold text-teal-primary tracking-tight">
            CharityPilot
          </span>
        </div>

        {/* Error icon */}
        <div className="flex items-center justify-center mb-6">
          <div className="w-16 h-16 rounded-full bg-red-50 dark:bg-red-500/10 flex items-center justify-center">
            <CircleAlert className="w-8 h-8 text-red-400 dark:text-red-300" strokeWidth={1.5} aria-hidden="true" />
          </div>
        </div>

        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-3">Something went wrong</h1>
        <p className="text-gray-500 dark:text-gray-400 leading-relaxed mb-8">
          We&apos;re sorry — an unexpected error occurred. Our team has been notified. Please
          try again, and if the problem persists contact{' '}
          <a
            href="mailto:support@charitypilot.ie"
            className="text-teal-primary hover:text-teal-dark dark:text-teal-light underline underline-offset-2"
          >
            support@charitypilot.ie
          </a>
          .
        </p>

        <button
          onClick={reset}
          className="inline-flex items-center gap-2 bg-teal-primary text-white font-semibold px-6 py-3 rounded-full hover:bg-teal-dark transition-colors"
        >
          <RefreshCcw className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
          Try again
        </button>
      </div>
    </div>
  );
}
