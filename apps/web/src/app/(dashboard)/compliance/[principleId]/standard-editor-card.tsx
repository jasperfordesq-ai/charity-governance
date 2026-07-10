'use client';

import { Button, Card, Select, SelectItem, Textarea } from '@heroui/react';
import { useState } from 'react';
import {
  ComplianceStatus,
  type GovernancePrincipleResponse,
} from '@charitypilot/shared';
import { StatusChip, StatusDot, statusPanelClassName, type StatusTone } from '@/components/ui/status';
import { SaveStatusIndicator } from '@/components/ui/states';
import { ConfirmActionModal } from '@/components/ui/confirm-action-modal';

export interface StandardFormState {
  status: ComplianceStatus;
  actionTaken: string;
  evidence: string;
  notes: string;
  explanationIfNA: string;
}

export interface SaveState {
  [standardId: string]: 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';
}

type ComplianceStandard = GovernancePrincipleResponse['standards'][number];

const statusOptions = [
  { key: ComplianceStatus.COMPLIANT, label: 'Compliant' },
  { key: ComplianceStatus.WORKING_TOWARDS, label: 'Working Towards' },
  { key: ComplianceStatus.NOT_STARTED, label: 'Not Yet Started' },
  { key: ComplianceStatus.NOT_APPLICABLE, label: 'Not Applicable' },
  { key: ComplianceStatus.EXPLAIN, label: 'Explain Non-Compliance' },
];

const statusTones: Record<ComplianceStatus, StatusTone> = {
  [ComplianceStatus.COMPLIANT]: 'success',
  [ComplianceStatus.WORKING_TOWARDS]: 'warning',
  [ComplianceStatus.NOT_STARTED]: 'neutral',
  [ComplianceStatus.NOT_APPLICABLE]: 'info',
  [ComplianceStatus.EXPLAIN]: 'danger',
};

const statusAccentClasses: Record<ComplianceStatus, string> = {
  [ComplianceStatus.COMPLIANT]: 'bg-emerald-500 dark:bg-emerald-400',
  [ComplianceStatus.WORKING_TOWARDS]: 'bg-amber-500 dark:bg-amber-300',
  [ComplianceStatus.NOT_STARTED]: 'bg-gray-400 dark:bg-gray-500',
  [ComplianceStatus.NOT_APPLICABLE]: 'bg-sky-500 dark:bg-sky-400',
  [ComplianceStatus.EXPLAIN]: 'bg-rose-500 dark:bg-rose-400',
};

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function labelForStatus(status: ComplianceStatus, fallback?: string) {
  return statusOptions.find((option) => option.key === status)?.label ?? fallback ?? status;
}

export function StandardEditorCard({
  standard,
  form,
  save,
  updateField,
  flushSave,
  onRetrySave,
  onResolveConflict,
}: {
  standard: ComplianceStandard;
  form: StandardFormState;
  save: SaveState[string];
  updateField: (standardId: string, field: keyof StandardFormState, value: string) => void;
  flushSave: (standardId: string) => void | Promise<unknown>;
  onRetrySave: (standardId: string, form: StandardFormState) => void;
  onResolveConflict: (standardId: string) => Promise<string | null>;
}) {
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileError, setReconcileError] = useState('');
  const statusTone = statusTones[form.status] ?? 'neutral';
  const showExplanation =
    form.status === ComplianceStatus.NOT_APPLICABLE ||
    form.status === ComplianceStatus.EXPLAIN;

  const reconcileWithServer = async () => {
    setReconciling(true);
    setReconcileError('');
    try {
      const error = await onResolveConflict(standard.id);
      if (error) {
        setReconcileError(error);
        return;
      }
      setReconcileOpen(false);
    } finally {
      setReconciling(false);
    }
  };

  return (
    <Card
      key={standard.id}
      className={statusPanelClassName('neutral', 'shadow-sm overflow-hidden')}
    >
      <div className={classes('h-1', statusAccentClasses[form.status] ?? statusAccentClasses.NOT_STARTED)} />
      <div className="p-5 sm:p-6 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <StatusChip tone={statusTone} className="flex-shrink-0 font-mono font-semibold">
              {standard.code}
            </StatusChip>
            <div>
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{standard.title}</p>
              <div className="flex items-center gap-2 mt-1">
                {standard.isAdditional && (
                  <StatusChip tone="brand">
                    Additional
                  </StatusChip>
                )}
                {standard.isCore && (
                  <StatusChip tone="info">
                    Core
                  </StatusChip>
                )}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 justify-end">
            <SaveStatusIndicator
              status={save}
              retryAction={
                <Button
                  type="button"
                  size="sm"
                  variant="flat"
                  color="danger"
                  className="h-6 min-w-0 px-2 text-[11px] font-semibold"
                  onPress={() => onRetrySave(standard.id, form)}
                >
                  Retry
                </Button>
              }
            />
          </div>
        </div>

        {save === 'conflict' ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-5 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100"
          >
            <p>
              Someone else saved a newer version of this standard. Your local draft is preserved in the fields below and has not
              overwritten their changes.
            </p>
            <Button
              type="button"
              size="sm"
              variant="flat"
              color="danger"
              className="mt-3"
              onPress={() => {
                setReconcileError('');
                setReconcileOpen(true);
              }}
            >
              Discard my draft and reload saved version
            </Button>
          </div>
        ) : null}

        <Select
          label="Status"
          selectedKeys={new Set([form.status])}
          onBlur={() => void flushSave(standard.id)}
          onSelectionChange={(keys) => {
            const val = Array.from(keys)[0] as ComplianceStatus;
            if (val) updateField(standard.id, 'status', val);
          }}
          size="sm"
          className="max-w-xs"
          renderValue={(items) => {
            const item = items[0];
            if (!item) return null;
            const status = item.key as ComplianceStatus;
            return (
              <div className="flex items-center gap-2">
                <StatusDot tone={statusTones[status] ?? 'neutral'} />
                <span>{labelForStatus(status, item.textValue)}</span>
              </div>
            );
          }}
        >
          {statusOptions.map((opt) => (
            <SelectItem key={opt.key} textValue={opt.label}>
              <div className="flex items-center gap-2">
                <StatusDot tone={statusTones[opt.key]} />
                {opt.label}
              </div>
            </SelectItem>
          ))}
        </Select>

        <Textarea
          label="Action Taken"
          placeholder="Describe what your organisation has done to address this standard..."
          value={form.actionTaken}
          onValueChange={(val) => updateField(standard.id, 'actionTaken', val)}
          onBlur={() => void flushSave(standard.id)}
          minRows={2}
          maxRows={6}
          size="sm"
        />

        <Textarea
          label="Evidence"
          placeholder="List supporting evidence (e.g. policies, minutes, documents)..."
          value={form.evidence}
          onValueChange={(val) => updateField(standard.id, 'evidence', val)}
          onBlur={() => void flushSave(standard.id)}
          minRows={2}
          maxRows={6}
          size="sm"
        />

        <Textarea
          label="Internal Notes"
          description="Not included in CRA submission"
          placeholder="Any internal notes or reminders for your team..."
          value={form.notes}
          onValueChange={(val) => updateField(standard.id, 'notes', val)}
          onBlur={() => void flushSave(standard.id)}
          minRows={2}
          maxRows={4}
          size="sm"
          classNames={{
            description: 'text-amber-700 dark:text-amber-300 font-medium',
          }}
        />

        {showExplanation && (
          <Textarea
            label={
              form.status === ComplianceStatus.NOT_APPLICABLE
                ? 'Explanation for Not Applicable'
                : 'Explanation for Non-Compliance'
            }
            placeholder="Please explain why this standard does not apply or why your organisation is not compliant..."
            value={form.explanationIfNA}
            onValueChange={(val) => updateField(standard.id, 'explanationIfNA', val)}
            onBlur={() => void flushSave(standard.id)}
            minRows={2}
            maxRows={6}
            size="sm"
            isRequired
            classNames={{
              label: 'text-red-600 dark:text-red-400',
            }}
          />
        )}
      </div>
      <ConfirmActionModal
        isOpen={reconcileOpen}
        onOpenChange={(open) => {
          if (!reconciling) setReconcileOpen(open);
        }}
        ariaLabel="Confirm replacing the local compliance draft"
        title="Reload the saved server version?"
        cancelLabel="Keep my draft"
        confirmLabel="Discard draft and reload"
        confirmColor="danger"
        confirming={reconciling}
        onCancel={() => setReconcileOpen(false)}
        onConfirm={reconcileWithServer}
      >
        <p>
          This will discard your preserved local draft and load the latest saved version. CharityPilot will not retry or overwrite
          the newer server revision.
        </p>
        {reconcileError ? (
          <p role="alert" className="mt-3 text-rose-700 dark:text-rose-300">
            {reconcileError}
          </p>
        ) : null}
      </ConfirmActionModal>
    </Card>
  );
}
