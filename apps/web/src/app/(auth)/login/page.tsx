'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, CardBody, Input, Link } from '@heroui/react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { apiErrorMessage } from '@/lib/errors';
import { loginSchema, firstSchemaError } from '@/lib/form-schemas';
import { safeNextPath } from '@/lib/safe-next-path';
import { primaryActionButtonClasses } from '@/components/ui/action-button';
import { FormAlert } from '@/components/ui/form-alert';
import { PasswordVisibilityButton } from '@/components/ui/password-visibility-button';

function loginDestination(user: { emailVerified: boolean }): string {
  const nextPath = new URLSearchParams(window.location.search).get('next');
  return user.emailVerified ? safeNextPath(nextPath) : '/verify-email';
}

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    const issue = firstSchemaError(loginSchema, { email, password });
    if (issue) {
      setError(issue);
      return;
    }
    setIsLoading(true);

    try {
      const user = await login(email, password);
      router.push(loginDestination(user));
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Invalid email or password. Please try again.'));
    } finally {
      setIsLoading(false);
    }
  }

  const emailInvalid = touched.email && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  const passwordInvalid = touched.password && !password;

  return (
    <div className="w-full max-w-md min-w-0">
      <Card className="w-full border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-900">
        <CardBody className="p-6 sm:p-10">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-gray-950 dark:text-white">Welcome back</h1>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
              Sign in to your CharityPilot account
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <FormAlert>{error}</FormAlert>
            )}

              <Input
                label="Email address"
                type="email"
                value={email}
                onValueChange={setEmail}
                onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                isRequired
                isInvalid={emailInvalid}
                errorMessage={emailInvalid ? 'Please enter a valid email address' : undefined}
                autoComplete="email"
                variant="bordered"
                classNames={{
                  inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary dark:border-gray-700 dark:hover:border-teal-bright dark:focus-within:!border-teal-bright',
                }}
              />

              <Input
                label="Password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onValueChange={setPassword}
                onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                isRequired
                isInvalid={passwordInvalid}
                errorMessage={passwordInvalid ? 'Password is required' : undefined}
                autoComplete="current-password"
                variant="bordered"
                classNames={{
                  inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary dark:border-gray-700 dark:hover:border-teal-bright dark:focus-within:!border-teal-bright',
                }}
                endContent={
                  <PasswordVisibilityButton
                    isVisible={showPassword}
                    onPress={() => setShowPassword((current) => !current)}
                  />
                }
              />

              <div className="flex justify-end">
                <Link href="/forgot-password" className="text-sm text-teal-primary dark:text-teal-bright font-medium hover:underline">
                  Forgot your password?
                </Link>
              </div>

              <Button
                type="submit"
                isLoading={isLoading}
                className={primaryActionButtonClasses('w-full font-semibold')}
                radius="lg"
                size="lg"
              >
                Sign in
              </Button>
          </form>

          <p className="mt-8 text-center text-sm text-gray-600 dark:text-gray-300">
            Don&apos;t have an account?{' '}
            <Link href="/register" className="text-teal-primary dark:text-teal-bright font-semibold hover:underline">
              Start your free trial
            </Link>
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
