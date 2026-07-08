import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { LegalAttribution } from '@/components/legal-attribution';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100 flex flex-col">
      {/* Header */}
      <header className="py-5 px-4 sm:px-6">
        <div className="w-full max-w-md mx-auto flex items-center justify-between gap-4">
          <Link href="/" className="min-w-0 flex items-center gap-2 group">
            <ShieldCheck className="h-6 w-6 shrink-0 text-teal-primary" strokeWidth={2} aria-hidden="true" />
            <span className="truncate text-lg font-bold text-teal-primary group-hover:text-teal-dark transition-colors">
              CharityPilot
            </span>
          </Link>
          <Link
            href="/"
            className="shrink-0 inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-300 hover:text-teal-primary dark:hover:text-teal-bright transition-colors font-medium"
          >
            <ArrowLeft className="w-3.5 h-3.5" strokeWidth={2} aria-hidden="true" />
            <span className="sm:hidden">Home</span>
            <span className="hidden sm:inline">Back to home</span>
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 flex items-start justify-center px-4 sm:px-6 pt-6 sm:pt-8 pb-12 sm:pb-16">
        {children}
      </main>

      {/* Minimal footer */}
      <footer className="text-center py-6 px-4 text-xs text-gray-500 dark:text-gray-300">
        <div className="mx-auto max-w-xl space-y-2">
          <LegalAttribution />
          <p>
          <Link href="/privacy" className="hover:text-teal-primary dark:hover:text-teal-bright transition-colors">
            Privacy Policy
          </Link>{' '}
          &middot;{' '}
          <Link href="/terms" className="hover:text-teal-primary dark:hover:text-teal-bright transition-colors">
            Terms of Service
          </Link>{' '}
          &middot;{' '}
          <Link href="/about" className="hover:text-teal-primary dark:hover:text-teal-bright transition-colors">
            About
          </Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
