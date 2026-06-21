'use client';

import { FormEvent, Suspense, useState } from 'react';
import { Button, Card, CardBody, Input, Link } from '@heroui/react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { passwordIssue } from '@/lib/form-schemas';
import { useSensitiveQueryToken } from '@/lib/use-sensitive-query-token';
import { useAuth } from '@/lib/auth-context';

function AcceptInviteForm() {
  const router = useRouter();
  const { refreshUser } = useAuth();
  const { token } = useSensitiveQueryToken();
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

    // Enforce the shared password rule client-side (uppercase + lowercase + digit).
    const pwIssue = passwordIssue(password);
    if (pwIssue) {
      setError(pwIssue);
      return;
    }

    setIsLoading(true);

    try {
      await api.post('/team/accept-invite', { token, name, password });
      // The server has set the session cookies; load the new user into context
      // before navigating, otherwise the dashboard guard bounces us to /login.
      await refreshUser();
      router.push('/dashboard');
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'This invite could not be accepted. It may have expired.'));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md min-w-0">
        <Card className="w-full border border-gray-200 shadow-lg">
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
                classNames={{ inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary' }}
              />
              <Input
                label="Password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onValueChange={setPassword}
                isRequired
                autoComplete="new-password"
                variant="bordered"
                classNames={{ inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary' }}
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
                classNames={{ inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary' }}
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

function AcceptInviteFallback() {
  return (
    <div className="w-full max-w-md min-w-0">
      <Card className="w-full border border-gray-200 shadow-lg">
        <CardBody className="p-8 sm:p-10">
          <div className="h-7 w-44 rounded bg-gray-200 mx-auto mb-3" />
          <div className="h-4 w-64 rounded bg-gray-200 mx-auto" />
        </CardBody>
      </Card>
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<AcceptInviteFallback />}>
      <AcceptInviteForm />
    </Suspense>
  );
}
