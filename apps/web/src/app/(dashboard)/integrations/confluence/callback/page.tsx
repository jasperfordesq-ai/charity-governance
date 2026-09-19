'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@heroui/react';
import { useDocumentTitle } from '@/lib/use-title';
import { type CallbackOutcome } from '@/lib/confluence-callback';
import {
  confluenceCallbackPageDeps,
  runConfluenceCallbackOnce,
} from '@/lib/confluence-callback-page';
import { AppPage } from '@/components/ui/app-page';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { AuthStatusIcon } from '@/components/ui/auth-status-icon';
import { Check } from 'lucide-react';

// The secrets Atlassian hands back on the query string — and the scrub, the
// double-mount guard and the denial branch that act on them — live in
// `@/lib/confluence-callback-page`, where a test can drive them. This project
// has no React renderer in its test suite, so anything left inline in this
// effect is unpinned code, and `docs/ARCHITECTURE.md` states all three as
// fact. See `confluence-callback.ts` for why they can only ever be treated as
// single-use secrets.

function ConfluenceCallbackContent() {
  useDocumentTitle('Connecting Confluence');
  const searchParams = useSearchParams();
  const ranRef = useRef(false);
  const [outcome, setOutcome] = useState<CallbackOutcome | null>(null);

  useEffect(() => {
    runConfluenceCallbackOnce(
      ranRef,
      confluenceCallbackPageDeps((name) => searchParams.get(name), setOutcome),
    );
  }, [searchParams]);

  if (!outcome) {
    return (
      <LoadingState
        variant="page"
        title="Connecting to Confluence"
        description="Renewing your session and completing the connection. This only takes a moment."
      />
    );
  }

  if (outcome.kind === 'connected') {
    return (
      <div className="flex min-h-[360px] w-full flex-col items-center justify-center px-6 py-12 text-center">
        <AuthStatusIcon icon={Check} tone="success" />
        <h2 className="text-xl font-semibold tracking-normal text-gray-950 dark:text-gray-50">
          Confluence connected
        </h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-gray-600 dark:text-gray-300">
          {outcome.siteUrl
            ? `CharityPilot is now connected to ${outcome.siteUrl}.`
            : 'CharityPilot is now connected to Confluence.'}
        </p>
        <div className="mt-4">
          <Button as={Link} href="/integrations" color="primary" radius="lg">
            Back to Integrations
          </Button>
        </div>
      </div>
    );
  }

  const restart = outcome.kind === 'code-spent';

  return (
    <ErrorState
      variant="page"
      title={restart ? 'Connection needs to be restarted' : 'Confluence could not be connected'}
      description={outcome.message}
      action={
        <Button as={Link} href="/integrations" color="primary" radius="lg">
          {restart ? 'Restart from Integrations' : 'Back to Integrations'}
        </Button>
      }
    />
  );
}

function ConfluenceCallbackFallback() {
  return (
    <LoadingState
      variant="page"
      title="Connecting to Confluence"
      description="Renewing your session and completing the connection. This only takes a moment."
    />
  );
}

export default function ConfluenceCallbackPage() {
  return (
    <AppPage eyebrow="Integrations" title="Confluence">
      <Suspense fallback={<ConfluenceCallbackFallback />}>
        <ConfluenceCallbackContent />
      </Suspense>
    </AppPage>
  );
}
