'use client';

import { Card, Chip, Select, SelectItem, Textarea } from '@heroui/react';
import {
  ComplianceStatus,
  COMPLIANCE_STATUS_META,
  type GovernancePrincipleResponse,
} from '@charitypilot/shared';
import { Check, CircleAlert, LoaderCircle } from 'lucide-react';

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
  const meta = COMPLIANCE_STATUS_META[form.status] ?? COMPLIANCE_STATUS_META.NOT_STARTED;
  const showExplanation =
    form.status === ComplianceStatus.NOT_APPLICABLE ||
    form.status === ComplianceStatus.EXPLAIN;

  return (
    <Card
      key={standard.id}
      className="border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm overflow-hidden"
    >
      <div
        className="h-1"
        style={{ backgroundColor: meta.colour }} /* replace meta.colour with a dark-mode-aware token (e.g. meta.colourDark resolved via theme) so the accent does not stay light-tuned in dark mode */
      />
      <div className="p-5 sm:p-6 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <Chip
              size="sm"
              variant="flat"
              className="flex-shrink-0 font-mono font-semibold"
              style={{ backgroundColor: meta.bgColour, color: meta.colour }} /* supply dark-mode-aware bg/text (e.g. meta.bgColourDark/meta.colourDark) so the code chip keeps contrast in dark mode */
            >
              {standard.code}
            </Chip>
            <div>
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{standard.title}</p>
              <div className="flex items-center gap-2 mt-1">
                {standard.isAdditional && (
                  <Chip size="sm" variant="flat" color="secondary" className="text-xs">
                    Additional
                  </Chip>
                )}
                {standard.isCore && (
                  <Chip size="sm" variant="flat" color="primary" className="text-xs">
                    Core
                  </Chip>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0" aria-live="polite">
            {save === 'saving' && (
              <span className="flex items-center gap-1 text-xs text-gray-400 dark:text-gray-400">
                <LoaderCircle className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                Saving...
              </span>
            )}
            {save === 'saved' && (
              <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400 font-medium">
                <Check className="w-3.5 h-3.5" strokeWidth={2.5} aria-hidden="true" />
                Saved
              </span>
            )}
            {save === 'error' && (
              <span className="flex items-center gap-2 text-xs text-red-500 dark:text-red-400 font-medium">
                <CircleAlert className="w-3.5 h-3.5" strokeWidth={2} aria-hidden="true" />
                Save failed
                <button
                  type="button"
                  className="rounded border border-red-200 px-2 py-0.5 text-[11px] font-semibold text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-200 dark:hover:bg-red-950/40"
                  onClick={() => onRetrySave(standard.id, form)}
                >
                  Retry
                </button>
              </span>
            )}
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
            const m = COMPLIANCE_STATUS_META[item.key as ComplianceStatus];
            return (
              <div className="flex items-center gap-2">
                <span
                  className="w-2.5 h-2.5 rounded-full inline-block flex-shrink-0"
                  style={{ backgroundColor: m?.colour }}
                />
                <span>{m?.label ?? item.textValue}</span>
              </div>
            );
          }}
        >
          {statusOptions.map((opt) => (
            <SelectItem key={opt.key} textValue={opt.label}>
              <div className="flex items-center gap-2">
                <span
                  className="w-2.5 h-2.5 rounded-full inline-block"
                  style={{ backgroundColor: COMPLIANCE_STATUS_META[opt.key].colour }}
                />
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
