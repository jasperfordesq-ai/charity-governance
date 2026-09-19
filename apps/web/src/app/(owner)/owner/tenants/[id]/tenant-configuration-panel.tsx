'use client';

import { useEffect, useState } from 'react';
import {
  Button,
  Chip,
  Select,
  SelectItem,
  Switch,
  Textarea,
} from '@heroui/react';
import { ownerApi, type TenantConfiguration } from '@/lib/owner-api';
import { apiErrorMessage } from '@/lib/errors';

/**
 * The settings a platform operator may change about a charity they do not
 * belong to.
 *
 * Kept in its own component because it is a different kind of action from the
 * lifecycle controls beside it: suspending a charity is an emergency, changing
 * where its files live is an arrangement. Mixing them in one form would make
 * the destructive buttons neighbours of a routine save.
 *
 * A reason is required, as it is for a lifecycle change, and for the same
 * reason: this is somebody else's charity.
 */
const DEFAULT_PROVIDER_KEY = '__deployment_default__';

export function TenantConfigurationPanel({ tenantId }: { tenantId: string }) {
  const [configuration, setConfiguration] = useState<TenantConfiguration | null>(null);
  const [provider, setProvider] = useState<string>(DEFAULT_PROVIDER_KEY);
  const [alphaOptIn, setAlphaOptIn] = useState(false);
  const [plan, setPlan] = useState<string>('ESSENTIALS');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function adopt(next: TenantConfiguration) {
    setConfiguration(next);
    setProvider(next.documentStorageProvider ?? DEFAULT_PROVIDER_KEY);
    setAlphaOptIn(next.documentStorageAlphaOptIn);
    setPlan(next.plan ?? 'ESSENTIALS');
  }

  useEffect(() => {
    ownerApi
      .getTenantConfiguration(tenantId)
      .then(adopt)
      .catch(() => setError('Could not load this tenant’s configuration.'));
  }, [tenantId]);

  if (!configuration) {
    return <p className="text-sm text-gray-500">{error ?? 'Loading configuration…'}</p>;
  }

  const selectedProvider =
    provider === DEFAULT_PROVIDER_KEY ? null : configuration.availableProviders.find((p) => p.id === provider);

  // Only the fields that actually differ are sent, so a save cannot reset a
  // setting the operator never looked at.
  const change = {
    ...(provider === DEFAULT_PROVIDER_KEY
      ? configuration.documentStorageProvider === null
        ? {}
        : { documentStorageProvider: null }
      : provider === configuration.documentStorageProvider
        ? {}
        : { documentStorageProvider: provider }),
    ...(alphaOptIn === configuration.documentStorageAlphaOptIn
      ? {}
      : { documentStorageAlphaOptIn: alphaOptIn }),
    ...(plan === (configuration.plan ?? 'ESSENTIALS') ? {} : { plan: plan as 'ESSENTIALS' | 'COMPLETE' }),
  };
  const nothingToSave = Object.keys(change).length === 0;

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      adopt(await ownerApi.updateTenantConfiguration(tenantId, { ...change, reason: reason.trim() }));
      setReason('');
      setSaved(true);
    } catch (err) {
      setError(apiErrorMessage(err, 'That configuration change could not be applied.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded border border-gray-300 p-4 dark:border-gray-700">
      <div>
        <h2 className="text-lg font-semibold">Configuration</h2>
        <p className="text-sm text-gray-500">
          Settings this charity cannot change for itself. Every change here is recorded against
          your name with the reason you give.
        </p>
      </div>

      <Select
        label="Document storage"
        description={
          provider === DEFAULT_PROVIDER_KEY
            ? `Following the deployment default, which is currently ${configuration.deploymentDefaultProvider}.`
            : 'Where this charity’s uploaded files are stored.'
        }
        selectedKeys={[provider]}
        onSelectionChange={(keys) => {
          const next = Array.from(keys)[0];
          if (typeof next === 'string') setProvider(next);
        }}
      >
        {[
          <SelectItem key={DEFAULT_PROVIDER_KEY}>
            {`Deployment default (${configuration.deploymentDefaultProvider})`}
          </SelectItem>,
          ...configuration.availableProviders.map((option) => (
            <SelectItem key={option.id} isDisabled={!option.selectable}>
              {option.stage === 'ga' ? option.id : `${option.id} (${option.stage})`}
            </SelectItem>
          )),
        ]}
      </Select>

      {selectedProvider && !selectedProvider.selectable ? (
        <p className="text-sm text-danger">{selectedProvider.unavailableBecause}</p>
      ) : null}

      <Switch isSelected={alphaOptIn} onValueChange={setAlphaOptIn}>
        <span className="text-sm">
          This charity has agreed to use alpha storage providers
          <span className="block text-xs text-gray-500">
            An alpha provider cannot be selected without this, and it is a decision to take with
            the charity rather than for them.
          </span>
        </span>
      </Switch>

      <Select
        label="Plan"
        selectedKeys={[plan]}
        onSelectionChange={(keys) => {
          const next = Array.from(keys)[0];
          if (typeof next === 'string') setPlan(next);
        }}
      >
        <SelectItem key="ESSENTIALS">Essentials</SelectItem>
        <SelectItem key="COMPLETE">Complete</SelectItem>
      </Select>

      <div className="rounded bg-gray-100 p-3 text-sm dark:bg-gray-800">
        <p className="font-medium">Confluence</p>
        {configuration.confluence ? (
          <p className="text-gray-600 dark:text-gray-300">
            <Chip size="sm" color={configuration.confluence.status === 'CONNECTED' ? 'success' : 'default'}>
              {configuration.confluence.status}
            </Chip>{' '}
            {configuration.confluence.spaceKey
              ? `Publishing to space ${configuration.confluence.spaceKey}.`
              : 'No space chosen yet.'}
            {configuration.confluence.lastError ? ` Last error: ${configuration.confluence.lastError}` : ''}
          </p>
        ) : (
          <p className="text-gray-600 dark:text-gray-300">Not connected.</p>
        )}
        <p className="mt-1 text-xs text-gray-500">
          Connecting Confluence needs the charity to sign in to Atlassian themselves, so it cannot
          be done from here. Documents always remain stored with the charity&rsquo;s chosen
          provider; Confluence is a mirror.
        </p>
      </div>

      <Textarea
        label="Reason (recorded in the audit trail)"
        value={reason}
        onValueChange={setReason}
      />

      {error ? <p className="text-danger">{error}</p> : null}
      {saved ? <p className="text-success text-sm">Configuration saved.</p> : null}

      <div>
        <Button
          color="primary"
          isDisabled={nothingToSave || !reason.trim() || saving}
          isLoading={saving}
          onPress={save}
        >
          {nothingToSave ? 'No changes to save' : 'Save configuration'}
        </Button>
      </div>
    </section>
  );
}
