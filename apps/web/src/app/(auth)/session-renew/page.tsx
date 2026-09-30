'use client';

import { useEffect, useState } from 'react';
import { Button, Card, CardBody } from '@heroui/react';
import { api, refreshSession } from '@/lib/api';
import { safeNextPath } from '@/lib/safe-next-path';
import { safeNextValue } from '@/lib/url-security';
import { SessionRefreshLockUnavailableError } from '@/lib/session-refresh-lock';

function destination(): string {
  const offered = new URLSearchParams(window.location.search).get('next');
  const approved = new URL(safeNextPath(offered), window.location.origin);
  return safeNextValue(approved.pathname, approved.search);
}

export default function SessionRenewPage() {
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    const next = destination();
    async function renew() {
      try {
        // The reactive probe and Web Lock are shared with ordinary browser
        // requests. A second tab sees newly rotated cookies before it can
        // present a single-use refresh token.
        await refreshSession(true);
        await api.get('/auth/me', { skipAuthRefresh: true, skipAuthRedirect: true });
        if (active) window.location.replace(next);
      } catch (cause) {
        if (!active) return;
        if (cause instanceof SessionRefreshLockUnavailableError) {
          window.location.replace(`/login?next=${encodeURIComponent(next)}&session=renewal-unavailable`);
          return;
        }
        const status = (cause as { response?: { status?: number } })?.response?.status;
        if (status === 401) {
          window.location.replace(`/login?next=${encodeURIComponent(next)}`);
        } else {
          // An outage or failed current-session probe is not a logout.
          setError(true);
        }
      }
    }
    void renew();
    return () => { active = false; };
  }, [attempt]);

  return (
    <div className="w-full max-w-md min-w-0">
      <Card>
        <CardBody className="space-y-4 p-6 sm:p-10">
          <h1 className="text-2xl font-bold">Checking your session</h1>
          {error ? <>
            <p>We could not check your session just now. Please try again.</p>
            <Button color="primary" onPress={() => { setError(false); setAttempt((value) => value + 1); }}>
              Try again
            </Button>
          </> : <p role="status">Please wait while we securely renew your session.</p>}
        </CardBody>
      </Card>
    </div>
  );
}
