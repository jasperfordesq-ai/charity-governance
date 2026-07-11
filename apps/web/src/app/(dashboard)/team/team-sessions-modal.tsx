'use client';

import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Textarea } from '@heroui/react';
import { teamGovernanceReasonSchema, type TeamMemberResponse, type TeamSessionResponse } from '@charitypilot/shared';
import { EmptyState, InlineStatus, LoadingState } from '@/components/ui/states';
import { StatusChip } from '@/components/ui/status';
import { formatDateTime } from './team-display';

export function TeamSessionsModal({
  member,
  sessions,
  loading,
  savingFamilyId,
  accessDisabled = false,
  reason,
  setReason,
  error,
  onOpenChange,
  onRevokeFamily,
  onRevokeAll,
}: {
  member: TeamMemberResponse | null;
  sessions: TeamSessionResponse[];
  loading: boolean;
  savingFamilyId: string | null;
  accessDisabled?: boolean;
  reason: string;
  setReason: (value: string) => void;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onRevokeFamily: (familyId: string) => void | Promise<void>;
  onRevokeAll: () => void | Promise<void>;
}) {
  const reasonResult = teamGovernanceReasonSchema.safeParse(reason);
  const reasonError = reasonResult.success ? null : reasonResult.error.issues[0]?.message;
  const validReason = reasonResult.success;
  const activeCount = sessions.filter((session) => session.active).length;

  return (
    <Modal isOpen={Boolean(member)} onOpenChange={onOpenChange} size="2xl" scrollBehavior="inside">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>
              <div>
                <h2 className="text-base font-semibold">Sessions for {member?.name}</h2>
                <p className="mt-1 text-xs font-normal text-gray-500">Revocation takes effect on the next authenticated request.</p>
              </div>
            </ModalHeader>
            <ModalBody className="gap-4">
              {error ? <InlineStatus tone="danger">{error}</InlineStatus> : null}
              <Textarea
                label="Revocation reason"
                description="Required for immutable security evidence (10–500 characters; line breaks are allowed)."
                value={reason}
                onValueChange={setReason}
                minRows={2}
                maxLength={500}
                isDisabled={accessDisabled}
                isInvalid={reason.length > 0 && !reasonResult.success}
                errorMessage={reason.length > 0 ? reasonError : undefined}
                isRequired
              />
              {error ? null : loading ? (
                <LoadingState title="Loading sessions" description="Checking active device families." />
              ) : sessions.length === 0 ? (
                <EmptyState title="No session history" description="No refresh-token families are recorded for this member." />
              ) : (
                <div className="divide-y divide-gray-200 overflow-hidden rounded-xl border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
                  {sessions.map((session) => (
                    <article key={session.familyId} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusChip tone={session.active ? 'success' : 'neutral'}>
                            {session.active ? 'Active' : 'Revoked or expired'}
                          </StatusChip>
                          {session.current ? <StatusChip tone="brand">Current session</StatusChip> : null}
                        </div>
                        <p className="mt-2 text-sm font-medium text-gray-700 dark:text-gray-200">
                          Session {session.displaySuffix} · {session.deviceLabel ?? 'Unlabelled device'}
                        </p>
                        <p className="mt-1 text-xs text-gray-500">
                          Started {formatDateTime(session.familyCreatedAt)} · latest rotation {formatDateTime(session.latestCreatedAt)}
                        </p>
                        <p className="mt-1 text-xs text-gray-500">
                          Expires {formatDateTime(session.expiresAt)}
                        </p>
                      </div>
                      {session.active ? (
                        <Button
                          size="sm"
                          color="danger"
                          variant="flat"
                          isDisabled={accessDisabled || Boolean(error) || !validReason || Boolean(savingFamilyId)}
                          isLoading={savingFamilyId === session.familyId}
                          aria-label={`Revoke session ${session.displaySuffix} for ${member?.name ?? 'member'}`}
                          onPress={() => onRevokeFamily(session.familyId)}
                        >
                          Revoke session
                        </Button>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
            </ModalBody>
            <ModalFooter className="flex-col items-stretch gap-2 sm:flex-row sm:justify-between">
              <Button
                variant="flat"
                onPress={onClose}
                isDisabled={Boolean(savingFamilyId)}
                aria-label={`Close sessions for ${member?.name ?? 'member'}`}
              >
                Close
              </Button>
              <Button
                color="danger"
                variant="flat"
                isDisabled={accessDisabled || Boolean(error) || !validReason || activeCount === 0 || Boolean(savingFamilyId)}
                isLoading={savingFamilyId === 'all'}
                onPress={onRevokeAll}
                aria-label={`Revoke all active sessions for ${member?.name ?? 'member'}`}
              >
                Revoke all active sessions
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
