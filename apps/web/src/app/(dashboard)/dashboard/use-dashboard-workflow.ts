'use client';

import { logClientError } from '@/lib/client-logger';
import { isPlanFeatureUnavailable, isSubscriptionLapseError } from '@/lib/plan-feature';
import { api } from '@/lib/api';
import { approvalReadinessSummary, countApprovalReadinessBlockers } from '@/lib/approval-readiness';
import { listCurrentDeadlines } from '@/lib/deadline-api';
import { useAuth } from '@/lib/auth-context';
import { useCallback, useEffect, useState } from 'react';
import type {
  BoardAlert,
  BoardMemberResponse,
  ComplianceApprovalReadinessResponse,
  ComplianceSignoffResponse,
  ComplianceSummary,
  DeadlineResponse,
  GovernanceRegistersSummary,
} from '@charitypilot/shared';

type ApprovalReadiness = ComplianceApprovalReadinessResponse;

export function useDashboardWorkflow() {
  const { user } = useAuth();
  const [compliance, setCompliance] = useState<ComplianceSummary | null>(null);
  const [deadlines, setDeadlines] = useState<DeadlineResponse[] | null>(null);
  const [boardAlerts, setBoardAlerts] = useState<BoardAlert[] | null>(null);
  const [signoff, setSignoff] = useState<ComplianceSignoffResponse | null>(null);
  const [approvalReadiness, setApprovalReadiness] = useState<ApprovalReadiness | null>(null);
  const [registerSummary, setRegisterSummary] = useState<GovernanceRegistersSummary | null>(null);
  const [boardMemberCount, setBoardMemberCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [subscriptionLapsed, setSubscriptionLapsed] = useState(false);

  const currentYear = new Date().getFullYear();

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    setError(false);
    setSubscriptionLapsed(false);
    try {
      const [summaryRes, currentDeadlines, boardRes, signoffRes] = await Promise.all([
        api.get(`/compliance/summary?year=${currentYear}`),
        listCurrentDeadlines(),
        api.get('/board-members'),
        api.get(`/compliance/signoff?year=${currentYear}`),
      ]);

      setCompliance(summaryRes.data);
      setDeadlines(currentDeadlines);
      setSignoff(signoffRes.data);

      try {
        const readinessRes = await api.get(`/compliance/approval-readiness?year=${currentYear}`);
        setApprovalReadiness(readinessRes.data);
      } catch (readinessErr) {
        logClientError('Failed to load approval readiness', readinessErr);
        setApprovalReadiness(null);
      }

      const members: BoardMemberResponse[] = boardRes.data?.data ?? boardRes.data ?? [];
      setBoardMemberCount(members.length);
      const alerts: BoardAlert[] = [];
      const now = new Date();

      for (const member of members) {
        if (!member.isActive) continue;
        if (!member.conductSigned) {
          alerts.push({
            boardMemberId: member.id,
            memberName: member.name,
            type: 'conduct_unsigned',
            message: `${member.name} has not signed the code of conduct`,
          });
        }
        if (!member.inductionCompleted) {
          alerts.push({
            boardMemberId: member.id,
            memberName: member.name,
            type: 'induction_pending',
            message: `${member.name} has not completed induction`,
          });
        }
        if (member.appointedDate) {
          const appointed = new Date(member.appointedDate);
          const yearsServed = (now.getTime() - appointed.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
          if (yearsServed >= 8) {
            alerts.push({
              boardMemberId: member.id,
              memberName: member.name,
              type: 'term_expiring',
              message: `${member.name} is approaching the 9-year term limit (${Math.floor(yearsServed)} years served)`,
            });
          }
        }
      }

      setBoardAlerts(alerts);

      try {
        const registerRes = await api.get(`/governance-registers/summary?year=${currentYear}`);
        setRegisterSummary(registerRes.data);
      } catch (registerErr) {
        if (!isPlanFeatureUnavailable(registerErr)) {
          logClientError('Failed to load governance register summary', registerErr);
        }
        setRegisterSummary(null);
      }
    } catch (err) {
      if (isSubscriptionLapseError(err)) {
        setSubscriptionLapsed(true);
      } else {
        logClientError('Failed to load dashboard data', err);
        setError(true);
      }
    } finally {
      setLoading(false);
    }
  }, [currentYear]);

  useEffect(() => {
    void fetchDashboard();
  }, [fetchDashboard]);

  const approvalReadinessBlockerCount = countApprovalReadinessBlockers(approvalReadiness);
  const approvalReadinessSummaryText = approvalReadinessSummary(approvalReadiness);

  return {
    approvalReadinessBlockerCount,
    approvalReadinessSummaryText,
    boardAlerts,
    boardMemberCount,
    compliance,
    currentYear,
    deadlines,
    error,
    fetchDashboard,
    loading,
    registerSummary,
    signoff,
    subscriptionLapsed,
    user,
  };
}
