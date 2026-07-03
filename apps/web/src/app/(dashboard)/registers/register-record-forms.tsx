'use client';

import { Input, Select, SelectItem, Textarea } from '@heroui/react';
import { FieldGroup } from '@/components/ui/forms';
import { RiskCategory } from '@charitypilot/shared';
import { ToggleRow } from './register-compliance-cards';

export type RegisterType = 'conflict' | 'risk' | 'complaint' | 'fundraising';

export const riskCategoryLabels = {
  [RiskCategory.GOVERNANCE]: 'Governance',
  [RiskCategory.FINANCIAL]: 'Financial',
  [RiskCategory.OPERATIONAL]: 'Operational',
  [RiskCategory.LEGAL]: 'Legal',
  [RiskCategory.SAFEGUARDING]: 'Safeguarding',
  [RiskCategory.REPUTATIONAL]: 'Reputational',
  [RiskCategory.FUNDRAISING]: 'Fundraising',
  [RiskCategory.DATA_PROTECTION]: 'Data protection',
  [RiskCategory.OTHER]: 'Other',
};

type FormProps = {
  form: Record<string, string | number | boolean>;
  updateForm: (key: string, value: string | number | boolean) => void;
};

export function modalTitle(type: RegisterType) {
  return {
    conflict: 'Add conflict',
    risk: 'Add risk',
    complaint: 'Add complaint',
    fundraising: 'Add fundraising activity',
  }[type];
}

export function ConflictForm({ form, updateForm }: FormProps) {
  return (
    <FieldGroup title="Conflict record" description="Record the declared interest, handling steps, and the board evidence trail.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Trustee / connected person" value={String(form.trusteeName ?? '')} onValueChange={(value) => updateForm('trusteeName', value)} isRequired />
        <Input label="Matter" value={String(form.matter ?? '')} onValueChange={(value) => updateForm('matter', value)} isRequired />
        <Input type="date" label="Date declared" value={String(form.dateDeclared ?? '')} onValueChange={(value) => updateForm('dateDeclared', value)} />
        <Input type="date" label="Meeting date" value={String(form.meetingDate ?? '')} onValueChange={(value) => updateForm('meetingDate', value)} />
      </div>
      <Textarea label="Nature of conflict" value={String(form.nature ?? '')} onValueChange={(value) => updateForm('nature', value)} isRequired />
      <Textarea label="Action taken" value={String(form.actionTaken ?? '')} onValueChange={(value) => updateForm('actionTaken', value)} isRequired />
      <Input label="Decision" value={String(form.decision ?? '')} onValueChange={(value) => updateForm('decision', value)} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Minute reference" value={String(form.minuteReference ?? '')} onValueChange={(value) => updateForm('minuteReference', value)} />
        <Input type="date" label="Next review date" value={String(form.nextReviewDate ?? '')} onValueChange={(value) => updateForm('nextReviewDate', value)} />
      </div>
    </FieldGroup>
  );
}

export function RiskForm({ form, updateForm }: FormProps) {
  return (
    <FieldGroup title="Risk record" description="Score likelihood and impact from 1 to 5, then record mitigation and owner.">
      <Input label="Risk title" value={String(form.title ?? '')} onValueChange={(value) => updateForm('title', value)} isRequired />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Select label="Category" selectedKeys={new Set([String(form.category ?? RiskCategory.GOVERNANCE)])} onSelectionChange={(keys) => {
          const value = Array.from(keys)[0] as string | undefined;
          if (value) updateForm('category', value);
        }}>
          {Object.entries(riskCategoryLabels).map(([value, label]) => <SelectItem key={value}>{label}</SelectItem>)}
        </Select>
        <Input type="number" min={1} max={5} label="Likelihood" value={String(form.likelihood ?? 3)} onValueChange={(value) => updateForm('likelihood', Number(value || 1))} />
        <Input type="number" min={1} max={5} label="Impact" value={String(form.impact ?? 3)} onValueChange={(value) => updateForm('impact', Number(value || 1))} />
      </div>
      <Textarea label="Description" value={String(form.description ?? '')} onValueChange={(value) => updateForm('description', value)} isRequired />
      <Textarea label="Mitigation / controls" value={String(form.mitigation ?? '')} onValueChange={(value) => updateForm('mitigation', value)} isRequired />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Owner" value={String(form.owner ?? '')} onValueChange={(value) => updateForm('owner', value)} />
        <Input type="date" label="Review date" value={String(form.reviewDate ?? '')} onValueChange={(value) => updateForm('reviewDate', value)} />
        <Input label="Board minute reference" value={String(form.boardMinuteReference ?? '')} onValueChange={(value) => updateForm('boardMinuteReference', value)} />
      </div>
    </FieldGroup>
  );
}

export function ComplaintForm({ form, updateForm }: FormProps) {
  return (
    <FieldGroup title="Complaint record" description="Keep the complaint, action, outcome, and board review evidence together.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input type="date" label="Received date" value={String(form.receivedDate ?? '')} onValueChange={(value) => updateForm('receivedDate', value)} />
        <Input label="Source" value={String(form.source ?? '')} onValueChange={(value) => updateForm('source', value)} />
      </div>
      <Textarea label="Summary" value={String(form.summary ?? '')} onValueChange={(value) => updateForm('summary', value)} isRequired />
      <Textarea label="Action taken" value={String(form.actionTaken ?? '')} onValueChange={(value) => updateForm('actionTaken', value)} />
      <Textarea label="Outcome" value={String(form.outcome ?? '')} onValueChange={(value) => updateForm('outcome', value)} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ToggleRow label="Reviewed by board" checked={Boolean(form.reviewedByBoard)} onChange={(checked) => updateForm('reviewedByBoard', checked)} />
        <Input label="Board minute reference" value={String(form.boardMinuteReference ?? '')} onValueChange={(value) => updateForm('boardMinuteReference', value)} />
      </div>
    </FieldGroup>
  );
}

export function FundraisingForm({ form, updateForm }: FormProps) {
  return (
    <FieldGroup title="Fundraising activity" description="Record public-facing controls, third parties, complaints, and review outcomes.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Activity name" value={String(form.name ?? '')} onValueChange={(value) => updateForm('name', value)} isRequired />
        <Input label="Activity type" value={String(form.activityType ?? '')} onValueChange={(value) => updateForm('activityType', value)} isRequired />
        <Input type="date" label="Start date" value={String(form.startDate ?? '')} onValueChange={(value) => updateForm('startDate', value)} />
        <Input type="date" label="End date" value={String(form.endDate ?? '')} onValueChange={(value) => updateForm('endDate', value)} />
      </div>
      <Input label="Third-party fundraiser" value={String(form.thirdPartyFundraiser ?? '')} onValueChange={(value) => updateForm('thirdPartyFundraiser', value)} />
      <Textarea label="Controls" value={String(form.controls ?? '')} onValueChange={(value) => updateForm('controls', value)} />
      <Textarea label="Review outcome" value={String(form.reviewOutcome ?? '')} onValueChange={(value) => updateForm('reviewOutcome', value)} />
      <Input label="Board minute reference" value={String(form.boardMinuteReference ?? '')} onValueChange={(value) => updateForm('boardMinuteReference', value)} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ToggleRow label="Public-facing activity" checked={Boolean(form.publicFacing)} onChange={(checked) => updateForm('publicFacing', checked)} />
        <ToggleRow label="Complaints received" checked={Boolean(form.complaintsReceived)} onChange={(checked) => updateForm('complaintsReceived', checked)} />
      </div>
    </FieldGroup>
  );
}

export function normalizeRegisterForm(form: Record<string, string | number | boolean>) {
  return Object.fromEntries(
    Object.entries(form).map(([key, value]) => [key, typeof value === 'string' && value.trim() === '' ? null : value]),
  );
}
