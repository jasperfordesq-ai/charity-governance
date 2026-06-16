'use client';

import { useState, useMemo, type FormEvent } from 'react';
import { Button, Card, CardBody, Input, Link } from '@heroui/react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { apiErrorMessage } from '@/lib/errors';

function PasswordStrengthMeter({ password }: { password: string }) {
  const checks = useMemo(() => {
    return {
      length: password.length >= 8,
      uppercase: /[A-Z]/.test(password),
      number: /[0-9]/.test(password),
      special: /[^A-Za-z0-9]/.test(password),
    };
  }, [password]);

  const score = Object.values(checks).filter(Boolean).length;
  const label = score === 0 ? '' : score <= 1 ? 'Weak' : score <= 2 ? 'Fair' : score <= 3 ? 'Good' : 'Strong';
  const colour = score <= 1 ? 'bg-red-400' : score <= 2 ? 'bg-amber-400' : score <= 3 ? 'bg-teal-400' : 'bg-green-500';

  if (!password) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex-1 flex gap-1">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className={`h-1.5 flex-1 rounded-full transition-colors ${i <= score ? colour : 'bg-gray-200'}`} />
          ))}
        </div>
        <span className={`text-xs font-medium ${score <= 1 ? 'text-red-500' : score <= 2 ? 'text-amber-500' : score <= 3 ? 'text-teal-600' : 'text-green-600'}`}>
          {label}
        </span>
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        {([
          ['length', '8+ characters'],
          ['uppercase', 'Uppercase letter'],
          ['number', 'Number'],
          ['special', 'Special character'],
        ] as const).map(([key, text]) => (
          <li key={key} className={`text-xs flex items-center gap-1.5 ${checks[key] ? 'text-green-600' : 'text-gray-500'}`}>
            {checks[key] ? (
              <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
            ) : (
              <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="9" /></svg>
            )}
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function RegisterPage() {
  const router = useRouter();
  const { register } = useAuth();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [organisationName, setOrganisationName] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setIsLoading(true);

    try {
      await register({ name, email, password, organisationName });
      router.push('/verify-email');
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Something went wrong. Please try again.'));
    } finally {
      setIsLoading(false);
    }
  }

  const emailInvalid = touched.email && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  const nameInvalid = touched.name && !name.trim();
  const passwordInvalid = touched.password && password.length < 8;
  const confirmInvalid = touched.confirmPassword && confirmPassword.length > 0 && password !== confirmPassword;
  const passwordsMatch = password.length >= 8 && confirmPassword.length > 0 && password === confirmPassword;
  const orgInvalid = touched.organisationName && !organisationName.trim();

  const eyeToggle = (
    <button type="button" onClick={() => setShowPassword(!showPassword)} className="text-gray-400 hover:text-gray-600 focus:outline-none" aria-label={showPassword ? 'Hide password' : 'Show password'}>
      {showPassword ? (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>
      ) : (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
      )}
    </button>
  );

  return (
    <div className="w-full max-w-md min-w-0">
        <Card className="w-full border border-gray-200 shadow-lg">
          <CardBody className="p-8 sm:p-10">
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold text-gray-900">Create your account</h1>
              <p className="mt-2 text-sm text-gray-500">
                Start your 14-day free trial. No credit card required.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              {error && (
                <div role="alert" aria-live="assertive" className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
                  {error}
                </div>
              )}

              <Input
                label="Your name"
                type="text"
                value={name}
                onValueChange={setName}
                onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                isRequired
                isInvalid={nameInvalid}
                errorMessage={nameInvalid ? 'Name is required' : undefined}
                autoComplete="name"
                variant="bordered"
                classNames={{
                  inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary',
                }}
              />

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
                  inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary',
                }}
              />

              <div className="space-y-2">
                <Input
                  label="Password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onValueChange={setPassword}
                  onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                  isRequired
                  isInvalid={passwordInvalid}
                  errorMessage={passwordInvalid ? 'Password must be at least 8 characters' : undefined}
                  autoComplete="new-password"
                  variant="bordered"
                  classNames={{
                    inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary',
                  }}
                  endContent={eyeToggle}
                />
                <PasswordStrengthMeter password={password} />
              </div>

              <Input
                label="Confirm password"
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
                  inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary',
                }}
                endContent={
                  <div className="flex items-center gap-1">
                    {passwordsMatch && (
                      <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    )}
                    <button type="button" onClick={() => setShowConfirm(!showConfirm)} className="text-gray-400 hover:text-gray-600 focus:outline-none" aria-label={showConfirm ? 'Hide password' : 'Show password'}>
                      {showConfirm ? (
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>
                      ) : (
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                      )}
                    </button>
                  </div>
                }
              />

              <Input
                label="Organisation name"
                type="text"
                value={organisationName}
                onValueChange={setOrganisationName}
                onBlur={() => setTouched((t) => ({ ...t, organisationName: true }))}
                isRequired
                isInvalid={orgInvalid}
                errorMessage={orgInvalid ? 'Organisation name is required' : undefined}
                placeholder="e.g. Dublin Community Trust"
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
                Create account
              </Button>

              <p className="text-xs text-gray-500 text-center leading-relaxed">
                By creating an account you agree to our{' '}
                <Link href="/terms" className="text-teal-primary hover:underline">
                  Terms of Service
                </Link>{' '}
                and{' '}
                <Link href="/privacy" className="text-teal-primary hover:underline">
                  Privacy Policy
                </Link>
                .
              </p>
            </form>

            <p className="mt-8 text-center text-sm text-gray-500">
              Already have an account?{' '}
              <Link href="/login" className="text-teal-primary font-semibold hover:underline">
                Sign in
              </Link>
            </p>
          </CardBody>
        </Card>
    </div>
  );
}
