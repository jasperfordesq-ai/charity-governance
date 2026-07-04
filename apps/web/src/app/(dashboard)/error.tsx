'use client';

import { logClientError } from '@/lib/client-logger';
import { useEffect } from 'react';
import { Button, Card } from '@heroui/react';
import { CircleAlert, RefreshCcw } from 'lucide-react';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function DashboardError({ error, reset }: ErrorProps) {
  useEffect(() => {
    logClientError('[Dashboard Error]', error);
  }, [error]);

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="max-w-md w-full p-8 bg-white dark:bg-gray-900 border border-red-200 dark:border-red-500/20 text-center">
        <div className="w-14 h-14 rounded-full bg-red-50 dark:bg-red-500/10 flex items-center justify-center mx-auto mb-5">
          <CircleAlert className="w-7 h-7 text-red-400 dark:text-red-300" strokeWidth={1.5} aria-hidden="true" />
        </div>
        <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">Something went wrong</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          This page encountered an unexpected error. Your data is safe — please try again.
        </p>
        <Button
          onPress={reset}
          className="bg-teal-primary text-white font-semibold"
          radius="full"
        >
          <RefreshCcw className="w-4 h-4 mr-1.5" strokeWidth={2} aria-hidden="true" />
          Try again
        </Button>
      </Card>
    </div>
  );
}
