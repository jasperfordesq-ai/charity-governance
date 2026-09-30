import { Button } from '@heroui/react';
import type { SecurityAuditEventResponse } from '@charitypilot/shared';
import { AppSection } from '@/components/ui/app-page';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { StatusChip } from '@/components/ui/status';
import { formatDate } from './team-display';

const EVENT_LABELS: Record<string, string> = {
  ACTION_APPROVAL_REFUSED: 'Action approval refused',
  SECOND_FACTOR_ENROLLED: 'Two-step sign-in enabled',
  SECOND_FACTOR_REMOVED: 'Two-step sign-in removed',
  SECOND_FACTOR_RECOVERY_USED: 'Recovery code used',
  MEMBER_SUSPENDED: 'Member suspended',
  MEMBER_REACTIVATED: 'Member reactivated',
  MEMBER_REMOVED: 'Member removed',
  MEMBER_ROLE_CHANGED: 'Role changed',
  OWNERSHIP_TRANSFERRED: 'Ownership transferred',
  OWNERSHIP_RECOVERED: 'Ownership recovered',
  SESSION_REVOKED: 'Session revoked',
  ALL_SESSIONS_REVOKED: 'All sessions revoked',
  INVITE_REVOKED: 'Invite revoked',
  PASSWORD_RESET_COMPLETED: 'Password reset completed',
  PASSWORD_CHANGED: 'Password changed',
};

export function TeamSecurityAuditPanel({
  events,
  loading,
  error,
  onRetry,
  nextCursor,
  loadingOlder,
  olderError,
  onLoadOlder,
}: {
  events: SecurityAuditEventResponse[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  nextCursor: string | null;
  loadingOlder: boolean;
  olderError: string | null;
  onLoadOlder: () => void;
}) {
  return (
    <AppSection
      title="Security & ownership audit"
      description="Immutable evidence for team access, password recovery, refused action approvals, sessions, roles, and ownership changes."
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
        <EmptyState title="No security events yet" description="Password recovery, lifecycle, session, and ownership actions will be recorded here." />
      ) : (
        <div>
          <div className="divide-y divide-gray-200 dark:divide-gray-800">
          {events.map((event, index) => (
            <article key={`${event.occurredAt}:${event.type}:${index}`} className="py-4 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip tone="neutral">{EVENT_LABELS[event.type] ?? event.type}</StatusChip>
                <time dateTime={event.occurredAt} className="text-xs text-gray-500">{formatDate(event.occurredAt)}</time>
              </div>
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">{event.reason}</p>
              <p className="mt-1 text-xs text-gray-500">Affected: {event.subjectLabel}</p>
              <p className="mt-1 text-xs text-gray-500">Recorded by {event.actorLabel}</p>
            </article>
          ))}
          </div>
          {olderError ? <p role="alert" className="mt-4 text-sm text-red-600">{olderError}</p> : null}
          {nextCursor ? (
            <Button size="sm" variant="flat" className="mt-4" isLoading={loadingOlder} onPress={onLoadOlder}>
              Load older events
            </Button>
          ) : null}
        </div>
      )}
    </AppSection>
  );
}
