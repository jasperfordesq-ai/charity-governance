'use client';

import { useEffect, useState } from 'react';
import { ownerApi, type TenantAdministrativeEvent } from '@/lib/owner-api';

/**
 * What the platform has done to this charity, and who did it.
 *
 * An operator could change a charity's configuration and had no way to see
 * what had already been changed, by whom, or why — including their own earlier
 * changes. Every one of those rows was being written; none of them was
 * readable from the console that wrote them.
 *
 * Deliberately only the platform's own actions. The charity's security trail is
 * theirs, is on their Team page, and is nobody at the platform's business to
 * browse.
 */
const LABELS: Record<string, string> = {
  ORGANISATION_SUSPENDED: 'Suspended',
  ORGANISATION_REACTIVATED: 'Reactivated',
  ORGANISATION_CLOSED: 'Closed',
  ORGANISATION_CONFIGURATION_CHANGED: 'Configuration changed',
};

function describe(event: TenantAdministrativeEvent): string {
  const context = (event.context ?? {}) as Record<string, unknown>;
  const parts: string[] = [];

  if ('newDocumentStorageProvider' in context) {
    const next = context['newDocumentStorageProvider'];
    parts.push(`storage set to ${next === null ? 'the deployment default' : String(next)}`);
  }
  if ('newDocumentStorageAlphaOptIn' in context) {
    parts.push(`alpha providers ${context['newDocumentStorageAlphaOptIn'] ? 'allowed' : 'not allowed'}`);
  }
  if ('newPlan' in context) parts.push(`plan set to ${String(context['newPlan'])}`);

  return parts.join(', ');
}

export function TenantHistoryPanel({ tenantId }: { tenantId: string }) {
  const [events, setEvents] = useState<TenantAdministrativeEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ownerApi
      .tenantHistory(tenantId)
      .then(setEvents)
      .catch(() => setError('Could not load what the platform has done here.'));
  }, [tenantId]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!events) return <p className="text-sm text-gray-500">Loading history…</p>;

  return (
    <section className="flex flex-col gap-3" data-testid="tenant-history">
      <div>
        <h2 className="text-lg font-semibold">What the platform has done here</h2>
        <p className="text-sm text-gray-500">
          Actions taken by platform operators. This charity&rsquo;s own security history stays with
          them.
        </p>
      </div>

      {events.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing yet.</p>
      ) : (
        <ul className="divide-y divide-gray-200 dark:divide-gray-800">
          {events.map((event) => (
            <li key={event.id} className="py-2 text-sm">
              <p className="font-medium">
                {LABELS[event.type] ?? event.type}
                <span className="font-normal text-gray-500">
                  {' '}
                  by {event.actorLabel} on {new Date(event.occurredAt).toLocaleString('en-IE')}
                </span>
              </p>
              {describe(event) ? <p className="text-gray-600 dark:text-gray-300">{describe(event)}</p> : null}
              <p className="text-gray-500">&ldquo;{event.reason}&rdquo;</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
