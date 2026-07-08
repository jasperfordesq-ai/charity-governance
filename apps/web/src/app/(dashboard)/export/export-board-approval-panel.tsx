'use client';

import type { Dispatch, SetStateAction } from 'react';
import { Button, Card, Input, Select, SelectItem, Textarea } from '@heroui/react';
import { ComplianceSignoffStatus, type ComplianceSignoffResponse } from '@charitypilot/shared';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { FormAlert } from '@/components/ui/form-alert';
import { SaveStatusIndicator } from '@/components/ui/states';
import { StatusChip, type StatusTone } from '@/components/ui/status';

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
  onSaveSignoff,
  savingSignoff,
  setSignoffForm,
  signoff,
  signoffChipColor,
  signoffError,
  signoffForm,
  signoffStatusLabels,
}: {
  onSaveSignoff: () => void;
  savingSignoff: boolean;
  setSignoffForm: Dispatch<SetStateAction<ExportSignoffForm>>;
  signoff: ComplianceSignoffResponse | null;
  signoffChipColor: 'success' | 'warning' | 'default';
  signoffError: string;
  signoffForm: ExportSignoffForm;
  signoffStatusLabels: Record<ComplianceSignoffStatus, string>;
}) {
  const signoffSaveStatus: 'idle' | 'saving' | 'saved' | 'error' =
    savingSignoff ? 'saving' : signoffError ? 'error' : 'idle';

  return (
    <Card className="border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Board approval</h2>
            <StatusChip tone={signoffTone(signoffChipColor)}>
              {signoffStatusLabels[signoffForm.status]}
            </StatusChip>
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-600 dark:text-gray-400">
            Record the board meeting where trustees approved the annual Compliance Record before reporting the position to the Charities Regulator.
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
          <SaveStatusIndicator status={signoffSaveStatus} />
          <Button
            className={primaryActionButtonClassName}
            onPress={onSaveSignoff}
            isLoading={savingSignoff}
          >
            Save sign-off
          </Button>
        </div>
      </div>

      {signoffError && (
        <div className="mt-4">
          <FormAlert>
            {signoffError}
          </FormAlert>
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Select
          label="Approval status"
          selectedKeys={new Set([signoffForm.status])}
          onSelectionChange={(keys) => {
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
          value={signoffForm.boardMeetingDate}
          onValueChange={(value) => setSignoffForm((prev) => ({ ...prev, boardMeetingDate: value }))}
        />
        <Input
          label="Minute reference"
          placeholder="e.g. Board minutes 24 Oct 2026, item 6"
          value={signoffForm.minuteReference}
          onValueChange={(value) => setSignoffForm((prev) => ({ ...prev, minuteReference: value }))}
        />
        <Input
          label="Approved by"
          placeholder="Chairperson or authorised trustee"
          value={signoffForm.approvedByName}
          onValueChange={(value) => setSignoffForm((prev) => ({ ...prev, approvedByName: value }))}
        />
        <Input
          label="Role"
          placeholder="e.g. Chairperson"
          value={signoffForm.approvedByRole}
          onValueChange={(value) => setSignoffForm((prev) => ({ ...prev, approvedByRole: value }))}
        />
        <Textarea
          label="Approval notes"
          placeholder="Actions agreed, exceptions noted, or follow-up owners."
          value={signoffForm.approvalNotes}
          onValueChange={(value) => setSignoffForm((prev) => ({ ...prev, approvalNotes: value }))}
          minRows={2}
          className="md:col-span-2"
        />
      </div>
    </Card>
  );
}
