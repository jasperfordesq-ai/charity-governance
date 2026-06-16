'use client';

import { HeroUIProvider } from '@heroui/react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth-context';
import { ChunkLoadReloadGuard } from '@/components/chunk-load-reload-guard';
import { ToastProvider } from '@/components/toast';

const CookieConsent = dynamic(
  () => import('@/components/cookie-consent').then((m) => m.CookieConsent),
  { ssr: false },
);

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();

  return (
    <>
      <ChunkLoadReloadGuard />
      <HeroUIProvider navigate={router.push}>
        <AuthProvider>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
        <CookieConsent />
      </HeroUIProvider>
    </>
  );
}
