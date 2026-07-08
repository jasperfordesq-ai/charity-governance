'use client';

import { FormEvent, Suspense, useState } from 'react';
import { Button, Card, CardBody, Input, Link } from '@heroui/react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { passwordIssue } from '@/lib/form-schemas';
import { useSensitiveQueryToken } from '@/lib/use-sensitive-query-token';
import { useAuth } from '@/lib/auth-context';
import { primaryActionButtonClasses } from '@/components/ui/action-button';
import { AuthCardLoading } from '@/components/ui/auth-card-loading';
import { FormAlert } from '@/components/ui/form-alert';
import { PasswordVisibilityButton } from '@/components/ui/password-visibility-button';

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
        <Card className="w-full border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-900">
          <CardBody className="p-8 sm:p-10">
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold text-gray-950 dark:text-white">Accept your invite</h1>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                Create your account to join this charity&apos;s governance workspace.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              {error && (
                <FormAlert>{error}</FormAlert>
              )}

              <Input
                label="Your name"
                value={name}
                onValueChange={setName}
                isRequired
                autoComplete="name"
                variant="bordered"
                classNames={{ inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary dark:border-gray-700 dark:hover:border-teal-bright dark:focus-within:!border-teal-bright' }}
              />
              <Input
                label="Password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onValueChange={setPassword}
                isRequired
                autoComplete="new-password"
                variant="bordered"
                classNames={{
                  inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary dark:border-gray-700 dark:hover:border-teal-bright dark:focus-within:!border-teal-bright',
                  description: '!text-gray-700 dark:!text-gray-300',
                }}
                description="Use at least 8 characters with uppercase, lowercase, and a number."
                endContent={
                  <PasswordVisibilityButton
                    isVisible={showPassword}
                    label={showPassword ? 'Hide invite passwords' : 'Show invite passwords'}
                    onPress={() => setShowPassword((current) => !current)}
                  />
                }
              />
              <Input
                label="Confirm password"
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onValueChange={setConfirmPassword}
                isRequired
                autoComplete="new-password"
                variant="bordered"
                classNames={{ inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary dark:border-gray-700 dark:hover:border-teal-bright dark:focus-within:!border-teal-bright' }}
                endContent={
                  <PasswordVisibilityButton
                    isVisible={showPassword}
                    label={showPassword ? 'Hide invite passwords' : 'Show invite passwords'}
                    onPress={() => setShowPassword((current) => !current)}
                  />
                }
              />

              <Button
                type="submit"
                isLoading={isLoading}
                className={primaryActionButtonClasses('w-full font-semibold')}
                radius="lg"
                size="lg"
              >
                Join Workspace
              </Button>
            </form>

            <p className="mt-8 text-center text-sm text-gray-600 dark:text-gray-300">
              Already have an account?{' '}
              <Link href="/login" className="text-teal-primary dark:text-teal-bright font-semibold hover:underline">
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
    <AuthCardLoading title="Preparing invite" description="Checking your secure invite link." />
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<AcceptInviteFallback />}>
      <AcceptInviteForm />
    </Suspense>
  );
}
