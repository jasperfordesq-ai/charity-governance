'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, Input } from '@heroui/react';
import { ownerApi } from '@/lib/owner-api';
import { apiErrorMessage } from '@/lib/errors';
import { FormAlert } from '@/components/ui/form-alert';

export default function OwnerLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await ownerApi.login(email, password);
      router.push('/owner/tenants');
    } catch (err) {
      setError(apiErrorMessage(err, 'Invalid email or password.'));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardBody className="gap-4">
          <h1 className="text-xl font-semibold">Platform console sign in</h1>
          {error ? <FormAlert>{error}</FormAlert> : null}
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <Input label="Email" type="email" value={email} onValueChange={setEmail} autoComplete="username" />
            <Input
              label="Password"
              type="password"
              value={password}
              onValueChange={setPassword}
              autoComplete="current-password"
            />
            <Button type="submit" isLoading={isLoading} color="primary">
              Sign in
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
