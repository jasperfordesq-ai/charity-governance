'use client';

import { logClientError } from '@/lib/client-logger';
import { useEffect } from 'react';
import { Button } from '@heroui/react';
import { RefreshCcw } from 'lucide-react';
import { ErrorState } from '@/components/ui/states';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function Error({ error, reset }: ErrorProps) {
  useEffect(() => {
    logClientError('Application error boundary failed', error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 dark:bg-gray-950">
      <div className="w-full max-w-lg">
        <div className="mb-10 text-center">
          <span className="text-3xl font-extrabold tracking-tight text-teal-primary">
            CharityPilot
          </span>
        </div>

        <ErrorState
          title="Something went wrong"
          description={(
            <>
              We&apos;re sorry - an unexpected error occurred. Our team has been notified. Please
              try again, and if the problem persists contact{' '}
              <a
                href="mailto:support@charitypilot.ie"
                className="text-teal-primary underline underline-offset-2 hover:text-teal-dark dark:text-teal-light"
              >
                support@charitypilot.ie
              </a>
              .
            </>
          )}
          action={(
            <Button
              type="button"
              radius="md"
              onPress={reset}
              startContent={<RefreshCcw className="h-4 w-4" strokeWidth={2} aria-hidden="true" />}
              className="bg-teal-primary font-semibold text-white hover:bg-teal-dark"
            >
              Try again
            </Button>
          )}
          variant="page"
        />
      </div>
    </div>
  );
}
