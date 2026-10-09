'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Input } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { AppSection } from '@/components/ui/app-page';
import { useAuth } from '@/lib/auth-context';

type State = { enrolled: boolean; enrolmentPending: boolean; recoveryCodesRemaining: number };

export function PersonalSecondFactorPanel() {
  const { user } = useAuth();
  const [state, setState] = useState<State | null>(null);
  const [offer, setOffer] = useState<{ secret: string; uri: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await api.get<State>('/auth/second-factor');
    setState(response.data);
  }, []);

  useEffect(() => {
    void refresh().catch((err) => setError(apiErrorMessage(err, 'Could not load sign-in security.')));
  }, [refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (err) { setError(apiErrorMessage(err, 'The security change could not be completed.')); }
    finally { setBusy(false); }
  }

  return (
    <AppSection title="Your two-step sign-in">
      <div className="space-y-4 text-sm">
        <p className="text-gray-600 dark:text-gray-300">
          An authenticator adds a code to your password for browser and connector sign-in.
          {user?.mfaEnrolmentRequired
            ? 'Your Owner or Admin role requires an enrolled authenticator before you can use this workspace.'
            : 'This account setting may be required by your workspace policy.'}
        </p>
        {error ? <p role="alert" className="text-danger">{error}</p> : null}
        {!state ? <p>Loading sign-in security…</p> : (
          <>
            <p className="font-medium">
              {state.enrolled
                ? `On · ${state.recoveryCodesRemaining} unused recovery codes`
                : 'Off · password sign-in'}
            </p>
            {recoveryCodes ? (
              <div className="space-y-3 rounded-lg border border-warning p-4">
                <p className="font-semibold">Save these codes now. They will not be shown again.</p>
                <p>Each code works once. Store them separately from your authenticator.</p>
                <ul className="grid grid-cols-2 gap-1 font-mono">
                  {recoveryCodes.map((value) => <li key={value}>{value}</li>)}
                </ul>
                <Button onPress={() => { setRecoveryCodes(null); window.location.assign('/login'); }}>
                  I saved them · sign in again
                </Button>
              </div>
            ) : null}
            {!state.enrolled && !recoveryCodes ? (
              <div className="space-y-3">
                {!offer ? (
                  <>
                    <Input type="password" label="Current password" value={password} onValueChange={setPassword} autoComplete="current-password" />
                    <Button isDisabled={!password} isLoading={busy} onPress={() => run(async () => {
                      const result = await api.post<{ secret: string; uri: string }>('/auth/second-factor/begin', { password });
                      setOffer(result.data);
                      setPassword('');
                    })}>Set up authenticator</Button>
                    {state.enrolmentPending ? <p>Previous setup was not finished. Starting again gives you a new secret.</p> : null}
                  </>
                ) : (
                  <div className="space-y-3">
                    <p>Add this account in your authenticator using the setup key below, then enter its current six-digit code.</p>
                    <code className="block break-all rounded border p-2 dark:border-gray-700">{offer.secret}</code>
                    <Input type="password" label="Authenticator code" inputMode="numeric" autoComplete="one-time-code" value={code} onValueChange={setCode} />
                    <Button isDisabled={!/^\d{6}$/.test(code.trim())} isLoading={busy} onPress={() => run(async () => {
                      const result = await api.post<{ recoveryCodes: string[] }>('/auth/second-factor/complete', { code: code.trim() });
                      setRecoveryCodes(result.data.recoveryCodes);
                      setState({ enrolled: true, enrolmentPending: false,
                        recoveryCodesRemaining: result.data.recoveryCodes.length });
                      setOffer(null);
                      setCode('');
                    })}>Confirm and turn on</Button>
                  </div>
                )}
              </div>
            ) : null}
            {state.enrolled && !recoveryCodes ? (
              <div className="space-y-3 rounded-lg border p-4 dark:border-gray-700">
                <p>Turning this off requires your password and a current authenticator or unused recovery code. If you signed in with your last recovery code within the past 15 minutes, you may leave the code blank. All sessions will end.</p>
                <Input type="password" label="Current password" value={password} onValueChange={setPassword} autoComplete="current-password" />
                <Input type="password" label="Authenticator or recovery code" value={code} onValueChange={setCode} autoComplete="one-time-code" />
                <Button color="danger" variant="flat" isDisabled={!password} isLoading={busy} onPress={() => run(async () => {
                  const offered = code.trim();
                  await api.post('/auth/second-factor/remove', {
                    password,
                    ...(/^\d{6}$/.test(offered) ? { code: offered } : offered ? { recoveryCode: offered } : {}),
                  });
                  setPassword('');
                  setCode('');
                  window.location.assign('/login');
                })}>Turn off two-step sign-in</Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </AppSection>
  );
}
