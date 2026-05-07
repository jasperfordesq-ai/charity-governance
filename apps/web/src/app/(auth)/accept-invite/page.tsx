'use client';

import { FormEvent, useState } from 'react';
import { Button, Card, CardBody, Input, Link } from '@heroui/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

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
      const { data } = await api.post('/team/accept-invite', { token, name, password });
      localStorage.setItem('accessToken', data.accessToken);
      localStorage.setItem('refreshToken', data.refreshToken);
      router.push('/dashboard');
    } catch (err: any) {
      setError(err.response?.data?.error ?? 'This invite could not be accepted. It may have expired.');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <div className="py-8 px-4 text-center">
        <Link href="/" className="text-2xl font-bold text-teal-primary">
          CharityPilot
        </Link>
      </div>

      <div className="flex-1 flex items-start justify-center px-4 pt-4 pb-16">
        <Card className="w-full max-w-md border border-gray-100 shadow-lg">
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
    </div>
  );
}
