'use client';

import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { CircleAlert } from 'lucide-react';

const STORAGE_KEY = 'cookie-notice';
const LEGACY_STORAGE_KEY = 'cookie-consent';

type NoticeValue = 'acknowledged' | null;

export function CookieConsent() {
  const [notice, setNotice] = useState<NoticeValue | 'loading'>('loading');

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (stored === 'acknowledged' || legacy === 'accepted' || legacy === 'declined') {
        localStorage.setItem(STORAGE_KEY, 'acknowledged');
        setNotice('acknowledged');
      } else {
        setNotice(null);
      }
    } catch {
      setNotice(null);
    }
  }, []);

  const handleAcknowledge = () => {
    try {
      localStorage.setItem(STORAGE_KEY, 'acknowledged');
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // localStorage may not be available in all environments
    }
    setNotice('acknowledged');
  };

  // Don't render during SSR hydration or once the informational notice is acknowledged.
  if (notice !== null) return null;

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Cookie information"
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
            CharityPilot currently uses only{' '}
            <strong className="text-white font-semibold">strictly necessary authentication cookies</strong>{' '}
            to maintain and secure signed-in sessions. It does not set analytics or advertising
            cookies. Dismissing this notice stores only a local browser preference so the notice
            stays closed. See our{' '}
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
              onPress={handleAcknowledge}
              className="bg-amber-accent px-5 font-semibold text-gray-900 hover:bg-amber-light whitespace-nowrap"
            >
              Continue with essential cookies
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
