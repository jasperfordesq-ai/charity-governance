import { Button } from '@heroui/react';
import type { SecurityAuditEventResponse } from '@charitypilot/shared';
import { AppSection } from '@/components/ui/app-page';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { StatusChip } from '@/components/ui/status';
import { formatDate } from './team-display';

const EVENT_LABELS: Record<string, string> = {
  MEMBER_SUSPENDED: 'Member suspended',
  MEMBER_REACTIVATED: 'Member reactivated',
  MEMBER_REMOVED: 'Member removed',
  MEMBER_ROLE_CHANGED: 'Role changed',
  OWNERSHIP_TRANSFERRED: 'Ownership transferred',
  OWNERSHIP_RECOVERED: 'Ownership recovered',
  SESSION_REVOKED: 'Session revoked',
  ALL_SESSIONS_REVOKED: 'All sessions revoked',
  INVITE_REVOKED: 'Invite revoked',
};

export function TeamSecurityAuditPanel({
  events,
  loading,
  error,
  onRetry,
}: {
  events: SecurityAuditEventResponse[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <AppSection
      title="Security & ownership audit"
      description="Immutable evidence for team access, session, role, and ownership changes."
    >
      {loading ? (
        <LoadingState title="Loading security audit" description="Checking the latest governance events." />
      ) : error ? (
        <ErrorState
          title="Security audit could not be loaded"
          description={error}
          action={(
            <Button size="sm" variant="flat" onPress={onRetry}>
              Try again
            </Button>
          )}
        />
      ) : events.length === 0 ? (
        <EmptyState title="No security events yet" description="Lifecycle and ownership actions will be recorded here." />
      ) : (
        <div className="divide-y divide-gray-200 dark:divide-gray-800">
          {events.map((event, index) => (
            <article key={`${event.occurredAt}:${event.type}:${index}`} className="py-4 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip tone="neutral">{EVENT_LABELS[event.type] ?? event.type}</StatusChip>
                <span className="text-xs text-gray-500">{formatDate(event.occurredAt)}</span>
              </div>
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">{event.reason}</p>
              <p className="mt-1 text-xs text-gray-500">Affected: {event.subjectLabel}</p>
              <p className="mt-1 text-xs text-gray-500">Recorded by {event.actorLabel}</p>
            </article>
          ))}
        </div>
      )}
    </AppSection>
  );
}
