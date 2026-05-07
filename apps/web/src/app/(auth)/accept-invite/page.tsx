'use client';

import { FormEvent, useState } from 'react';
import { Button, Card, CardBody, Input, Link } from '@heroui/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';

export default function AcceptInvitePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');

    if (!token) {
      setError('This invite link is missing its secure token. Please ask the sender to issue a fresh invite.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setIsLoading(true);

    try {
      await api.post('/team/accept-invite', { token, name, password });
      router.push('/dashboard');
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'This invite could not be accepted. It may have expired.'));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md min-w-0">
        <Card className="w-full border border-gray-100 shadow-lg">
          <CardBody className="p-8 sm:p-10">
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold text-gray-900">Accept your invite</h1>
              <p className="mt-2 text-sm text-gray-500">
                Create your account to join this charity&apos;s governance workspace.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              {error && (
                <div role="alert" className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
                  {error}
                </div>
              )}

              <Input
                label="Your name"
                value={name}
                onValueChange={setName}
                isRequired
                autoComplete="name"
                variant="bordered"
              />
              <Input
                label="Password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onValueChange={setPassword}
                isRequired
                autoComplete="new-password"
                variant="bordered"
                description="Use at least 8 characters with uppercase, lowercase, and a number."
              />
              <Input
                label="Confirm password"
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onValueChange={setConfirmPassword}
                isRequired
                autoComplete="new-password"
                variant="bordered"
              />

              <button
                type="button"
                className="text-sm text-teal-primary font-medium hover:underline"
                onClick={() => setShowPassword((current) => !current)}
              >
                {showPassword ? 'Hide passwords' : 'Show passwords'}
              </button>

              <Button
                type="submit"
                isLoading={isLoading}
                className="w-full bg-teal-primary text-white font-semibold"
                radius="full"
                size="lg"
              >
                Join Workspace
              </Button>
            </form>

            <p className="mt-8 text-center text-sm text-gray-500">
              Already have an account?{' '}
              <Link href="/login" className="text-teal-primary font-semibold hover:underline">
                Sign in
              </Link>
            </p>
          </CardBody>
        </Card>
    </div>
  );
}
