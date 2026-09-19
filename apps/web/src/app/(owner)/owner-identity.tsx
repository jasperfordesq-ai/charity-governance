'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ownerApi } from '@/lib/owner-api';

/**
 * Who is signed in to the platform console.
 *
 * This console can suspend any charity on the platform, and until now it showed
 * nothing about whose account was doing it. An operator with two accounts, or
 * one who left a session open on a shared machine, had no way to tell which one
 * they were acting as — and every action they take is recorded against that
 * name in somebody else's audit trail.
 *
 * `GET /auth/me` has existed since the console shipped with nothing calling it.
 */
export function OwnerIdentity() {
  const pathname = usePathname();
  const [email, setEmail] = useState<string | null>(null);

  // Not on the sign-in pages: there is no session to describe there, and asking
  // would produce a 401 that the client would try to refresh and then redirect
  // on, throwing somebody off the page they are trying to sign in from.
  const anonymous = pathname === '/owner/login' || pathname === '/owner/set-password';

  useEffect(() => {
    if (anonymous) {
      setEmail(null);
      return;
    }
    let cancelled = false;
    ownerApi
      .me()
      .then((operator) => {
        if (!cancelled) setEmail(operator.email);
      })
      .catch(() => {
        // Nothing to say. The console is perfectly usable without a name in the
        // corner, and the API refuses the actions regardless.
        if (!cancelled) setEmail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [anonymous, pathname]);

  if (!email) return null;

  return (
    <span className="text-xs text-slate-400" data-testid="owner-identity">
      Signed in as <span className="text-slate-200">{email}</span>
    </span>
  );
}
