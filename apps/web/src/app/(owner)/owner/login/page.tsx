'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, Input } from '@heroui/react';
import { ownerApi } from '@/lib/owner-api';
import { apiErrorMessage } from '@/lib/errors';
import { FormAlert } from '@/components/ui/form-alert';

/**
 * The second factor field appears only once the server has asked for it.
 *
 * Showing it to everybody would ask most operators for something they do not
 * have, and an empty box beside a password is a reliable way to make people
 * think they have forgotten something.
 */
function isSecondFactorRequired(error: unknown): boolean {
  return (
    (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code
    === 'SECOND_FACTOR_REQUIRED'
  );
}

export default function OwnerLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [needsSecondFactor, setNeedsSecondFactor] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      const result = await ownerApi.login(
        email,
        password,
        useRecovery ? { recoveryCode } : code ? { code } : {},
      );
      if (result.usedRecoveryCode) {
        // Said out loud because a recovery code is one of ten and nobody counts
        // them in their head.
        sessionStorage.setItem('owner-used-recovery-code', '1');
      }
      router.push('/owner/tenants');
    } catch (err) {
      if (isSecondFactorRequired(err)) {
        setNeedsSecondFactor(true);
        setError(
          needsSecondFactor
            ? 'That code did not match. Check the time on the device generating it, and try the next one.'
            : 'Enter the current code from your authenticator application.',
        );
      } else {
        setNeedsSecondFactor(false);
        setError(apiErrorMessage(err, 'Invalid email or password.'));
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardBody className="gap-4">
          <h1 className="text-xl font-semibold">Platform console sign in</h1>
          {error ? <FormAlert>{error}</FormAlert> : null}
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <Input label="Email" type="email" value={email} onValueChange={setEmail} autoComplete="username" />
            <Input
              label="Password"
              type="password"
              value={password}
              onValueChange={setPassword}
              autoComplete="current-password"
            />

            {needsSecondFactor ? (
              <div className="flex flex-col gap-2" data-testid="second-factor">
                {useRecovery ? (
                  <Input
                    label="Recovery code"
                    value={recoveryCode}
                    onValueChange={setRecoveryCode}
                    autoComplete="one-time-code"
                    description="One of the codes you saved when you set this up. Each works once."
                  />
                ) : (
                  <Input
                    label="Authentication code"
                    value={code}
                    onValueChange={setCode}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    description="The six digits your authenticator application is showing now."
                  />
                )}
                <Button
                  size="sm"
                  variant="light"
                  onPress={() => {
                    setUseRecovery((current) => !current);
                    setError(null);
                  }}
                >
                  {useRecovery ? 'Use my authenticator instead' : 'I have lost my authenticator'}
                </Button>
              </div>
            ) : null}

            <Button type="submit" isLoading={isLoading} color="primary">
              Sign in
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
