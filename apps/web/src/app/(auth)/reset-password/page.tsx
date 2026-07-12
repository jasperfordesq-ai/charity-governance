'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { Button, Card, CardBody, Input, Link } from '@heroui/react';
import { Check, CircleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { resetPasswordIssue } from '@/lib/form-schemas';
import { useSensitiveQueryToken } from '@/lib/use-sensitive-query-token';
import { primaryActionButtonClasses } from '@/components/ui/action-button';
import { AuthCardLoading, authCardClassName } from '@/components/ui/auth-card-loading';
import { AuthStatusIcon } from '@/components/ui/auth-status-icon';
import { FormAlert } from '@/components/ui/form-alert';
import { PasswordVisibilityButton } from '@/components/ui/password-visibility-button';
import type { PasswordResetResponse } from '@charitypilot/shared';

function ResetPasswordForm() {
  const { token, isReady } = useSensitiveQueryToken();
  const personalServer = process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE === 'personal-server';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [resetLinkRejected, setResetLinkRejected] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setResetLinkRejected(false);

    // Same reset-password rule the server enforces (uppercase + lowercase + digit).
    const pwIssue = resetPasswordIssue(password);
    if (pwIssue) {
      setError(pwIssue);
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    if (!token) {
      setError('No reset token found. Please request a new password reset link.');
      return;
    }

    setIsLoading(true);

    try {
      await api.post<PasswordResetResponse>('/auth/reset-password', { token, password }, {
        skipAuthRefresh: true,
        skipAuthRedirect: true,
      });
      setIsSuccess(true);
    } catch (err: unknown) {
      setResetLinkRejected(
        (err as { response?: { data?: { code?: unknown } } })?.response?.data?.code === 'INVALID_RESET_TOKEN',
      );
      setError(apiErrorMessage(err, 'Something went wrong. The link may have expired.'));
    } finally {
      setIsLoading(false);
    }
  }

  const passwordInvalid = touched.password && password.length > 0 && resetPasswordIssue(password) !== null;
  const confirmInvalid = touched.confirmPassword && confirmPassword.length > 0 && password !== confirmPassword;
  const passwordsMatch = password.length >= 8 && confirmPassword.length > 0 && password === confirmPassword;

  const eyeButton = (show: boolean, toggle: () => void) => (
    <PasswordVisibilityButton isVisible={show} onPress={toggle} />
  );

  if (!isReady) {
    return <AuthCardLoading title="Preparing password reset" description="Checking your secure reset link." />;
  }

  return (
    <div className="w-full max-w-md min-w-0">
        <Card className={authCardClassName}>
          <CardBody className="p-8 sm:p-10">
            {isSuccess ? (
              <div className="text-center py-4" role="status" aria-live="polite">
                <AuthStatusIcon icon={Check} tone="success" />
                <h1 className="text-2xl font-bold text-gray-950 dark:text-white mb-2">Password reset</h1>
                <p className="text-gray-700 dark:text-gray-300 leading-relaxed mb-6">
                  Your password has been reset and every existing session has been signed out.
                  Sign in again with your new password.
                </p>
                <Link
                  href="/login"
                  className={primaryActionButtonClasses('inline-flex items-center justify-center rounded-lg px-8 py-2.5 font-semibold transition-colors')}
                >
                  Sign in
                </Link>
              </div>
            ) : !token ? (
              <div className="text-center py-4">
                <AuthStatusIcon icon={CircleAlert} tone="danger" />
                <h1 className="text-2xl font-bold text-gray-950 dark:text-white mb-2">Reset link required</h1>
                <p className="text-gray-700 dark:text-gray-300 leading-relaxed mb-6">
                  {personalServer
                    ? 'This private server needs a valid one-time link from its trusted host operator. Ask the operator through your usual verified channel.'
                    : 'This page needs a valid one-time password-reset link. Request a new link to continue securely.'}
                </p>
                <div className="flex flex-col items-center gap-4">
                  {!personalServer ? (
                    <Link
                      href="/forgot-password"
                      className={primaryActionButtonClasses('inline-flex items-center justify-center rounded-lg px-8 py-2.5 font-semibold transition-colors')}
                    >
                      Request a new reset link
                    </Link>
                  ) : null}
                  <Link href="/login" className="text-sm font-semibold text-teal-primary hover:underline dark:text-teal-bright">
                    Back to sign in
                  </Link>
                </div>
              </div>
            ) : (
              <>
                <div className="text-center mb-8">
                  <h1 className="text-2xl font-bold text-gray-950 dark:text-white">Set a new password</h1>
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                    Choose a strong, unique password. Completing this reset signs out every
                    existing CharityPilot session.
                  </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-5">
                  {error && (
                    <div className="space-y-2">
                      <FormAlert title={resetLinkRejected ? 'Reset link not accepted' : undefined}>{error}</FormAlert>
                      {resetLinkRejected && !personalServer ? (
                        <Link href="/forgot-password" className="text-sm font-semibold text-teal-primary hover:underline dark:text-teal-bright">
                          Request a new reset link
                        </Link>
                      ) : null}
                    </div>
                  )}

                  <Input
                    label="New password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onValueChange={setPassword}
                    onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                    isRequired
                    isInvalid={passwordInvalid}
                    errorMessage={passwordInvalid ? (resetPasswordIssue(password) ?? 'Password must be at least 8 characters') : undefined}
                    autoComplete="new-password"
                    description="At least 8 characters, with an uppercase letter, a lowercase letter, and a number"
                    variant="bordered"
                    classNames={{
                      inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary dark:border-gray-700 dark:hover:border-teal-bright dark:focus-within:!border-teal-bright',
                      description: '!text-gray-700 dark:!text-gray-300',
                    }}
                    endContent={eyeButton(showPassword, () => setShowPassword(!showPassword))}
                  />

                  <Input
                    label="Confirm new password"
                    type={showConfirm ? 'text' : 'password'}
                    value={confirmPassword}
                    onValueChange={setConfirmPassword}
                    onBlur={() => setTouched((t) => ({ ...t, confirmPassword: true }))}
                    isRequired
                    isInvalid={confirmInvalid}
                    errorMessage={confirmInvalid ? 'Passwords do not match' : undefined}
                    color={passwordsMatch ? 'success' : undefined}
                    autoComplete="new-password"
                    variant="bordered"
                    classNames={{
                      inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary dark:border-gray-700 dark:hover:border-teal-bright dark:focus-within:!border-teal-bright',
                      description: '!text-gray-700 dark:!text-gray-300',
                    }}
                    endContent={
                      <div className="flex items-center gap-1">
                        {passwordsMatch && (
                          <Check className="w-5 h-5 text-green-500" aria-hidden="true" />
                        )}
                        {eyeButton(showConfirm, () => setShowConfirm(!showConfirm))}
                      </div>
                    }
                  />

                  <Button
                    type="submit"
                    isLoading={isLoading}
                    className={primaryActionButtonClasses('w-full font-semibold')}
                    radius="lg"
                    size="lg"
                  >
                    Reset password
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

function ResetPasswordFallback() {
  return (
    <AuthCardLoading title="Preparing password reset" description="Checking your secure reset link." />
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<ResetPasswordFallback />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
