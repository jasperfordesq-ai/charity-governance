'use client';

import type { ReactNode } from 'react';
import { Button } from '@heroui/react';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { DataList, DataListItems } from '@/components/ui/data-list';
import { EmptyState } from '@/components/ui/states';
import { EvidenceChip, ReviewFlag, StatusChip } from '@/components/ui/status';
import {
  ConflictStatus,
  RegisterStatus,
  type ComplaintRecordResponse,
  type ConflictRecordResponse,
  type FundraisingRecordResponse,
  type RiskRecordResponse,
} from '@charitypilot/shared';
import { riskCategoryLabels, type RegisterType } from './register-record-forms';

const registerStatusLabels = {
  [RegisterStatus.OPEN]: 'Open',
  [RegisterStatus.MONITORING]: 'Monitoring',
  [RegisterStatus.CLOSED]: 'Closed',
};

const conflictStatusLabels = {
  [ConflictStatus.DECLARED]: 'Declared',
  [ConflictStatus.MANAGED]: 'Managed',
  [ConflictStatus.CLOSED]: 'Closed',
};

const niceDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not set';

const compactValue = (value: string | null | undefined, fallback = 'Not recorded') => value?.trim() || fallback;

export function riskScore(risk: RiskRecordResponse) {
  return risk.likelihood * risk.impact;
}

export function RegisterRecordsPanel({
  conflicts,
  risks,
  complaints,
  fundraising,
  onAdd,
  onClose,
  closingRecordId,
  saving,
}: {
  conflicts: ConflictRecordResponse[];
  risks: RiskRecordResponse[];
  complaints: ComplaintRecordResponse[];
  fundraising: FundraisingRecordResponse[];
  onAdd: (type: RegisterType) => void;
  onClose: (type: RegisterType, id: string) => void;
  closingRecordId: string | null;
  saving: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <RegisterSection
        title="Conflicts register"
        description="Declared interests, meeting handling, decisions, and review dates."
        count={conflicts.length}
        actionLabel="Add conflict"
        onAdd={() => onAdd('conflict')}
        emptyTitle="No conflicts recorded"
        emptyDescription="Add declared trustee interests so decisions and minute references stay visible."
      >
        {conflicts.map((item) => (
          <RegisterRow
            key={item.id}
            title={item.trusteeName}
            description={item.matter}
            meta={`Declared ${niceDate(item.dateDeclared)} - Minute ${compactValue(item.minuteReference, 'not linked')}`}
            chips={(
              <>
                <StatusChip tone={item.status === ConflictStatus.CLOSED ? 'success' : 'warning'}>
                  {conflictStatusLabels[item.status]}
                </StatusChip>
                <EvidenceChip status={item.minuteReference ? 'ready' : 'partial'}>
                  {item.minuteReference ? 'Minute linked' : 'Minute pending'}
                </EvidenceChip>
              </>
            )}
            action={item.status !== ConflictStatus.CLOSED ? (
              <Button
                size="sm"
                variant="flat"
                onPress={() => onClose('conflict', item.id)}
                isLoading={closingRecordId === item.id}
                isDisabled={Boolean(closingRecordId) || saving}
              >
                Close
              </Button>
            ) : null}
          />
        ))}
      </RegisterSection>

      <RegisterSection
        title="Risk register"
        description="Board-level risk, score, mitigation, owner, and review evidence."
        count={risks.length}
        actionLabel="Add risk"
        onAdd={() => onAdd('risk')}
        emptyTitle="No risks recorded"
        emptyDescription="Add key risks so mitigation, owner, and review dates are ready for trustee oversight."
      >
        {risks.map((item) => (
          <RegisterRow
            key={item.id}
            title={item.title}
            description={item.mitigation || item.description}
            meta={`Owner ${compactValue(item.owner, 'not assigned')} - Review ${niceDate(item.reviewDate)}`}
            chips={(
              <>
                <StatusChip tone={riskScore(item) >= 12 ? 'danger' : 'warning'}>Score {riskScore(item)}</StatusChip>
                <StatusChip tone="neutral">{riskCategoryLabels[item.category]}</StatusChip>
                <EvidenceChip status={item.boardMinuteReference ? 'ready' : 'review'}>
                  {item.boardMinuteReference ? 'Board minute' : 'Review flag'}
                </EvidenceChip>
              </>
            )}
            action={item.status !== RegisterStatus.CLOSED ? (
              <Button
                size="sm"
                variant="flat"
                onPress={() => onClose('risk', item.id)}
                isLoading={closingRecordId === item.id}
                isDisabled={Boolean(closingRecordId) || saving}
              >
                Close
              </Button>
            ) : null}
          />
        ))}
      </RegisterSection>

      <RegisterSection
        title="Complaints register"
        description="Complaints, action taken, outcomes, and board review references."
        count={complaints.length}
        actionLabel="Add complaint"
        onAdd={() => onAdd('complaint')}
        emptyTitle="No complaints recorded"
        emptyDescription="Record complaints and board review status so improvement actions do not disappear."
      >
        {complaints.map((item) => (
          <RegisterRow
            key={item.id}
            title={item.summary}
            description={item.outcome || item.actionTaken || 'Outcome not recorded yet.'}
            meta={`Received ${niceDate(item.receivedDate)} - Source ${compactValue(item.source, 'not recorded')}`}
            chips={(
              <>
                <StatusChip tone={item.status === RegisterStatus.CLOSED ? 'success' : 'warning'}>
                  {registerStatusLabels[item.status]}
                </StatusChip>
                <EvidenceChip status={item.reviewedByBoard ? 'ready' : 'review'}>
                  {item.reviewedByBoard ? 'Board reviewed' : 'Board review pending'}
                </EvidenceChip>
              </>
            )}
            action={item.status !== RegisterStatus.CLOSED ? (
              <Button
                size="sm"
                variant="flat"
                onPress={() => onClose('complaint', item.id)}
                isLoading={closingRecordId === item.id}
                isDisabled={Boolean(closingRecordId) || saving}
              >
                Close
              </Button>
            ) : null}
          />
        ))}
      </RegisterSection>

      <RegisterSection
        title="Fundraising register"
        description="Public fundraising activities, controls, complaints, and review outcomes."
        count={fundraising.length}
        actionLabel="Add activity"
        onAdd={() => onAdd('fundraising')}
        emptyTitle="No fundraising activities recorded"
        emptyDescription="Add public-facing campaigns, controls, and third-party fundraiser checks where relevant."
      >
        {fundraising.map((item) => (
          <RegisterRow
            key={item.id}
            title={item.name}
            description={item.controls || 'Controls not recorded yet.'}
            meta={`Review outcome: ${compactValue(item.reviewOutcome, 'pending')}`}
            chips={(
              <>
                <StatusChip tone={item.status === RegisterStatus.CLOSED ? 'success' : 'warning'}>
                  {registerStatusLabels[item.status]}
                </StatusChip>
                <StatusChip tone="neutral">{item.activityType}</StatusChip>
                {item.thirdPartyFundraiser ? <ReviewFlag tone="needs-review">Third party</ReviewFlag> : null}
                {item.complaintsReceived ? <ReviewFlag tone="needs-review">Complaint linked</ReviewFlag> : null}
              </>
            )}
            action={item.status !== RegisterStatus.CLOSED ? (
              <Button
                size="sm"
                variant="flat"
                onPress={() => onClose('fundraising', item.id)}
                isLoading={closingRecordId === item.id}
                isDisabled={Boolean(closingRecordId) || saving}
              >
                Close
              </Button>
            ) : null}
          />
        ))}
      </RegisterSection>
    </div>
  );
}

function RegisterSection({
  title,
  description,
  actionLabel,
  onAdd,
  count,
  emptyTitle,
  emptyDescription,
  children,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAdd: () => void;
  count: number;
  emptyTitle: string;
  emptyDescription: string;
  children: ReactNode;
}) {
  return (
    <DataList
      title={(
        <span className="flex flex-wrap items-center gap-2">
          {title}
          <StatusChip tone="neutral">{count}</StatusChip>
        </span>
      )}
      description={description}
      actions={(
        <Button size="sm" className={primaryActionButtonClassName} onPress={onAdd}>
          {actionLabel}
        </Button>
      )}
    >
      {count === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <DataListItems divided={false}>
          <div className="space-y-3 p-3">{children}</div>
        </DataListItems>
      )}
    </DataList>
  );
}

function RegisterRow({
  title,
  description,
  meta,
  chips,
  action,
}: {
  title: ReactNode;
  description: ReactNode;
  meta: ReactNode;
  chips: ReactNode;
  action: ReactNode;
}) {
  return (
    <article className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words text-sm font-semibold text-gray-950 dark:text-gray-50">{title}</h3>
            {chips}
          </div>
          <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">{description}</p>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{meta}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </article>
  );
}
