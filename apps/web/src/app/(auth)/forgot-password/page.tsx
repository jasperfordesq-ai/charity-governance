'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, CardBody, Input, Link } from '@heroui/react';
import { Mail } from 'lucide-react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { forgotPasswordSchema, firstSchemaError } from '@/lib/form-schemas';
import { FormAlert } from '@/components/ui/form-alert';

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
        <Card className="w-full border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-900">
          <CardBody className="p-8 sm:p-10">
            {isSuccess ? (
              <div className="text-center py-4">
                <div className="w-14 h-14 rounded-lg bg-teal-primary/10 dark:bg-teal-bright/10 flex items-center justify-center mx-auto mb-5">
                  <Mail className="w-7 h-7 text-teal-primary" aria-hidden="true" />
                </div>
                <h1 className="text-2xl font-bold text-gray-950 dark:text-white mb-2">Check your email</h1>
                <p className="text-gray-700 dark:text-gray-300 leading-relaxed mb-6">
                  If an account exists for <span className="font-medium text-gray-950 dark:text-white">{email}</span>,
                  we have sent a password reset link. Please check your inbox and spam folder.
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
                    Enter your email address and we will send you a link to reset your password.
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
                    className="w-full bg-teal-primary text-white font-semibold"
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
