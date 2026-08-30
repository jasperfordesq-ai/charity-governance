'use client';

import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { Button, Input, Select, SelectItem } from '@heroui/react';
import type { TeamResponse } from '@charitypilot/shared';
import { UserRole } from '@charitypilot/shared';
import { primaryActionButtonClasses } from '@/components/ui/action-button';
import { AppSection } from '@/components/ui/app-page';
import { DataListItems } from '@/components/ui/data-list';
import { FieldGroup, FormHint } from '@/components/ui/forms';
import { EmptyState, PermissionHint } from '@/components/ui/states';
import { StatusChip, statusPanelClassName } from '@/components/ui/status';
import { ROLE_META, formatDate, inviteStatus } from './team-display';
import { useInviteLinkReissue } from './use-invite-link-reissue';
import { CopyLinkButton } from '@/components/copy-link-button';

export function TeamInvitesPanel({
  allowedInviteRoles,
  canInvite,
  canInviteAdmin,
  email,
  inviteDisabledReason,
  inviteMember,
  inviteRoleHint,
  manualInviteUrl,
  setManualInviteUrl,
  permissionDisabledReason,
  managementDisabled,
  revokeInvite,
  revokeInviteId,
  role,
  saving,
  setEmail,
  setRole,
  team,
}: {
  allowedInviteRoles: Array<UserRole.ADMIN | UserRole.MEMBER>;
  canInvite: boolean;
  canInviteAdmin: boolean;
  email: string;
  inviteDisabledReason: string;
  inviteMember: (event: FormEvent) => void;
  inviteRoleHint: string;
  manualInviteUrl: string | null;
  setManualInviteUrl: Dispatch<SetStateAction<string | null>>;
  permissionDisabledReason: string;
  managementDisabled: boolean;
  revokeInvite: (inviteId: string) => void;
  revokeInviteId: string | null;
  role: UserRole.ADMIN | UserRole.MEMBER;
  saving: boolean;
  setEmail: (email: string) => void;
  setRole: (role: UserRole.ADMIN | UserRole.MEMBER) => void;
  team: TeamResponse | null;
}) {
  const { reissueInviteLink, reissuingInviteId, reissueError } =
    useInviteLinkReissue(setManualInviteUrl);

  return (
    <div className="space-y-5">
      <form
        className={statusPanelClassName('neutral', 'p-5 shadow-sm')}
        onSubmit={inviteMember}
      >
        <FieldGroup
          title="Invite someone"
          description={inviteRoleHint}
        >
          <Input
            label="Email"
            type="email"
            value={email}
            onValueChange={setEmail}
            isRequired
            isDisabled={!canInvite || managementDisabled}
          />
          <Select
            label="Role"
            selectedKeys={new Set([role])}
            isDisabled={!canInvite || managementDisabled}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0] as UserRole.ADMIN | UserRole.MEMBER | undefined;
              if (next && allowedInviteRoles.includes(next)) setRole(next);
            }}
          >
            <SelectItem key={UserRole.MEMBER}>Member</SelectItem>
            <SelectItem key={UserRole.ADMIN} isDisabled={!canInviteAdmin}>Admin</SelectItem>
          </Select>
          <FormHint id="team-invite-disabled-hint" tone={inviteDisabledReason ? 'warning' : 'neutral'}>
            {inviteDisabledReason || 'The invite will be created with a pending status until accepted, revoked, or expired.'}
          </FormHint>
          <Button
            type="submit"
            className={primaryActionButtonClasses('w-full')}
            isLoading={saving}
            isDisabled={!canInvite || managementDisabled || Boolean(inviteDisabledReason) || saving}
            aria-describedby="team-invite-disabled-hint"
          >
            Send invite
          </Button>
        </FieldGroup>
      </form>

      {manualInviteUrl ? (
        <AppSection
          title="Copy this private invitation now"
          description="This bearer link is shown only after creation. Send it to the intended director through a trusted channel; anyone holding it can use the invitation until it expires or is revoked."
        >
          <div className="flex items-center gap-2">
            <Input
              aria-label="Private invitation link"
              value={manualInviteUrl}
              isReadOnly
              className="min-w-0 flex-1"
            />
            <CopyLinkButton url={manualInviteUrl} />
          </div>
          <Button type="button" size="sm" variant="flat" onPress={() => setManualInviteUrl(null)}>
            Dismiss link
          </Button>
        </AppSection>
      ) : null}

      <AppSection
        title="Pending invites"
        description="Pending invites can be revoked by owners or admins until accepted or expired. A replacement link can be issued if the original was lost; issuing one stops the previous link working."
      >
        {reissueError ? <FormHint tone="danger">{reissueError}</FormHint> : null}
        {!team?.invites.length ? (
          <EmptyState
            title="No team invites yet"
            description="Invite records will appear here with pending, accepted, revoked, or expired status."
          />
        ) : (
          <DataListItems divided={false}>
            <div className="space-y-3 p-3">
              {team.invites.map((invite) => {
                const status = inviteStatus(invite);
                const active = status.label === 'Pending';
                return (
                  <article key={invite.id} className={statusPanelClassName('neutral', 'p-3')}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-semibold text-gray-950 dark:text-gray-50">{invite.email}</p>
                        <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                          {ROLE_META[invite.role].label} invited by {invite.invitedByName ?? 'CharityPilot'}
                        </p>
                      </div>
                      <StatusChip tone={status.tone}>{status.label}</StatusChip>
                    </div>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-xs text-gray-500 dark:text-gray-400">Expires {formatDate(invite.expiresAt)}</p>
                      {active && canInvite ? (
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="flat"
                            onPress={() => reissueInviteLink(invite.id)}
                            isLoading={reissuingInviteId === invite.id}
                            isDisabled={managementDisabled || Boolean(revokeInviteId) || Boolean(reissuingInviteId) || saving}
                            aria-label={`Create a new invitation link for ${invite.email}`}
                          >
                            New link
                          </Button>
                          <Button
                            size="sm"
                            variant="flat"
                            color="danger"
                            onPress={() => revokeInvite(invite.id)}
                            isLoading={revokeInviteId === invite.id}
                            isDisabled={managementDisabled || Boolean(revokeInviteId) || Boolean(reissuingInviteId) || saving}
                            aria-label={`Revoke invitation for ${invite.email}`}
                          >
                            Revoke
                          </Button>
                        </div>
                      ) : active ? (
                        <PermissionHint>
                          {permissionDisabledReason}
                        </PermissionHint>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </DataListItems>
        )}
      </AppSection>
    </div>
  );
}
