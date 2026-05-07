'use client';

import { useEffect, useState } from 'react';
import { Button, Card, CardBody, Link, Spinner } from '@heroui/react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';

type Status = 'loading' | 'success' | 'error';

export default function VerifyEmailPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('No verification token found. Please check the link in your email.');
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
  }, [token]);

  const handleRetry = () => {
    setStatus('loading');
    setMessage('');
    window.location.reload();
  };

  return (
    <div className="w-full max-w-md min-w-0">
        <Card className="w-full border border-gray-100 shadow-lg">
          <CardBody className="p-8 sm:p-10">
            {status === 'loading' && (
              <div className="text-center py-8" role="status" aria-live="polite">
                <Spinner size="lg" color="primary" classNames={{ circle1: 'border-b-teal-primary', circle2: 'border-b-teal-primary' }} />
                <p className="mt-4 text-gray-600 font-medium">Verifying your email...</p>
                <p className="mt-1 text-sm text-gray-400">This should only take a moment.</p>
              </div>
            )}

            {status === 'success' && (
              <div className="text-center py-4">
                <div className="w-14 h-14 rounded-full bg-green-50 flex items-center justify-center mx-auto mb-5">
                  <svg className="w-7 h-7 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
                <h1 className="text-2xl font-bold text-gray-900 mb-2">Email verified</h1>
                <p className="text-gray-600 leading-relaxed mb-6">{message}</p>
                <Link
                  href="/login"
                  className="inline-flex items-center justify-center rounded-full bg-teal-primary text-white font-semibold px-8 py-2.5 hover:opacity-90 transition-opacity"
                >
                  Sign in to your account
                </Link>
              </div>
            )}

            {status === 'error' && (
              <div className="text-center py-4">
                <div className="w-14 h-14 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-5">
                  <svg className="w-7 h-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                </div>
                <h1 className="text-2xl font-bold text-gray-900 mb-2">Verification failed</h1>
                <p role="alert" className="text-gray-600 leading-relaxed mb-6">{message}</p>
                <div className="flex flex-col items-center gap-3">
                  <Button
                    onPress={handleRetry}
                    className="bg-teal-primary text-white font-semibold"
                    radius="full"
                  >
                    Try again
                  </Button>
                  <Link
                    href="/login"
                    className="text-teal-primary font-semibold hover:underline text-sm"
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
