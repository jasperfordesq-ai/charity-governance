'use client';

import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { CircleAlert } from 'lucide-react';

const STORAGE_KEY = 'cookie-consent';

type ConsentValue = 'accepted' | 'declined' | null;

export function CookieConsent() {
  const [consent, setConsent] = useState<ConsentValue | 'loading'>('loading');

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as ConsentValue | null;
      setConsent(stored);
    } catch {
      setConsent(null);
    }
  }, []);

  const handleAccept = () => {
    try {
      localStorage.setItem(STORAGE_KEY, 'accepted');
    } catch {
      // localStorage may not be available in all environments
    }
    setConsent('accepted');
  };

  const handleDecline = () => {
    try {
      localStorage.setItem(STORAGE_KEY, 'declined');
    } catch {
      // localStorage may not be available in all environments
    }
    setConsent('declined');
  };

  // Don't render during SSR hydration or once consent has been given/declined
  if (consent !== null) return null;

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Cookie consent"
      className="fixed bottom-0 left-0 right-0 z-50 bg-teal-primary text-white shadow-2xl"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-5">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-6">
          {/* Icon */}
          <div className="shrink-0 hidden sm:flex w-10 h-10 rounded-lg bg-white/10 items-center justify-center">
            <CircleAlert className="w-5 h-5 text-amber-accent" strokeWidth={1.5} aria-hidden="true" />
          </div>

          {/* Text */}
          <p className="text-sm text-teal-50 leading-relaxed flex-1">
            We use <strong className="text-white font-semibold">essential cookies</strong> to
            make CharityPilot work, and optional{' '}
            <strong className="text-white font-semibold">analytics cookies</strong> to help us
            understand how people use the site so we can improve it. No advertising cookies
            are ever used. See our{' '}
            <a
              href="/privacy"
              className="underline underline-offset-2 text-white font-medium hover:text-amber-light transition-colors"
            >
              Privacy Policy
            </a>{' '}
            for details.
          </p>

          {/* Buttons */}
          <div className="flex flex-col min-[380px]:flex-row gap-2 sm:gap-3 shrink-0 w-full sm:w-auto">
            <Button
              type="button"
              radius="lg"
              onPress={handleAccept}
              className="bg-amber-accent px-5 font-semibold text-gray-900 hover:bg-amber-light whitespace-nowrap"
            >
              Accept All
            </Button>
            <Button
              type="button"
              radius="lg"
              variant="bordered"
              onPress={handleDecline}
              className="border-white/20 bg-white/10 px-5 font-semibold text-white hover:bg-white/20 whitespace-nowrap"
            >
              Essential Only
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
