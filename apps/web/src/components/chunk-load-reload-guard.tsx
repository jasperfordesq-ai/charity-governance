'use client';

import { useEffect } from 'react';
import {
  clearChunkLoadReloadAttempt,
  shouldAttemptChunkLoadReload,
} from '@/lib/chunk-load-recovery';

const STABLE_PAGE_CLEAR_DELAY_MS = 15_000;

export function ChunkLoadReloadGuard() {
  useEffect(() => {
    const reloadIfRecoverable = (error: unknown) => {
      if (shouldAttemptChunkLoadReload(error, window.sessionStorage)) {
        window.location.reload();
      }
    };

    const handleError = (event: ErrorEvent) => {
      reloadIfRecoverable(event.error ?? event.message);
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      reloadIfRecoverable(event.reason);
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    const clearAttemptTimer = window.setTimeout(() => {
      clearChunkLoadReloadAttempt(window.sessionStorage);
    }, STABLE_PAGE_CLEAR_DELAY_MS);

    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      window.clearTimeout(clearAttemptTimer);
    };
  }, []);

  return null;
}
