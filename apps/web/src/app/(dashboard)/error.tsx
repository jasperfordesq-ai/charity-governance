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

export default function DashboardError({ error, reset }: ErrorProps) {
  useEffect(() => {
    logClientError('[Dashboard Error]', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-md">
        <ErrorState
          title="Something went wrong"
          description="This page encountered an unexpected error. Your data is safe - please try again."
          action={(
            <Button
              onPress={reset}
              className="bg-teal-primary font-semibold text-white"
              radius="md"
            >
              <RefreshCcw className="mr-1.5 h-4 w-4" strokeWidth={2} aria-hidden="true" />
              Try again
            </Button>
          )}
        />
      </div>
    </div>
  );
}
