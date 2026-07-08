'use client';

import { Suspense, useEffect, useState } from 'react';
import { Button, Card, CardBody, Link } from '@heroui/react';
import { Check, CircleAlert, Mail } from 'lucide-react';
import { FormAlert } from '@/components/ui/form-alert';
import { primaryActionButtonClasses } from '@/components/ui/action-button';
import { AuthCardLoading } from '@/components/ui/auth-card-loading';
import { AuthStatusIcon } from '@/components/ui/auth-status-icon';
import { LoadingState } from '@/components/ui/states';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useAuth } from '@/lib/auth-context';
import { useSensitiveQueryToken } from '@/lib/use-sensitive-query-token';

type Status = 'loading' | 'pending' | 'success' | 'error';

function VerifyEmailContent() {
  const { token, isReady } = useSensitiveQueryToken();
  const { refreshUser, user } = useAuth();
  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState('');
  const [resendMessage, setResendMessage] = useState('');
  const [resendError, setResendError] = useState('');
  const [isResending, setIsResending] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!isReady) {
      return;
    }

    if (!token) {
      setStatus('pending');
      setMessage('We sent a verification link to your email address.');
      return;
    }

    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      setStatus('error');
      setMessage('Verification is taking longer than expected. Please try again.');
    }, 15000);

    async function verify() {
      try {
        await api.post('/auth/verify-email', { token });
        await refreshUser();
        if (!timedOut) {
          clearTimeout(timeout);
          setStatus('success');
          setMessage('Your email has been verified successfully.');
        }
      } catch (err: unknown) {
        if (!timedOut) {
          clearTimeout(timeout);
          setStatus('error');
          setMessage(apiErrorMessage(err, 'Verification failed. The link may have expired or already been used.'));
        }
      }
    }

    verify();

    return () => clearTimeout(timeout);
  }, [attempt, isReady, refreshUser, token]);

  const handleRetry = () => {
    setStatus('loading');
    setMessage('');
    setAttempt((current) => current + 1);
  };

  const handleResend = async () => {
    setIsResending(true);
    setResendMessage('');
    setResendError('');

    try {
      const { data } = await api.post('/auth/resend-verification', {});
      setResendMessage(data.message ?? 'Verification email sent.');
    } catch (err: unknown) {
      setResendError(apiErrorMessage(err, 'Verification email could not be sent. Please try again later.'));
    } finally {
      setIsResending(false);
    }
  };

  return (
    <div className="w-full max-w-md min-w-0">
        <Card className="w-full border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-900">
          <CardBody className="p-8 sm:p-10">
            {status === 'loading' && (
              <LoadingState title="Verifying your email" description="This should only take a moment." />
            )}

            {status === 'pending' && (
              <div className="text-center py-4">
                <AuthStatusIcon icon={Mail} />
                <h1 className="text-2xl font-bold text-gray-950 dark:text-white mb-2">Check your email</h1>
                <p className="text-gray-700 dark:text-gray-300 leading-relaxed mb-6">{message}</p>
                <div className="flex flex-col items-center gap-3">
                  {user && (
                    <Button
                      onPress={handleResend}
                      isLoading={isResending}
                      className={primaryActionButtonClasses('font-semibold')}
                      radius="lg"
                    >
                      Resend verification email
                    </Button>
                  )}
                  {resendMessage && (
                    <p role="status" className="text-sm text-green-600 dark:text-green-400">{resendMessage}</p>
                  )}
                  {resendError && (
                    <div className="w-full text-left">
                      <FormAlert title="Verification email could not be sent">{resendError}</FormAlert>
                    </div>
                  )}
                  <Link
                    href="/login"
                    className="text-teal-primary dark:text-teal-bright font-semibold hover:underline text-sm"
                  >
                    Back to sign in
                  </Link>
                </div>
              </div>
            )}

            {status === 'success' && (
              <div className="text-center py-4">
                <AuthStatusIcon icon={Check} tone="success" />
                <h1 className="text-2xl font-bold text-gray-950 dark:text-white mb-2">Email verified</h1>
                <p className="text-gray-700 dark:text-gray-300 leading-relaxed mb-6">{message}</p>
                <Link
                  href={user ? '/dashboard' : '/login'}
                  className={primaryActionButtonClasses('inline-flex items-center justify-center rounded-lg px-8 py-2.5 font-semibold transition-colors')}
                >
                  {user ? 'Continue to dashboard' : 'Go to sign in'}
                </Link>
              </div>
            )}

            {status === 'error' && (
              <div className="text-center py-4">
                <AuthStatusIcon icon={CircleAlert} tone="danger" />
                <h1 className="text-2xl font-bold text-gray-950 dark:text-white mb-2">Verification failed</h1>
                <div className="mb-6 text-left">
                  <FormAlert title="Verification could not be completed">{message}</FormAlert>
                </div>
                <div className="flex flex-col items-center gap-3">
                  <Button
                    onPress={handleRetry}
                    className={primaryActionButtonClasses('font-semibold')}
                    radius="lg"
                  >
                    Try again
                  </Button>
                  <Link
                    href="/login"
                    className="text-teal-primary dark:text-teal-bright font-semibold hover:underline text-sm"
                  >
                    Go to sign in
                  </Link>
                </div>
              </div>
            )}
          </CardBody>
        </Card>
    </div>
  );
}

function VerifyEmailFallback() {
  return (
    <AuthCardLoading title="Preparing email verification" description="Checking your secure verification link." />
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<VerifyEmailFallback />}>
      <VerifyEmailContent />
    </Suspense>
  );
}
