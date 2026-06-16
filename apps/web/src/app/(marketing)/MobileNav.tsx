'use client';

import { useState } from 'react';
import Link from 'next/link';

const NAV_LINKS = [
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/blog', label: 'Blog' },
  { href: '/login', label: 'Sign in' },
];

export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="p-2 -mr-2 rounded-lg text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
      >
        {open ? (
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        )}
      </button>

      {open && (
        <div className="absolute top-16 inset-x-0 bg-white border-y border-gray-200 shadow-lg z-50">
          <nav className="max-w-7xl mx-auto px-4 py-4 space-y-1" aria-label="Mobile navigation">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="block px-4 py-3 rounded-lg text-gray-700 font-medium hover:bg-gray-50 transition-colors"
              >
                {link.label}
              </Link>
            ))}
            <div className="pt-2 px-4">
              <Link
                href="/register"
                onClick={() => setOpen(false)}
                className="block w-full text-center bg-teal-primary text-white font-semibold py-3 rounded-full hover:bg-teal-dark transition-colors"
              >
                Start free trial
              </Link>
            </div>
          </nav>
        </div>
      )}
    </div>
  );
}
