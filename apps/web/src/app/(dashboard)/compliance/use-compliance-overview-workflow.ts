'use client';

import { useCallback, useEffect, useState } from 'react';
import { IRISH_COMPLIANCE_MATRIX } from '@charitypilot/shared';
import type { ComplianceSummary, GovernancePrincipleResponse } from '@charitypilot/shared';
import { api } from '@/lib/api';
import { logClientError } from '@/lib/client-logger';
import { apiErrorMessage } from '@/lib/errors';

type ApprovalReadiness = {
  ready: boolean;
  missingExplanations: Array<{
    standardId: string;
    standardCode: string;
    status: 'NOT_APPLICABLE' | 'EXPLAIN';
  }>;
};

export function scoreColour(pct: number): 'success' | 'warning' | 'danger' {
  if (pct >= 80) return 'success';
  if (pct >= 50) return 'warning';
  return 'danger';
}

export function useComplianceOverviewWorkflow() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(currentYear);
  const [principles, setPrinciples] = useState<GovernancePrincipleResponse[]>([]);
  const [summary, setSummary] = useState<ComplianceSummary | null>(null);
  const [approvalReadiness, setApprovalReadiness] = useState<ApprovalReadiness | null>(null);
  const [showAdditional, setShowAdditional] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - i);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [principlesRes, summaryRes] = await Promise.all([
        api.get('/compliance/principles'),
        api.get(`/compliance/summary?year=${year}`),
      ]);
      setPrinciples(principlesRes.data?.data ?? principlesRes.data ?? []);
      setSummary(summaryRes.data);

      try {
        const readinessRes = await api.get(`/compliance/approval-readiness?year=${year}`);
        setApprovalReadiness(readinessRes.data);
      } catch (readinessErr) {
        logClientError('Failed to load approval readiness', readinessErr);
        setApprovalReadiness(null);
      }
    } catch (err) {
      const message = apiErrorMessage(err, 'Compliance data could not be loaded. Please try again.');
      logClientError('Failed to load compliance data', err);
      setPrinciples([]);
      setSummary(null);
      setApprovalReadiness(null);
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const missingExplanations = approvalReadiness?.missingExplanations ?? [];
  const evidencePrompts = IRISH_COMPLIANCE_MATRIX
    .filter((entry) => entry.featureArea === 'compliance' || entry.featureArea === 'export' || entry.featureArea === 'deadlines')
    .slice(0, 4)
    .map((entry) => ({
      label: entry.userTask,
      status: 'review' as const,
      note: entry.applicabilityNote,
    }));

  return {
    expandedId,
    evidencePrompts,
    fetchData,
    loading,
    loadError,
    missingExplanations,
    principles,
    setExpandedId,
    setShowAdditional,
    setYear,
    showAdditional,
    summary,
    year,
    yearOptions,
  };
}
