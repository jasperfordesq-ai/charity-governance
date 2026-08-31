'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, Input, Radio, RadioGroup, Select, SelectItem } from '@heroui/react';
import { ownerApi } from '@/lib/owner-api';
import { apiErrorMessage } from '@/lib/errors';
import { CopyLinkButton } from '@/components/copy-link-button';

const PLANS = ['ESSENTIALS', 'COMPLETE'] as const;
type Plan = (typeof PLANS)[number];

type Billing = 'trial' | 'comped';

type ProvisionLinks = { setPassword: string; verifyEmail: string };

export default function OwnerProvisionTenantPage() {
  const router = useRouter();
  const [organisationName, setOrganisationName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [plan, setPlan] = useState<Plan>('ESSENTIALS');
  const [billing, setBilling] = useState<Billing>('trial');
  const [trialDays, setTrialDays] = useState('14');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [links, setLinks] = useState<ProvisionLinks | null>(null);

  const trialDaysNumber = Number(trialDays);
  const canSubmit =
    organisationName.trim().length > 0 &&
    ownerName.trim().length > 0 &&
    ownerEmail.trim().length > 0 &&
    (billing === 'comped' || (Number.isInteger(trialDaysNumber) && trialDaysNumber >= 1));

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setIsLoading(true);
    try {
      // trialDays is only ever included for a trial — the API rejects a comped
      // request that carries it (400 VALIDATION_ERROR), so this can't be a
      // field that's merely hidden in the UI while still being sent.
      const result = await ownerApi.provisionTenant({
        organisationName: organisationName.trim(),
        ownerName: ownerName.trim(),
        ownerEmail: ownerEmail.trim(),
        plan,
        billing,
        ...(billing === 'trial' ? { trialDays: trialDaysNumber } : {}),
      });
      if (result.links) {
        // Manual-link deployments have no endpoint to re-read these — show them
        // once and stop here rather than navigating away and losing them.
        setLinks(result.links);
      } else {
        router.push('/owner/tenants');
      }
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not provision this tenant.'));
    } finally {
      setIsLoading(false);
    }
  }

  if (links) {
    return (
      <div className="mx-auto w-full max-w-md">
        <Card>
          <CardBody className="gap-4">
            <h1 className="text-2xl font-semibold">Tenant provisioned</h1>
            <div className="flex flex-col gap-3 rounded border border-warning p-4">
              <p className="text-sm font-medium text-warning-600 dark:text-warning-400">
                These links are shown once and are not emailed. Copy them now and pass them to
                the charity owner.
              </p>
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">Set password link</span>
                <div className="flex items-center gap-2">
                  <Input aria-label="Set password link" value={links.setPassword} isReadOnly className="min-w-0 flex-1" />
                  <CopyLinkButton url={links.setPassword} />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">Verify email link</span>
                <div className="flex items-center gap-2">
                  <Input aria-label="Verify email link" value={links.verifyEmail} isReadOnly className="min-w-0 flex-1" />
                  <CopyLinkButton url={links.verifyEmail} />
                </div>
              </div>
            </div>
            <Button color="primary" onPress={() => router.push('/owner/tenants')}>
              Done
            </Button>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardBody className="gap-4">
          <h1 className="text-2xl font-semibold">Provision a new tenant</h1>
          <p className="text-sm">
            Creates the organisation and its OWNER account. Depending on how this deployment is
            configured, the new owner either receives a verification email and a separate email
            to set their password, or you are shown one-time links to pass on yourself — the
            operator never chooses their credential.
          </p>
          {error ? <p className="text-danger">{error}</p> : null}
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <Input
              label="Organisation name"
              value={organisationName}
              onValueChange={setOrganisationName}
              isRequired
            />
            <Input label="Owner name" value={ownerName} onValueChange={setOwnerName} isRequired />
            <Input
              label="Owner email"
              type="email"
              value={ownerEmail}
              onValueChange={setOwnerEmail}
              isRequired
            />
            <Select
              label="Plan"
              selectedKeys={new Set([plan])}
              onSelectionChange={(keys) => {
                const value = Array.from(keys)[0];
                if (value === 'ESSENTIALS' || value === 'COMPLETE') setPlan(value);
              }}
            >
              {PLANS.map((option) => (
                <SelectItem key={option}>{option}</SelectItem>
              ))}
            </Select>
            <RadioGroup
              label="Billing"
              value={billing}
              onValueChange={(value) => setBilling(value as Billing)}
            >
              <Radio value="trial" description="Starts on a time-limited trial.">
                Trial
              </Radio>
              <Radio value="comped" description="No trial period — active immediately, comped.">
                Comped
              </Radio>
            </RadioGroup>
            {billing === 'trial' ? (
              <Input
                label="Trial length (days)"
                type="number"
                min={1}
                max={365}
                value={trialDays}
                onValueChange={setTrialDays}
                isRequired
              />
            ) : null}
            <Button type="submit" color="primary" isLoading={isLoading} isDisabled={!canSubmit}>
              Provision tenant
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
