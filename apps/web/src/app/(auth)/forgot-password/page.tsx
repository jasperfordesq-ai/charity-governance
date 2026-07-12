'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, CardBody, Input, Link } from '@heroui/react';
import { Mail } from 'lucide-react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { forgotPasswordSchema, firstSchemaError } from '@/lib/form-schemas';
import { primaryActionButtonClasses } from '@/components/ui/action-button';
import { authCardClassName } from '@/components/ui/auth-card-loading';
import { AuthStatusIcon } from '@/components/ui/auth-status-icon';
import { FormAlert } from '@/components/ui/form-alert';
import type { PasswordRecoveryAcceptedResponse } from '@charitypilot/shared';

export default function ForgotPasswordPage() {
  const personalServer = process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE === 'personal-server';
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  if (personalServer) {
    return (
      <div className="w-full max-w-md min-w-0">
        <Card className={authCardClassName}>
          <CardBody className="p-8 text-center sm:p-10">
            <AuthStatusIcon icon={Mail} />
            <h1 className="mb-2 text-2xl font-bold text-gray-950 dark:text-white">
              Ask your server owner for a reset link
            </h1>
            <p className="mb-6 leading-relaxed text-gray-700 dark:text-gray-300">
              Email recovery is disabled on this private CharityPilot server. Contact the
              trusted host operator through your usual verified channel; they can issue a
              one-time password-reset link without asking for your current password.
            </p>
            <Link href="/login" className="text-sm font-semibold text-teal-primary hover:underline dark:text-teal-bright">
              Back to sign in
            </Link>
          </CardBody>
        </Card>
      </div>
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    const issue = firstSchemaError(forgotPasswordSchema, { email });
    if (issue) {
      setError(issue);
      return;
    }
    setIsLoading(true);

    try {
      await api.post<PasswordRecoveryAcceptedResponse>('/auth/forgot-password', { email }, {
        skipAuthRefresh: true,
        skipAuthRedirect: true,
      });
      setIsSuccess(true);
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Something went wrong. Please try again.'));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md min-w-0">
        <Card className={authCardClassName}>
          <CardBody className="p-8 sm:p-10">
            {isSuccess ? (
              <div className="text-center py-4" role="status" aria-live="polite">
                <AuthStatusIcon icon={Mail} />
                <h1 className="text-2xl font-bold text-gray-950 dark:text-white mb-2">Check for a reset email</h1>
                <p className="text-gray-700 dark:text-gray-300 leading-relaxed mb-6">
                  If an active account exists for the address you entered and another request is
                  allowed, password-recovery instructions will arrive shortly. Links expire after
                  one hour. Repeated requests may be silently limited for security.
                </p>
                <Link href="/login" className="text-teal-primary dark:text-teal-bright font-semibold hover:underline text-sm">
                  Back to sign in
                </Link>
              </div>
            ) : (
              <>
                <div className="text-center mb-8">
                  <h1 className="text-2xl font-bold text-gray-950 dark:text-white">Forgot your password?</h1>
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                    Enter your email address. If an active account exists and another request is
                    allowed, we will send a one-hour password-reset link.
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
                    isRequired
                    autoComplete="email"
                    variant="bordered"
                    classNames={{
                      inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary dark:border-gray-700 dark:hover:border-teal-bright dark:focus-within:!border-teal-bright',
                    }}
                  />

                  <Button
                    type="submit"
                    isLoading={isLoading}
                    className={primaryActionButtonClasses('w-full font-semibold')}
                    radius="lg"
                    size="lg"
                  >
                    Send reset link
                  </Button>
                </form>

                <p className="mt-8 text-center text-sm text-gray-600 dark:text-gray-300">
                  Remember your password?{' '}
                  <Link href="/login" className="text-teal-primary dark:text-teal-bright font-semibold hover:underline">
                    Sign in
                  </Link>
                </p>
              </>
            )}
          </CardBody>
        </Card>
    </div>
  );
}
