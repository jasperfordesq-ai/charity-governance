'use client';

import type { Dispatch, SetStateAction } from 'react';
import { Button, Card, Input, Select, SelectItem, Textarea } from '@heroui/react';
import {
  ComplianceSignoffStatus,
  type ComplianceSignoffResponse,
} from '@charitypilot/shared';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { FormAlert } from '@/components/ui/form-alert';
import { SaveStatusIndicator } from '@/components/ui/states';
import { StatusChip, statusPanelClassName, type StatusTone } from '@/components/ui/status';

export type ExportSignoffForm = {
  status: ComplianceSignoffStatus;
  boardMeetingDate: string;
  minuteReference: string;
  approvedByName: string;
  approvedByRole: string;
  approvalNotes: string;
};

function signoffTone(color: 'success' | 'warning' | 'default'): StatusTone {
  if (color === 'success') return 'success';
  if (color === 'warning') return 'warning';
  return 'neutral';
}

export function ExportBoardApprovalPanel({
  approvalLabel,
  approvalCurrent,
  approvalSaveBlocked,
  approvalTone,
  approvalUnavailable,
  canManageSignoff,
  onAcknowledgeReview,
  onDiscardSignoff,
  onRetryConflictRefresh,
  onSaveSignoff,
  refreshingConflict,
  savingSignoff,
  setSignoffForm,
  signoff,
  signoffDirty,
  signoffConflictRefreshFailed,
  signoffError,
  signoffForm,
  signoffReviewRequired,
  signoffSaveStatus,
  signoffStatusLabels,
}: {
  approvalLabel: string;
  approvalCurrent: boolean;
  approvalSaveBlocked: boolean;
  approvalTone: 'success' | 'warning' | 'default';
  approvalUnavailable: boolean;
  canManageSignoff: boolean;
  onAcknowledgeReview: () => void;
  onDiscardSignoff: () => void;
  onRetryConflictRefresh: () => void | Promise<void>;
  onSaveSignoff: () => void;
  refreshingConflict: boolean;
  savingSignoff: boolean;
  setSignoffForm: Dispatch<SetStateAction<ExportSignoffForm>>;
  signoff: ComplianceSignoffResponse | null;
  signoffDirty: boolean;
  signoffConflictRefreshFailed: boolean;
  signoffError: string;
  signoffForm: ExportSignoffForm;
  signoffReviewRequired: boolean;
  signoffSaveStatus: 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
  signoffStatusLabels: Record<ComplianceSignoffStatus, string>;
}) {
  return (
    <Card className={statusPanelClassName('neutral', 'p-6 shadow-sm')}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Board approval</h2>
            <StatusChip tone={signoffTone(approvalTone)}>
              {approvalLabel}
            </StatusChip>
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-600 dark:text-gray-400">
            {canManageSignoff
              ? 'Record the board meeting where trustees approved the annual Compliance Record before reporting the position to the Charities Regulator.'
              : 'Review the saved board sign-off. Only an Owner or Admin can change the approval record.'}
          </p>
          {signoff?.updatedAt && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Last updated {new Date(signoff.updatedAt).toLocaleString('en-IE', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManageSignoff ? (
            <>
              <SaveStatusIndicator status={signoffSaveStatus} />
              {(signoffDirty || signoffReviewRequired) ? (
                <Button
                  type="button"
                  variant="flat"
                  onPress={onDiscardSignoff}
                  isDisabled={savingSignoff}
                >
                  Discard changes
                </Button>
              ) : null}
              <Button
                className={primaryActionButtonClassName}
                onPress={onSaveSignoff}
                isLoading={savingSignoff}
                isDisabled={!signoffDirty || approvalSaveBlocked || signoffReviewRequired}
              >
                Save sign-off
              </Button>
            </>
          ) : (
            <StatusChip tone="neutral">View only</StatusChip>
          )}
        </div>
      </div>

      {signoffError && (
        <div className="mt-4">
          <FormAlert>
            {signoffError}
          </FormAlert>
        </div>
      )}

      {canManageSignoff && signoffReviewRequired ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          {signoffConflictRefreshFailed ? (
            <>
              <p>
                The latest saved sign-off could not be loaded. Your local form remains preserved, and saving stays blocked until the
                canonical position is refreshed.
              </p>
              <Button
                type="button"
                size="sm"
                variant="flat"
                color="warning"
                className="mt-3"
                onPress={onRetryConflictRefresh}
                isLoading={refreshingConflict}
              >
                Retry loading latest position
              </Button>
            </>
          ) : (
            <>
              <p>
                The canonical sign-off or evidence changed during this save. Your form remains unsaved. Review the refreshed
                readiness and persisted approval status above before deliberately retrying it.
              </p>
              <Button type="button" size="sm" variant="flat" color="warning" className="mt-3" onPress={onAcknowledgeReview}>
                I have reviewed the refreshed position
              </Button>
            </>
          )}
        </div>
      ) : null}

      {approvalUnavailable && signoffForm.status === ComplianceSignoffStatus.APPROVED ? (
        <div className="mt-4">
          <FormAlert>Approval readiness and its evidence hash must load successfully before board approval can be saved.</FormAlert>
        </div>
      ) : null}

      {signoff?.latestApproval ? (
        <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">
          Latest retained approval: snapshot #{signoff.latestApproval.approvalSequence}, approved{' '}
          {new Date(signoff.latestApproval.approvedAt).toLocaleString('en-IE')}, hash{' '}
          <span className="font-mono">{signoff.latestApproval.snapshotHash.slice(0, 12)}...</span>
          {!approvalCurrent ? ' This snapshot is retained, but current work requires reapproval.' : ''}
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Select
          label="Approval status"
          isDisabled={!canManageSignoff}
          selectedKeys={new Set([signoffForm.status])}
          onSelectionChange={(keys) => {
            if (!canManageSignoff) return;
            const value = Array.from(keys)[0] as ComplianceSignoffStatus | undefined;
            if (value) setSignoffForm((prev) => ({ ...prev, status: value }));
          }}
        >
          {Object.entries(signoffStatusLabels).map(([value, label]) => (
            <SelectItem key={value}>{label}</SelectItem>
          ))}
        </Select>
        <Input
          label="Board meeting date"
          type="date"
          isReadOnly={!canManageSignoff}
          value={signoffForm.boardMeetingDate}
          onValueChange={(value) => {
            if (canManageSignoff) setSignoffForm((prev) => ({ ...prev, boardMeetingDate: value }));
          }}
        />
        <Input
          label="Minute reference"
          placeholder="e.g. Board minutes 24 Oct 2026, item 6"
          isReadOnly={!canManageSignoff}
          value={signoffForm.minuteReference}
          onValueChange={(value) => {
            if (canManageSignoff) setSignoffForm((prev) => ({ ...prev, minuteReference: value }));
          }}
        />
        <Input
          label="Approved by"
          placeholder="Chairperson or authorised trustee"
          isReadOnly={!canManageSignoff}
          value={signoffForm.approvedByName}
          onValueChange={(value) => {
            if (canManageSignoff) setSignoffForm((prev) => ({ ...prev, approvedByName: value }));
          }}
        />
        <Input
          label="Role"
          placeholder="e.g. Chairperson"
          isReadOnly={!canManageSignoff}
          value={signoffForm.approvedByRole}
          onValueChange={(value) => {
            if (canManageSignoff) setSignoffForm((prev) => ({ ...prev, approvedByRole: value }));
          }}
        />
        <Textarea
          label="Approval notes"
          placeholder="Actions agreed, exceptions noted, or follow-up owners."
          isReadOnly={!canManageSignoff}
          value={signoffForm.approvalNotes}
          onValueChange={(value) => {
            if (canManageSignoff) setSignoffForm((prev) => ({ ...prev, approvalNotes: value }));
          }}
          minRows={2}
          className="md:col-span-2"
        />
      </div>
    </Card>
  );
}
