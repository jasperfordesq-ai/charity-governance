'use client';

import { useState, useMemo, type FormEvent } from 'react';
import { Button, Card, CardBody, Input, Link } from '@heroui/react';
import { Check, Circle, Eye, EyeOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { apiErrorMessage } from '@/lib/errors';
import { registerSchema, firstSchemaError, passwordIssue } from '@/lib/form-schemas';

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
            <div key={i} className={`h-1.5 flex-1 rounded transition-colors ${i <= score ? colour : 'bg-gray-200 dark:bg-gray-700'}`} />
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
          <li key={key} className={`text-xs flex items-center gap-1.5 ${checks[key] ? 'text-green-600 dark:text-green-400' : 'text-gray-600 dark:text-gray-300'}`}>
            {checks[key] ? (
              <Check className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
            ) : (
              <Circle className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
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

    // Gate on the SAME shared schema the server validates with — no client/server drift.
    const issue = firstSchemaError(registerSchema, { name, email, password, organisationName });
    if (issue) {
      setError(issue);
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
  const passwordIssueMessage = passwordIssue(password);
  const passwordInvalid = touched.password && passwordIssueMessage !== null;
  const confirmInvalid = touched.confirmPassword && confirmPassword.length > 0 && password !== confirmPassword;
  const passwordsMatch = password.length >= 8 && confirmPassword.length > 0 && password === confirmPassword;
  const orgInvalid = touched.organisationName && !organisationName.trim();

  const eyeToggle = (
    <button type="button" onClick={() => setShowPassword(!showPassword)} className="text-gray-500 hover:text-gray-700 focus:outline-none dark:text-gray-400 dark:hover:text-gray-200" aria-label={showPassword ? 'Hide password' : 'Show password'}>
      {showPassword ? (
        <EyeOff className="w-5 h-5" aria-hidden="true" />
      ) : (
        <Eye className="w-5 h-5" aria-hidden="true" />
      )}
    </button>
  );

  return (
    <div className="w-full max-w-md min-w-0">
        <Card className="w-full border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-900">
          <CardBody className="p-8 sm:p-10">
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold text-gray-950 dark:text-white">Create your account</h1>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                Start your 14-day free trial. No credit card required.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              {error && (
                <div role="alert" aria-live="assertive" className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm dark:bg-red-950/40 dark:border-red-800 dark:text-red-100">
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
                  inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary dark:border-gray-700 dark:hover:border-teal-bright dark:focus-within:!border-teal-bright',
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
                  inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary dark:border-gray-700 dark:hover:border-teal-bright dark:focus-within:!border-teal-bright',
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
                  errorMessage={passwordInvalid ? (passwordIssueMessage ?? 'Password must be at least 8 characters') : undefined}
                  autoComplete="new-password"
                  variant="bordered"
                  classNames={{
                    inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary dark:border-gray-700 dark:hover:border-teal-bright dark:focus-within:!border-teal-bright',
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
                  inputWrapper: 'border-gray-300 hover:border-teal-primary focus-within:!border-teal-primary dark:border-gray-700 dark:hover:border-teal-bright dark:focus-within:!border-teal-bright',
                }}
                endContent={
                  <div className="flex items-center gap-1">
                    {passwordsMatch && (
                      <Check className="w-5 h-5 text-green-500" aria-hidden="true" />
                    )}
                    <button type="button" onClick={() => setShowConfirm(!showConfirm)} className="text-gray-500 hover:text-gray-700 focus:outline-none dark:text-gray-400 dark:hover:text-gray-200" aria-label={showConfirm ? 'Hide password' : 'Show password'}>
                      {showConfirm ? (
                        <EyeOff className="w-5 h-5" aria-hidden="true" />
                      ) : (
                        <Eye className="w-5 h-5" aria-hidden="true" />
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
                Create account
              </Button>

              <p className="text-xs text-gray-600 dark:text-gray-300 text-center leading-relaxed">
                By creating an account you agree to our{' '}
                <Link href="/terms" className="text-teal-primary dark:text-teal-bright hover:underline">
                  Terms of Service
                </Link>{' '}
                and{' '}
                <Link href="/privacy" className="text-teal-primary dark:text-teal-bright hover:underline">
                  Privacy Policy
                </Link>
                .
              </p>
            </form>

            <p className="mt-8 text-center text-sm text-gray-600 dark:text-gray-300">
              Already have an account?{' '}
              <Link href="/login" className="text-teal-primary dark:text-teal-bright font-semibold hover:underline">
                Sign in
              </Link>
            </p>
          </CardBody>
        </Card>
    </div>
  );
}
