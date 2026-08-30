'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, CardBody, Input } from '@heroui/react';
import axios from 'axios';
import { configuredApiOrigin } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';

function SetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await axios.post(`${configuredApiOrigin}/api/v1/owner/auth/set-password`, { token, password });
      router.push('/owner/login');
    } catch (err) {
      setError(apiErrorMessage(err, 'That link is invalid or has expired.'));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Card>
      <CardBody className="gap-4">
        <h1 className="text-xl font-semibold">Set your console password</h1>
        {error ? <p className="text-danger">{error}</p> : null}
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <Input
            label="New password"
            type="password"
            value={password}
            onValueChange={setPassword}
            autoComplete="new-password"
            description="At least 12 characters."
          />
          <Button type="submit" color="primary" isLoading={isLoading} isDisabled={!token || password.length < 12}>
            Set password
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export default function OwnerSetPasswordPage() {
  return (
    <div className="mx-auto w-full max-w-md">
      <Suspense fallback={<p>Loading…</p>}>
        <SetPasswordForm />
      </Suspense>
    </div>
  );
}
