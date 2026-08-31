import type { ReactNode } from 'react';
import { OwnerSignOutButton } from './owner-sign-out-button';

// Deliberately NOT the tenant dashboard shell: no compliance nav, no
// organisation context, and a distinct bar so the operating context is
// never ambiguous.
export default function OwnerLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-6 py-3">
        <span className="text-sm font-semibold uppercase tracking-wide text-amber-400">
          CharityPilot platform console
        </span>
        <OwnerSignOutButton />
      </header>
      <main className="mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
