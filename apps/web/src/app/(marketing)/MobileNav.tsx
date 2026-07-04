'use client';

import { useState } from 'react';
import { Button } from '@heroui/react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';

const NAV_LINKS = [
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/blog', label: 'Blog' },
  { href: '/login', label: 'Sign in' },
];

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const navId = 'marketing-mobile-navigation';

  return (
    <div className="md:hidden">
      <Button
        type="button"
        isIconOnly
        size="sm"
        radius="lg"
        variant="light"
        onPress={() => setOpen((current) => !current)}
        className="-mr-2 h-10 min-w-10 text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-white dark:hover:bg-gray-800"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls={navId}
      >
        {open ? (
          <X className="w-6 h-6" strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <Menu className="w-6 h-6" strokeWidth={1.5} aria-hidden="true" />
        )}
      </Button>

      {open && (
        <div className="absolute top-16 inset-x-0 bg-white border-y border-gray-200 shadow-lg z-50 dark:border-gray-800 dark:bg-gray-900">
          <nav id={navId} className="max-w-7xl mx-auto px-4 py-4 space-y-1" aria-label="Mobile navigation">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="block px-4 py-3 rounded-lg text-gray-700 font-medium hover:bg-gray-50 transition-colors dark:text-gray-200 dark:hover:bg-gray-800"
              >
                {link.label}
              </Link>
            ))}
            <div className="pt-2 px-4">
              <Link
                href="/register"
                onClick={() => setOpen(false)}
                className="block w-full text-center bg-teal-primary text-white font-semibold py-3 rounded-md hover:bg-teal-dark transition-colors"
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
