'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { Button, Card, CardBody, Input, Link } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { passwordIssue } from '@/lib/form-schemas';
import { useSensitiveQueryToken } from '@/lib/use-sensitive-query-token';

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
    <button type="button" onClick={toggle} className="text-gray-500 hover:text-gray-700 focus:outline-none dark:text-gray-400 dark:hover:text-gray-200" aria-label={show ? 'Hide password' : 'Show password'}>
      {show ? (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>
      ) : (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
      )}
    </button>
  );

  return (
    <div className="w-full max-w-md min-w-0">
        <Card className="w-full border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-900">
          <CardBody className="p-8 sm:p-10">
            {isSuccess ? (
              <div className="text-center py-4">
                <div className="w-14 h-14 rounded-lg bg-green-50 dark:bg-green-950/40 flex items-center justify-center mx-auto mb-5">
                  <svg className="w-7 h-7 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
                <h1 className="text-2xl font-bold text-gray-950 dark:text-white mb-2">Password reset</h1>
                <p className="text-gray-700 dark:text-gray-300 leading-relaxed mb-6">
                  Your password has been reset successfully. You can now sign in with your new
                  password.
                </p>
                <Link
                  href="/login"
                  className="inline-flex items-center justify-center rounded-lg bg-teal-primary text-white font-semibold px-8 py-2.5 hover:opacity-90 transition-opacity"
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
                    <div role="alert" aria-live="assertive" className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm dark:bg-red-950/40 dark:border-red-800 dark:text-red-100">
                      {error}
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
                          <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                          </svg>
                        )}
                        {eyeButton(showConfirm, () => setShowConfirm(!showConfirm))}
                      </div>
                    }
                  />

                  <Button
                    type="submit"
                    isLoading={isLoading}
                    className="w-full bg-teal-primary text-white font-semibold"
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
