import type { ReactNode } from 'react';
import Link from 'next/link';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="light min-h-screen bg-white text-gray-900 flex flex-col" style={{ colorScheme: 'light' }}>
      {/* Header */}
      <header className="py-5 px-4 sm:px-6">
        <div className="w-full max-w-md mx-auto flex items-center justify-between gap-4">
          <Link href="/" className="min-w-0 flex items-center gap-2 group">
            <svg
              width="24"
              height="24"
              viewBox="0 0 28 28"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="14" cy="14" r="13" stroke="#0D7377" strokeWidth="2" />
              <path
                d="M14 6 L14 14 L20 17"
                stroke="#0D7377"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="14" cy="14" r="2" fill="#D4A843" />
            </svg>
            <span className="truncate text-lg font-bold text-teal-primary group-hover:text-teal-dark transition-colors">
              CharityPilot
            </span>
          </Link>
          <Link
            href="/"
            className="shrink-0 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-teal-primary transition-colors font-medium"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
            </svg>
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
      <footer className="text-center py-6 px-4 text-xs text-gray-400">
        <p>
          &copy; 2026 Project Nexus Ltd &mdash;{' '}
          <Link href="/privacy" className="hover:text-teal-primary transition-colors">
            Privacy Policy
          </Link>{' '}
          &middot;{' '}
          <Link href="/terms" className="hover:text-teal-primary transition-colors">
            Terms of Service
          </Link>
        </p>
      </footer>
    </div>
  );
}
