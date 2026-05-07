'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, CardBody, Input, Link } from '@heroui/react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

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
    setIsLoading(true);

    try {
      await login(email, password);
      router.push('/dashboard');
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        'Invalid email or password. Please try again.';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }

  const emailInvalid = touched.email && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  const passwordInvalid = touched.password && !password;

  return (
    <div className="w-full max-w-md min-w-0">
      <Card className="w-full border border-gray-100 shadow-lg">
        <CardBody className="p-6 sm:p-10">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-gray-900">Welcome back</h1>
            <p className="mt-2 text-sm text-gray-500">
              Sign in to your CharityPilot account
            </p>
          </div>

          <div className="mb-6 rounded-lg border border-teal-primary/20 bg-teal-primary/5 px-4 py-3 text-sm">
            <p className="font-semibold text-teal-primary">Demo workspace</p>
            <p className="mt-1 text-gray-600">
              Use <span className="break-all font-mono text-gray-800">demo@charitypilot.ie</span> with password{' '}
              <span className="font-mono text-gray-800">DemoPass123!</span>.
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
                onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                isRequired
                isInvalid={emailInvalid}
                errorMessage={emailInvalid ? 'Please enter a valid email address' : undefined}
                autoComplete="email"
                variant="bordered"
                classNames={{
                  inputWrapper: 'border-gray-200 hover:border-teal-primary focus-within:!border-teal-primary',
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
                  inputWrapper: 'border-gray-200 hover:border-teal-primary focus-within:!border-teal-primary',
                }}
                endContent={
                  <button type="button" onClick={() => setShowPassword(!showPassword)} className="text-gray-400 hover:text-gray-600 focus:outline-none" aria-label={showPassword ? 'Hide password' : 'Show password'}>
                    {showPassword ? (
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>
                    ) : (
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    )}
                  </button>
                }
              />

              <div className="flex justify-end">
                <Link href="/forgot-password" className="text-sm text-teal-primary font-medium hover:underline">
                  Forgot your password?
                </Link>
              </div>

              <Button
                type="submit"
                isLoading={isLoading}
                className="w-full bg-teal-primary text-white font-semibold"
                radius="full"
                size="lg"
              >
                Sign in
              </Button>
          </form>

          <p className="mt-8 text-center text-sm text-gray-500">
            Don&apos;t have an account?{' '}
            <Link href="/register" className="text-teal-primary font-semibold hover:underline">
              Start your free trial
            </Link>
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
