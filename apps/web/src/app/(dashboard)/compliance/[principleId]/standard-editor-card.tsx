'use client';

import { Button, Card, Select, SelectItem, Textarea } from '@heroui/react';
import {
  ComplianceStatus,
  type GovernancePrincipleResponse,
} from '@charitypilot/shared';
import { StatusChip, StatusDot, type StatusTone } from '@/components/ui/status';
import { SaveStatusIndicator } from '@/components/ui/states';

export interface StandardFormState {
  status: ComplianceStatus;
  actionTaken: string;
  evidence: string;
  notes: string;
  explanationIfNA: string;
}

export interface SaveState {
  [standardId: string]: 'idle' | 'saving' | 'saved' | 'error';
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
}: {
  standard: ComplianceStandard;
  form: StandardFormState;
  save: SaveState[string];
  updateField: (standardId: string, field: keyof StandardFormState, value: string) => void;
  flushSave: (standardId: string) => void | Promise<void>;
  onRetrySave: (standardId: string, form: StandardFormState) => void;
}) {
  const statusTone = statusTones[form.status] ?? 'neutral';
  const showExplanation =
    form.status === ComplianceStatus.NOT_APPLICABLE ||
    form.status === ComplianceStatus.EXPLAIN;

  return (
    <Card
      key={standard.id}
      className="border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm overflow-hidden"
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
    </Card>
  );
}
