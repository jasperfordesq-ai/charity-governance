import { Button, Select, SelectItem } from '@heroui/react';
import type { TeamMemberResponse, TeamResponse, UserResponse } from '@charitypilot/shared';
import { UserRole } from '@charitypilot/shared';
import { canEditMemberRole } from '@/lib/team-permissions';
import { DataList, DataListItems } from '@/components/ui/data-list';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { ReviewFlag, StatusChip } from '@/components/ui/status';
import { ROLE_META, formatDate } from './team-display';

export function TeamMembersPanel({
  error,
  loading,
  onRetry,
  onUpdateRole,
  roleUpdateMemberId,
  team,
  user,
}: {
  error: string | null;
  loading: boolean;
  onRetry: () => void;
  onUpdateRole: (member: TeamMemberResponse, nextRole: UserRole) => void;
  roleUpdateMemberId: string | null;
  team: TeamResponse | null;
  user: UserResponse | null;
}) {
  const roleEditDisabledReason = (member: TeamMemberResponse) => {
    if (member.role === UserRole.OWNER) return 'Owner role changes are protected.';
    if (member.id === user?.id) return 'You cannot change your own role.';
    if (!canEditMemberRole(user?.role, user?.id, member)) return 'Only owners can change member roles.';
    return '';
  };

  return (
    <DataList
      title="Members"
      description="Owners are protected from in-page demotion. Role changes mirror the API role guard and remain owner-only."
    >
      {loading ? (
        <LoadingState title="Loading team" description="Checking members and pending invites." />
      ) : error && !team ? (
        <ErrorState
          title="Team settings could not be loaded"
          description={error}
          action={(
            <Button size="sm" variant="flat" onPress={onRetry}>
              Try again
            </Button>
          )}
        />
      ) : !team?.members.length ? (
        <EmptyState
          title="No members found"
          description="The organisation owner should appear here once the team endpoint returns member data."
        />
      ) : (
        <DataListItems>
          {team.members.map((member) => {
            const roleDisabledReason = roleEditDisabledReason(member);
            return (
              <article key={member.id} className="p-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="break-words text-sm font-semibold text-gray-950 dark:text-gray-50">{member.name}</h3>
                      <StatusChip tone={ROLE_META[member.role].tone}>{ROLE_META[member.role].label}</StatusChip>
                      {!member.emailVerified ? <ReviewFlag tone="needs-review">Email not verified</ReviewFlag> : null}
                    </div>
                    <p className="mt-1 break-words text-sm text-gray-600 dark:text-gray-300">{member.email}</p>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Joined {formatDate(member.createdAt)}</p>
                    <p className="mt-2 max-w-xl text-xs leading-5 text-gray-500 dark:text-gray-400">
                      {ROLE_META[member.role].description}
                    </p>
                  </div>

                  {canEditMemberRole(user?.role, user?.id, member) ? (
                    <Select
                      aria-label={`Role for ${member.name}`}
                      size="sm"
                      className="w-full sm:w-44"
                      selectedKeys={new Set([member.role])}
                      isDisabled={Boolean(roleUpdateMemberId)}
                      onSelectionChange={(keys) => {
                        const next = Array.from(keys)[0] as UserRole | undefined;
                        if (next && next !== member.role) onUpdateRole(member, next);
                      }}
                    >
                      <SelectItem key={UserRole.ADMIN}>Admin</SelectItem>
                      <SelectItem key={UserRole.MEMBER}>Member</SelectItem>
                    </Select>
                  ) : (
                    <div className="max-w-xs rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs leading-5 text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">
                      {roleDisabledReason}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </DataListItems>
      )}
    </DataList>
  );
}
