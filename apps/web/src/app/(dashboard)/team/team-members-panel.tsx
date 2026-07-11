import { Button, Select, SelectItem } from '@heroui/react';
import type { TeamMemberResponse, TeamResponse, UserResponse } from '@charitypilot/shared';
import { UserRole } from '@charitypilot/shared';
import {
  canEditMemberRole,
  canManageMemberLifecycle,
  canManageMemberSessions,
  canTransferOwnership,
} from '@/lib/team-permissions';
import { DataList, DataListItems } from '@/components/ui/data-list';
import { EmptyState, ErrorState, LoadingState, PermissionHint } from '@/components/ui/states';
import { ReviewFlag, StatusChip } from '@/components/ui/status';
import { ROLE_META, formatDate } from './team-display';

export function TeamMembersPanel({
  error,
  loading,
  onRetry,
  onUpdateRole,
  onLifecycleAction,
  onViewSessions,
  onTransferOwnership,
  roleUpdateMemberId,
  managementDisabled,
  team,
  user,
}: {
  error: string | null;
  loading: boolean;
  onRetry: () => void;
  onUpdateRole: (member: TeamMemberResponse, nextRole: UserRole.ADMIN | UserRole.MEMBER) => void;
  onLifecycleAction: (member: TeamMemberResponse, action: 'suspend' | 'reactivate' | 'remove') => void;
  onViewSessions: (member: TeamMemberResponse) => void;
  onTransferOwnership: (member: TeamMemberResponse) => void;
  roleUpdateMemberId: string | null;
  managementDisabled: boolean;
  team: TeamResponse | null;
  user: UserResponse | null;
}) {
  const roleEditDisabledReason = (member: TeamMemberResponse) => {
    if (member.role === UserRole.OWNER) return 'Owner role changes are protected.';
    if (member.lifecycleStatus !== 'ACTIVE') return 'Reactivate this membership before changing its role.';
    if (member.id === user?.id) return 'You cannot change your own role.';
    if (!canEditMemberRole(user?.role, user?.id, member)) return 'Only owners can change member roles.';
    return '';
  };

  return (
    <DataList
      title="Members"
      description="Manage roles, membership access, and session families. Owner changes use the protected transfer workflow."
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
                      {member.lifecycleStatus === 'SUSPENDED' ? <ReviewFlag tone="needs-review">Suspended</ReviewFlag> : null}
                      {member.lifecycleStatus === 'REMOVED' ? <ReviewFlag tone="blocked">Removed</ReviewFlag> : null}
                      {!member.emailVerified ? <ReviewFlag tone="needs-review">Email not verified</ReviewFlag> : null}
                    </div>
                    <p className="mt-1 break-words text-sm text-gray-600 dark:text-gray-300">{member.email}</p>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Joined {formatDate(member.createdAt)}</p>
                    {member.activeSessionCount !== undefined ? (
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        {member.activeSessionCount} active {member.activeSessionCount === 1 ? 'session' : 'sessions'}
                      </p>
                    ) : null}
                    <p className="mt-2 max-w-xl text-xs leading-5 text-gray-500 dark:text-gray-400">
                      {ROLE_META[member.role].description}
                    </p>
                  </div>

                  <div className="flex w-full flex-col items-stretch gap-2 sm:w-48">
                    {canEditMemberRole(user?.role, user?.id, member) && member.lifecycleStatus === 'ACTIVE' ? (
                      <Select
                        aria-label={`Role for ${member.name}`}
                        size="sm"
                        selectedKeys={new Set([member.role])}
                        isDisabled={managementDisabled || Boolean(roleUpdateMemberId)}
                        onSelectionChange={(keys) => {
                          const next = Array.from(keys)[0] as UserRole.ADMIN | UserRole.MEMBER | undefined;
                          if (next && next !== member.role) onUpdateRole(member, next);
                        }}
                      >
                        <SelectItem key={UserRole.ADMIN}>Admin</SelectItem>
                        <SelectItem key={UserRole.MEMBER}>Member</SelectItem>
                      </Select>
                    ) : (
                      <PermissionHint>{roleDisabledReason}</PermissionHint>
                    )}

                    {canManageMemberSessions(user?.role, user?.id, member) ? (
                      <Button
                        size="sm"
                        variant="flat"
                        isDisabled={managementDisabled}
                        aria-label={`Manage sessions for ${member.name} (${member.email})`}
                        onPress={() => onViewSessions(member)}
                      >
                        Manage sessions
                      </Button>
                    ) : null}
                    {canManageMemberLifecycle(user?.role, user?.id, member) ? (
                      <div className="grid grid-cols-2 gap-2">
                        {member.lifecycleStatus === 'ACTIVE' ? (
                          <Button
                            size="sm"
                            color="warning"
                            variant="flat"
                            isDisabled={managementDisabled}
                            aria-label={`Suspend ${member.name} (${member.email})`}
                            onPress={() => onLifecycleAction(member, 'suspend')}
                          >
                            Suspend
                          </Button>
                        ) : member.lifecycleStatus === 'SUSPENDED' ? (
                          <Button
                            size="sm"
                            color="primary"
                            variant="flat"
                            isDisabled={managementDisabled}
                            aria-label={`Reactivate ${member.name} (${member.email})`}
                            onPress={() => onLifecycleAction(member, 'reactivate')}
                          >
                            Reactivate
                          </Button>
                        ) : null}
                        {member.lifecycleStatus !== 'REMOVED' ? (
                          <Button
                            size="sm"
                            color="danger"
                            variant="flat"
                            isDisabled={managementDisabled}
                            aria-label={`Remove ${member.name} (${member.email})`}
                            onPress={() => onLifecycleAction(member, 'remove')}
                          >
                            Remove
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                    {canTransferOwnership(user?.role, user?.id, member) ? (
                      <Button
                        size="sm"
                        color="danger"
                        variant="bordered"
                        isDisabled={managementDisabled}
                        aria-label={`Transfer ownership to ${member.name} (${member.email})`}
                        onPress={() => onTransferOwnership(member)}
                      >
                        Transfer ownership
                      </Button>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </DataListItems>
      )}
    </DataList>
  );
}
