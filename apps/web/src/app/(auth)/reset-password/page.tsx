'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { Button, Card, CardBody, Input, Link } from '@heroui/react';
import { Check } from 'lucide-react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { passwordIssue } from '@/lib/form-schemas';
import { useSensitiveQueryToken } from '@/lib/use-sensitive-query-token';
import { primaryActionButtonClasses } from '@/components/ui/action-button';
import { FormAlert } from '@/components/ui/form-alert';
import { PasswordVisibilityButton } from '@/components/ui/password-visibility-button';

function ResetPasswordForm() {
  const { token } = useSensitiveQueryToken();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    // Same shared password rule the server enforces (uppercase + lowercase + digit).
    const pwIssue = passwordIssue(password);
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
      await api.post('/auth/reset-password', { token, password });
      setIsSuccess(true);
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Something went wrong. The link may have expired.'));
    } finally {
      setIsLoading(false);
    }
  }

  const passwordInvalid = touched.password && password.length > 0 && passwordIssue(password) !== null;
  const confirmInvalid = touched.confirmPassword && confirmPassword.length > 0 && password !== confirmPassword;
  const passwordsMatch = password.length >= 8 && confirmPassword.length > 0 && password === confirmPassword;

  const eyeButton = (show: boolean, toggle: () => void) => (
    <PasswordVisibilityButton isVisible={show} onPress={toggle} />
  );

  return (
    <div className="w-full max-w-md min-w-0">
        <Card className="w-full border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-900">
          <CardBody className="p-8 sm:p-10">
            {isSuccess ? (
              <div className="text-center py-4">
                <div className="w-14 h-14 rounded-lg bg-green-50 dark:bg-green-950/40 flex items-center justify-center mx-auto mb-5">
                  <Check className="w-7 h-7 text-green-500" aria-hidden="true" />
                </div>
                <h1 className="text-2xl font-bold text-gray-950 dark:text-white mb-2">Password reset</h1>
                <p className="text-gray-700 dark:text-gray-300 leading-relaxed mb-6">
                  Your password has been reset successfully. You can now sign in with your new
                  password.
                </p>
                <Link
                  href="/login"
                  className={primaryActionButtonClasses('inline-flex items-center justify-center rounded-lg px-8 py-2.5 font-semibold transition-colors')}
                >
                  Sign in
                </Link>
              </div>
            ) : (
              <>
                <div className="text-center mb-8">
                  <h1 className="text-2xl font-bold text-gray-950 dark:text-white">Set a new password</h1>
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                    Choose a strong password for your CharityPilot account.
                  </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-5">
                  {error && (
                    <FormAlert>{error}</FormAlert>
                  )}

                  <Input
                    label="New password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onValueChange={setPassword}
                    onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                    isRequired
                    isInvalid={passwordInvalid}
                    errorMessage={passwordInvalid ? (passwordIssue(password) ?? 'Password must be at least 8 characters') : undefined}
                    autoComplete="new-password"
                    description="At least 8 characters, with an uppercase letter, a lowercase letter, and a number"
                    variant="bordered"
                    classNames={{
                      inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary dark:border-gray-700 dark:hover:border-teal-bright dark:focus-within:!border-teal-bright',
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
    <div className="w-full max-w-md min-w-0">
      <Card className="w-full border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-900">
        <CardBody className="p-8 sm:p-10">
          <div className="h-7 w-48 rounded bg-gray-200 dark:bg-gray-800 mx-auto mb-3" />
          <div className="h-4 w-64 rounded bg-gray-200 dark:bg-gray-800 mx-auto" />
        </CardBody>
      </Card>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<ResetPasswordFallback />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
