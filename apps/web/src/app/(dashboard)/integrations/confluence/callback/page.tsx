'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@heroui/react';
import { useDocumentTitle } from '@/lib/use-title';
import { removeSensitiveSearchParams } from '@/lib/url-security';
import { completeConfluenceCallback, type CallbackOutcome } from '@/lib/confluence-callback';
import { AppPage } from '@/components/ui/app-page';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { AuthStatusIcon } from '@/components/ui/auth-status-icon';
import { Check } from 'lucide-react';

// The two secrets Atlassian hands back on the query string. Never logged,
// never put in a message, and — once the exchange has run, success or
// failure — never left sitting in the URL: see `confluence-callback.ts` for
// why they cannot be treated as anything but single-use secrets.
const CODE_PARAM = 'code';
const STATE_PARAM = 'state';

function scrubCallbackUrlSecrets() {
  if (typeof window === 'undefined') return;
  const scrubbed = removeSensitiveSearchParams(window.location.href, [CODE_PARAM, STATE_PARAM, 'error']);
  window.history.replaceState(window.history.state, '', scrubbed);
}

function ConfluenceCallbackContent() {
  useDocumentTitle('Connecting Confluence');
  const searchParams = useSearchParams();
  const ranRef = useRef(false);
  const [outcome, setOutcome] = useState<CallbackOutcome | null>(null);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const code = searchParams.get(CODE_PARAM);
    const state = searchParams.get(STATE_PARAM);
    const deniedByAtlassian = searchParams.get('error');

    // The code and state have now been read out of the URL for good — they
    // are never re-derived from `window.location` again on this page, and
    // the URL itself is scrubbed immediately, whatever happens next.
    scrubCallbackUrlSecrets();

    if (deniedByAtlassian || !code || !state) {
      setOutcome({
        kind: 'failed',
        message: 'Atlassian did not return an authorisation. Start the connection again from CharityPilot.',
      });
      return;
    }

    completeConfluenceCallback({ code, state }).then(setOutcome);
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
