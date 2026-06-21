'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, CardBody, Input, Link } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { forgotPasswordSchema, firstSchemaError } from '@/lib/form-schemas';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

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
      await api.post('/auth/forgot-password', { email });
      setIsSuccess(true);
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Something went wrong. Please try again.'));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md min-w-0">
        <Card className="w-full border border-gray-200 shadow-lg">
          <CardBody className="p-8 sm:p-10">
            {isSuccess ? (
              <div className="text-center py-4">
                <div className="w-14 h-14 rounded-full bg-teal-primary/10 flex items-center justify-center mx-auto mb-5">
                  <svg className="w-7 h-7 text-teal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                  </svg>
                </div>
                <h1 className="text-2xl font-bold text-gray-900 mb-2">Check your email</h1>
                <p className="text-gray-600 leading-relaxed mb-6">
                  If an account exists for <span className="font-medium text-gray-900">{email}</span>,
                  we have sent a password reset link. Please check your inbox and spam folder.
                </p>
                <Link href="/login" className="text-teal-primary font-semibold hover:underline text-sm">
                  Back to sign in
                </Link>
              </div>
            ) : (
              <>
                <div className="text-center mb-8">
                  <h1 className="text-2xl font-bold text-gray-900">Forgot your password?</h1>
                  <p className="mt-2 text-sm text-gray-500">
                    Enter your email address and we will send you a link to reset your password.
                  </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-5">
                  {error && (
                    <div role="alert" aria-live="assertive" className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
                      {error}
                    </div>
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
                      inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary',
                    }}
                  />

                  <Button
                    type="submit"
                    isLoading={isLoading}
                    className="w-full bg-teal-primary text-white font-semibold"
                    radius="full"
                    size="lg"
                  >
                    Send reset link
                  </Button>
                </form>

                <p className="mt-8 text-center text-sm text-gray-500">
                  Remember your password?{' '}
                  <Link href="/login" className="text-teal-primary font-semibold hover:underline">
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
