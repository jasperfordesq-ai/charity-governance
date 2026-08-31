'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@heroui/react';
import { ownerApi } from '@/lib/owner-api';

export function OwnerSignOutButton() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  async function handleSignOut() {
    setIsLoading(true);
    try {
      await ownerApi.logout();
    } catch {
      // A failed logout call must not trap the operator on the console: the
      // access cookie is short-lived (30 minutes) regardless, and the login
      // page re-establishes a clean session either way.
    } finally {
      router.push('/owner/login');
    }
  }

  return (
    <Button size="sm" variant="flat" isLoading={isLoading} onPress={handleSignOut}>
      Sign out
    </Button>
  );
}
