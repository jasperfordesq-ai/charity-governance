'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardBody, Chip, Input } from '@heroui/react';
import { ownerApi } from '@/lib/owner-api';
import { apiErrorMessage } from '@/lib/errors';

/**
 * Where an operator adds or removes their own second factor.
 *
 * Their own, and nobody else's: there is no control here for one operator to
 * remove another's, because that would be a way around the factor rather than
 * a way to support somebody who lost their phone.
 */
type State = {
  enrolled: boolean;
  enrolmentPending: boolean;
  recoveryCodesRemaining: number;
};

export default function OwnerSecurityPage() {
  const [state, setState] = useState<State | null>(null);
  const [offer, setOffer] = useState<{ secret: string; uri: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await ownerApi.secondFactorState());
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not read the security settings.'));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(apiErrorMessage(err, 'That did not work.'));
    } finally {
      setBusy(false);
    }
  }

  if (!state) return <p>{error ?? 'Loading…'}</p>;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Your sign-in security</h1>
      <p className="text-sm text-slate-400">
        This console can suspend any charity on the platform. A second factor means a stolen or
        reused password is not enough on its own.
      </p>

      {error ? <p className="text-danger">{error}</p> : null}

      <Card>
        <CardBody className="gap-4">
          <div className="flex items-center gap-3">
            <Chip color={state.enrolled ? 'success' : 'warning'} data-testid="second-factor-status">
              {state.enrolled ? 'Second factor on' : 'Password only'}
            </Chip>
            {state.enrolled ? (
              <span className="text-sm text-slate-400">
                {state.recoveryCodesRemaining} recovery {state.recoveryCodesRemaining === 1 ? 'code' : 'codes'} left
              </span>
            ) : null}
          </div>

          {recoveryCodes ? (
            <div className="flex flex-col gap-2 rounded border border-warning p-4" data-testid="recovery-codes">
              <p className="font-medium">Save these now. They are not shown again.</p>
              <p className="text-sm text-slate-400">
                Each one works once, and they are the only way back in if you lose your
                authenticator. Keep them somewhere other than the device generating your codes.
              </p>
              <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
                {recoveryCodes.map((recoveryCode) => (
                  <li key={recoveryCode}>{recoveryCode}</li>
                ))}
              </ul>
              <div>
                <Button size="sm" variant="flat" onPress={() => setRecoveryCodes(null)}>
                  I have saved them
                </Button>
              </div>
            </div>
          ) : null}

          {!state.enrolled && !offer ? (
            <div>
              <Button
                color="primary"
                isLoading={busy}
                data-testid="begin-second-factor"
                onPress={() =>
                  run(async () => {
                    setOffer(await ownerApi.beginSecondFactor());
                  })
                }
              >
                Set up a second factor
              </Button>
            </div>
          ) : null}

          {!state.enrolled && offer ? (
            <div className="flex flex-col gap-3" data-testid="enrolment">
              <p className="text-sm">
                Add this to your authenticator application, then enter the code it shows to
                confirm it works. Nothing changes until you do: scanning alone would leave you
                locked out if the setup were wrong.
              </p>
              <code className="break-all rounded bg-slate-800 p-2 text-xs">{offer.uri}</code>
              <p className="text-xs text-slate-400">
                If you cannot scan, enter this secret by hand:{' '}
                <span className="font-mono">{offer.secret}</span>
              </p>
              <Input
                label="Code from the application"
                value={code}
                onValueChange={setCode}
                inputMode="numeric"
                data-testid="enrolment-code"
              />
              <div>
                <Button
                  color="primary"
                  isLoading={busy}
                  isDisabled={code.trim().length === 0}
                  data-testid="confirm-second-factor"
                  onPress={() =>
                    run(async () => {
                      const result = await ownerApi.completeSecondFactor(code.trim());
                      setRecoveryCodes(result.recoveryCodes);
                      setOffer(null);
                      setCode('');
                    })
                  }
                >
                  Confirm and turn it on
                </Button>
              </div>
            </div>
          ) : null}

          {state.enrolled ? (
            <div className="flex flex-col gap-3 rounded border border-slate-700 p-4">
              <p className="text-sm">
                Turning this off needs a current code, so that somebody who borrowed an unlocked
                screen cannot simply remove it.
              </p>
              <Input
                label="Current code"
                value={code}
                onValueChange={setCode}
                inputMode="numeric"
                data-testid="removal-code"
              />
              <div>
                <Button
                  color="danger"
                  variant="flat"
                  isLoading={busy}
                  isDisabled={code.trim().length === 0}
                  data-testid="remove-second-factor"
                  onPress={() =>
                    run(async () => {
                      await ownerApi.removeSecondFactor({ code: code.trim() });
                      setCode('');
                    })
                  }
                >
                  Turn off the second factor
                </Button>
              </div>
            </div>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
