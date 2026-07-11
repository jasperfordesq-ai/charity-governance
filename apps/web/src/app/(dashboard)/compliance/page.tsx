'use client';

import { useDocumentTitle } from '@/lib/use-title';
import Link from 'next/link';
import { Card, Progress, Select, SelectItem, Button, Switch } from '@heroui/react';
import { AppPage } from '@/components/ui/app-page';
import { ReviewWarningState } from '@/components/ui/states';
import { statusPanelClassName } from '@/components/ui/status';
import { EvidenceReadiness } from '@/components/governance/evidence-readiness';
import { CompliancePrincipleList } from './compliance-principle-list';
import { IRISH_COMPLIANCE_MATRIX } from '@charitypilot/shared';
import { useAuth } from '@/lib/auth-context';
import { canManageGovernance } from '@/lib/governance-permissions';
import { scoreColour, useComplianceOverviewWorkflow } from './use-compliance-overview-workflow';

export default function CompliancePage() {
  useDocumentTitle('Compliance');
  const { user } = useAuth();
  const canManageRecords = canManageGovernance(user?.role);
  const {
    approvalReadinessBlockerCount,
    approvalReadinessSummaryText,
    expandedId,
    evidencePrompts,
    fetchData,
    loading,
    loadError,
    principles,
    setExpandedId,
    setShowAdditional,
    setYear,
    showAdditional,
    summary,
    year,
    yearOptions,
  } = useComplianceOverviewWorkflow();

  return (
    <AppPage
      eyebrow={`Reporting year ${year}`}
      title="Compliance Overview"
      description="Track Governance Code records, explanation gaps, and evidence prompts for a review-ready trustee workspace. This is workflow support, not legal advice."
      actions={(
        <div className="flex items-center gap-3">
          <Select
            label="Reporting Year"
            selectedKeys={new Set([String(year)])}
            onSelectionChange={(keys) => {
              const val = Array.from(keys)[0];
              if (val) setYear(Number(val));
            }}
            className="w-40"
            size="sm"
          >
            {yearOptions.map((y) => (
              <SelectItem key={String(y)}>{String(y)}</SelectItem>
            ))}
          </Select>
        </div>
      )}
    >

      {approvalReadinessBlockerCount > 0 && (
        <ReviewWarningState
          title="Approval readiness is incomplete"
          description={`${approvalReadinessSummaryText} Resolve these before annual board approval can be saved.`}
          action={(
            <Button as={Link} href="#principles" size="sm" variant="flat">
              Review standards below
            </Button>
          )}
        />
      )}

      <EvidenceReadiness
        title="Evidence-led review prompts"
        description="Use these matrix prompts to decide what evidence trustees should review for this year; applicability still depends on the charity profile and professional judgement where needed."
        prompts={evidencePrompts}
        flags={[
          { label: 'Review-ready, not legal advice', tone: 'needs-review' },
          { label: `${IRISH_COMPLIANCE_MATRIX.length} Irish governance prompts mapped`, tone: 'draft' },
        ]}
      />

      {/* Overall summary bar */}
      {summary && (
        <Card className={statusPanelClassName('neutral', 'p-5 shadow-sm')}>
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex-shrink-0">
              <p className="text-sm text-gray-500 dark:text-gray-400">Overall Score</p>
              <p className={`text-3xl font-extrabold ${
                summary.percentComplete >= 80 ? 'text-green-600 dark:text-green-400'
                : summary.percentComplete >= 50 ? 'text-amber-500 dark:text-amber-300'
                : 'text-red-500 dark:text-red-400'
              }`}>
                {Math.round(summary.percentComplete)}%
              </p>
            </div>
            <Progress
              aria-label="Overall compliance"
              value={summary.percentComplete}
              color={scoreColour(summary.percentComplete)}
              size="md"
              className="flex-1"
            />
            <div className="flex flex-wrap gap-2 text-xs">
              {Object.entries({
                'Recorded compliant': summary.compliant,
                'Working Towards': summary.workingTowards,
                'Not Started': summary.notStarted,
                'N/A': summary.notApplicable,
                Explain: summary.explain,
              }).map(([label, count]) => (
                <span key={label} className="text-gray-500 dark:text-gray-400">
                  {label}: <strong>{count}</strong>
                </span>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* Additional standards toggle */}
      <Switch
        size="sm"
        color="primary"
        isSelected={showAdditional}
        onValueChange={setShowAdditional}
        classNames={{
          label: 'text-sm text-gray-600 dark:text-gray-300',
        }}
      >
        Show additional standards (complex organisations)
      </Switch>

      <CompliancePrincipleList
        canManageRecords={canManageRecords}
        loading={loading}
        loadError={loadError}
        principles={principles}
        summary={summary}
        showAdditional={showAdditional}
        expandedId={expandedId}
        onExpandedIdChange={setExpandedId}
        onRetry={fetchData}
      />
    </AppPage>
  );
}
