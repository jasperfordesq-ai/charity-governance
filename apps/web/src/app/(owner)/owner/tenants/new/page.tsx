'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, Input, Select, SelectItem } from '@heroui/react';
import { ownerApi } from '@/lib/owner-api';
import { apiErrorMessage } from '@/lib/errors';

const PLANS = ['ESSENTIALS', 'COMPLETE'] as const;
type Plan = (typeof PLANS)[number];

export default function OwnerProvisionTenantPage() {
  const router = useRouter();
  const [organisationName, setOrganisationName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [plan, setPlan] = useState<Plan>('ESSENTIALS');
  const [trialDays, setTrialDays] = useState('14');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const trialDaysNumber = Number(trialDays);
  const canSubmit =
    organisationName.trim().length > 0 &&
    ownerName.trim().length > 0 &&
    ownerEmail.trim().length > 0 &&
    Number.isInteger(trialDaysNumber) &&
    trialDaysNumber >= 1;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setIsLoading(true);
    try {
      await ownerApi.provisionTenant({
        organisationName: organisationName.trim(),
        ownerName: ownerName.trim(),
        ownerEmail: ownerEmail.trim(),
        plan,
        trialDays: trialDaysNumber,
      });
      router.push('/owner/tenants');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not provision this tenant.'));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardBody className="gap-4">
          <h1 className="text-2xl font-semibold">Provision a new tenant</h1>
          <p className="text-sm">
            Creates the organisation and its OWNER account. The new owner receives a
            verification email and a separate email to set their password — the
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
            <Input
              label="Trial length (days)"
              type="number"
              min={1}
              max={365}
              value={trialDays}
              onValueChange={setTrialDays}
              isRequired
            />
            <Button type="submit" color="primary" isLoading={isLoading} isDisabled={!canSubmit}>
              Provision tenant
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
