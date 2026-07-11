'use client';

import type { Dispatch, SetStateAction } from 'react';
import {
  Button,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@heroui/react';
import { DataList, DataListItems, DataListTable } from '@/components/ui/data-list';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { EmptyState, ErrorState, LoadingState, PermissionHint, SaveStatusIndicator } from '@/components/ui/states';
import { StatusChip, statusPanelClassName } from '@/components/ui/status';
import type { BoardMemberResponse } from '@charitypilot/shared';
import { BoardEvidenceChips } from './board-evidence';

const formatDate = (value: string | null | undefined) => {
  if (!value) return 'Not set';
  return new Date(value).toLocaleDateString('en-IE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

type BoardMemberListPanelProps = {
  canManage: boolean;
  displayMembers: BoardMemberResponse[];
  fetchMembers: (showLoading?: boolean) => Promise<void>;
  loadError: string;
  loading: boolean;
  mutatingMemberId: string | null;
  onAdd: () => void;
  onEdit: (member: BoardMemberResponse) => void;
  onToggleActive: (member: BoardMemberResponse) => Promise<void>;
  saving: boolean;
  setShowInactive: Dispatch<SetStateAction<boolean>>;
  showInactive: boolean;
};

export function BoardMemberListPanel({
  canManage,
  displayMembers,
  fetchMembers,
  loadError,
  loading,
  mutatingMemberId,
  onAdd,
  onEdit,
  onToggleActive,
  saving,
  setShowInactive,
  showInactive,
}: BoardMemberListPanelProps) {
  const boardMutationStatus: 'idle' | 'saving' | 'saved' | 'error' = mutatingMemberId || saving ? 'saving' : 'idle';

  return (
    <DataList
      title="Trustees"
      description={canManage
        ? 'The active view is the default register. Toggle inactive members when you need historic appointment evidence.'
        : 'Review active and historic trustee appointment evidence. Board register changes are available to owners and administrators.'}
      actions={(
        <>
          {canManage ? <SaveStatusIndicator status={boardMutationStatus} /> : (
            <PermissionHint>Read-only board register</PermissionHint>
          )}
          <Switch
            size="sm"
            color="primary"
            isSelected={showInactive}
            onValueChange={setShowInactive}
            classNames={{
              label: 'text-sm text-gray-600 dark:text-gray-300',
            }}
          >
            Show inactive
          </Switch>
        </>
      )}
    >
      {loading ? (
        <LoadingState title="Loading board register" description="Checking trustee appointment and evidence records." />
      ) : loadError && displayMembers.length === 0 ? (
        <ErrorState
          title="Board register could not be loaded"
          description={loadError}
          action={(
            <Button size="sm" variant="flat" onPress={() => fetchMembers(true)}>
              Try again
            </Button>
          )}
        />
      ) : displayMembers.length === 0 ? (
        <EmptyState
          title={showInactive ? 'No trustees in this view' : 'No active trustees added yet'}
          description={showInactive
            ? 'No active or inactive trustees are available.'
            : canManage
              ? 'Add trustees so conduct, induction, appointment, and term evidence can be reviewed before annual sign-off.'
              : 'An owner or administrator must add trustees before board evidence can be reviewed.'}
          action={canManage ? (
            <Button size="sm" className={primaryActionButtonClassName} onPress={onAdd}>
              Add first trustee
            </Button>
          ) : undefined}
        />
      ) : (
        <div className="space-y-3">
          {loadError ? (
            <ErrorState
              title="Some trustee data may be out of date"
              description={loadError}
              action={(
                <Button size="sm" variant="flat" onPress={() => fetchMembers(true)}>
                  Refresh
                </Button>
              )}
            />
          ) : null}
          {/* Keep table and mobile card views at field parity for trustee evidence review. */}
          <div className="sm:hidden">
            <DataListItems divided={false}>
              <div className="space-y-3 p-3">
                {displayMembers.map((member) => (
                  <article key={member.id} className={statusPanelClassName('neutral', 'p-4')}>
                    <div className="flex flex-col gap-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="break-words text-sm font-semibold text-gray-950 dark:text-gray-50">{member.name}</h3>
                          <p className="text-xs text-gray-600 dark:text-gray-300">{member.role}</p>
                          {member.email ? <p className="break-words text-xs text-gray-500 dark:text-gray-400">{member.email}</p> : null}
                        </div>
                        <StatusChip tone={member.isActive ? 'success' : 'neutral'}>
                          {member.isActive ? 'Active' : 'Inactive'}
                        </StatusChip>
                      </div>
                      <dl className="grid grid-cols-2 gap-3 text-xs text-gray-600 dark:text-gray-300">
                        <div>
                          <dt className="font-medium text-gray-500 dark:text-gray-400">Appointed</dt>
                          <dd>{formatDate(member.appointedDate)}</dd>
                        </div>
                        <div>
                          <dt className="font-medium text-gray-500 dark:text-gray-400">Term end</dt>
                          <dd>{formatDate(member.termEndDate)}</dd>
                        </div>
                        <div>
                          <dt className="font-medium text-gray-500 dark:text-gray-400">Conduct date</dt>
                          <dd>{formatDate(member.conductSignedDate)}</dd>
                        </div>
                        <div>
                          <dt className="font-medium text-gray-500 dark:text-gray-400">Induction date</dt>
                          <dd>{formatDate(member.inductionDate)}</dd>
                        </div>
                      </dl>
                      <BoardEvidenceChips member={member} />
                      {canManage ? <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="flat"
                          onPress={() => onEdit(member)}
                          isDisabled={Boolean(mutatingMemberId) || saving}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="flat"
                          color={member.isActive ? 'warning' : 'success'}
                          onPress={() => onToggleActive(member)}
                          isLoading={mutatingMemberId === member.id}
                          isDisabled={Boolean(mutatingMemberId) && mutatingMemberId !== member.id}
                        >
                          {member.isActive ? 'Deactivate' : 'Activate'}
                        </Button>
                      </div> : null}
                    </div>
                  </article>
                ))}
              </div>
            </DataListItems>
          </div>

          <div className="hidden sm:block">
            <DataListTable label="Board members" scrollHintId="board-register-scroll-hint">
              <Table aria-label="Board members" removeWrapper>
                <TableHeader>
                  <TableColumn>Name</TableColumn>
                  <TableColumn>Role</TableColumn>
                  <TableColumn className="hidden md:table-cell">Appointed</TableColumn>
                  <TableColumn className="hidden lg:table-cell">Term end</TableColumn>
                  <TableColumn>Evidence</TableColumn>
                  <TableColumn>Status</TableColumn>
                  <TableColumn>Actions</TableColumn>
                </TableHeader>
                <TableBody>
                  {displayMembers.map((member) => (
                    <TableRow key={member.id}>
                      <TableCell>
                        <div className="min-w-44">
                          <p className="text-sm font-medium text-gray-950 dark:text-gray-50">{member.name}</p>
                          {member.email ? <p className="text-xs text-gray-500 dark:text-gray-400">{member.email}</p> : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-gray-700 dark:text-gray-300">{member.role}</span>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <span className="text-sm text-gray-600 dark:text-gray-300">{formatDate(member.appointedDate)}</span>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <span className="text-sm text-gray-600 dark:text-gray-300">{formatDate(member.termEndDate)}</span>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-2">
                          <BoardEvidenceChips member={member} />
                          <dl className="grid min-w-48 grid-cols-1 gap-1 text-xs text-gray-600 dark:text-gray-300 xl:grid-cols-2">
                            <div>
                              <dt className="font-medium text-gray-500 dark:text-gray-400">Conduct date</dt>
                              <dd>{formatDate(member.conductSignedDate)}</dd>
                            </div>
                            <div>
                              <dt className="font-medium text-gray-500 dark:text-gray-400">Induction date</dt>
                              <dd>{formatDate(member.inductionDate)}</dd>
                            </div>
                          </dl>
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusChip tone={member.isActive ? 'success' : 'neutral'}>
                          {member.isActive ? 'Active' : 'Inactive'}
                        </StatusChip>
                      </TableCell>
                      <TableCell>
                        {canManage ? <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="flat"
                            onPress={() => onEdit(member)}
                            isDisabled={Boolean(mutatingMemberId) || saving}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="flat"
                            color={member.isActive ? 'warning' : 'success'}
                            onPress={() => onToggleActive(member)}
                            isLoading={mutatingMemberId === member.id}
                            isDisabled={Boolean(mutatingMemberId) && mutatingMemberId !== member.id}
                          >
                            {member.isActive ? 'Deactivate' : 'Activate'}
                          </Button>
                        </div> : <span className="text-xs text-gray-500 dark:text-gray-400">Read only</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </DataListTable>
          </div>
        </div>
      )}
    </DataList>
  );
}
