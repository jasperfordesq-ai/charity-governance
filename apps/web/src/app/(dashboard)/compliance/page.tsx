'use client';

import { useEffect, useState, useCallback } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import { Card, Progress, Select, SelectItem, Chip, Button } from '@heroui/react';
import { api } from '@/lib/api';
import Link from 'next/link';
import type {
  GovernancePrincipleResponse,
  ComplianceSummary,
} from '@charitypilot/shared';
import { COMPLIANCE_STATUS_META } from '@charitypilot/shared';

export default function CompliancePage() {
  useDocumentTitle('Compliance');
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(currentYear);
  const [principles, setPrinciples] = useState<GovernancePrincipleResponse[]>([]);
  const [summary, setSummary] = useState<ComplianceSummary | null>(null);
  const [showAdditional, setShowAdditional] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - i);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [principlesRes, summaryRes] = await Promise.all([
        api.get('/compliance/principles'),
        api.get(`/compliance/summary?year=${year}`),
      ]);
      setPrinciples(principlesRes.data?.data ?? principlesRes.data ?? []);
      setSummary(summaryRes.data);
    } catch (err) {
      console.error('Failed to load compliance data', err);
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const getPrincipleSummary = (principleId: string) => {
    return summary?.byPrinciple?.find((p) => p.principleId === principleId);
  };

  const scoreColour = (pct: number): 'success' | 'warning' | 'danger' => {
    if (pct >= 80) return 'success';
    if (pct >= 50) return 'warning';
    return 'danger';
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Compliance Overview</h1>
          <p className="text-sm text-gray-500 mt-1">
            Track your progress against the CRA Charities Governance Code.
          </p>
        </div>

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
      </div>

      {/* Overall summary bar */}
      {summary && (
        <Card className="p-5 border border-gray-200 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex-shrink-0">
              <p className="text-sm text-gray-500">Overall Score</p>
              <p className={`text-3xl font-extrabold ${
                summary.percentComplete >= 80 ? 'text-green-600'
                : summary.percentComplete >= 50 ? 'text-amber-500'
                : 'text-red-500'
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
                Compliant: summary.compliant,
                'Working Towards': summary.workingTowards,
                'Not Started': summary.notStarted,
                'N/A': summary.notApplicable,
                Explain: summary.explain,
              }).map(([label, count]) => (
                <span key={label} className="text-gray-500">
                  {label}: <strong>{count}</strong>
                </span>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* Additional standards toggle */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={showAdditional}
          aria-label="Show additional standards for complex organisations"
          onClick={() => setShowAdditional(!showAdditional)}
          className={`
            relative inline-flex h-6 w-11 items-center rounded-full transition-colors
            ${showAdditional ? 'bg-teal-primary' : 'bg-gray-300'}
          `}
        >
          <span
            className={`
              inline-block h-4 w-4 transform rounded-full bg-white transition-transform
              ${showAdditional ? 'translate-x-6' : 'translate-x-1'}
            `}
          />
        </button>
        <span className="text-sm text-gray-600">
          Show additional standards (complex organisations)
        </span>
      </div>

      {/* Principles */}
      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="p-6 animate-pulse">
              <div className="h-5 bg-gray-200 rounded w-2/3 mb-3" />
              <div className="h-3 bg-gray-200 rounded w-full mb-2" />
              <div className="h-3 bg-gray-200 rounded w-1/2" />
            </Card>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {principles
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((principle) => {
              const pSummary = getPrincipleSummary(principle.id);
              const pct = pSummary?.percentComplete ?? 0;
              const isExpanded = expandedId === principle.id;

              const coreStandards = principle.standards.filter((s) => s.isCore);
              const additionalStandards = principle.standards.filter((s) => s.isAdditional);

              return (
                <Card
                  key={principle.id}
                  className="border border-gray-200 shadow-sm overflow-hidden"
                >
                  {/* Principle header (clickable to expand) */}
                  <button
                    type="button"
                    className="w-full text-left p-5 hover:bg-gray-50 transition-colors"
                    onClick={() => setExpandedId(isExpanded ? null : principle.id)}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-teal-primary/10 text-teal-primary flex items-center justify-center text-sm font-bold">
                          {principle.number}
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-base font-semibold text-gray-900">
                            Principle {principle.number}: {principle.title}
                          </h3>
                          <p className="text-sm text-gray-500 mt-0.5 line-clamp-2">
                            {principle.description}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <div className="text-right">
                          <span className={`text-lg font-bold ${
                            pct >= 80 ? 'text-green-600' : pct >= 50 ? 'text-amber-500' : 'text-gray-400'
                          }`}>
                            {Math.round(pct)}%
                          </span>
                          <span className={`block text-[10px] font-medium ${
                            pct >= 80 ? 'text-green-600' : pct >= 50 ? 'text-amber-500' : 'text-gray-400'
                          }`}>
                            {pct >= 80 ? 'Compliant' : pct >= 50 ? 'Working Towards' : pct > 0 ? 'In Progress' : 'Not Started'}
                          </span>
                        </div>
                        <svg
                          className={`w-5 h-5 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                        </svg>
                      </div>
                    </div>
                    <Progress
                      aria-label={`Principle ${principle.number}`}
                      value={pct}
                      color={scoreColour(pct)}
                      size="sm"
                      className="mt-3"
                    />
                    {pSummary && (
                      <p className="text-xs text-gray-400 mt-2">
                        {pSummary.compliant} / {pSummary.totalApplicable} standards compliant
                      </p>
                    )}
                  </button>

                  {/* Expanded standards list */}
                  {isExpanded && (
                    <div className="border-t border-gray-200 bg-gray-50/50">
                      {/* Core standards */}
                      <div className="px-5 py-3">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                          Core Standards
                        </p>
                        <div className="space-y-2">
                          {coreStandards.map((s) => (
                            <div
                              key={s.id}
                              className="flex items-start gap-3 p-3 bg-white rounded-lg border border-gray-100"
                            >
                              <Chip size="sm" variant="flat" className="flex-shrink-0 mt-0.5 font-mono">
                                {s.code}
                              </Chip>
                              <p className="text-sm text-gray-700 flex-1">{s.title}</p>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Additional standards */}
                      {showAdditional && additionalStandards.length > 0 && (
                        <div className="px-5 py-3 border-t border-gray-100">
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                            Additional Standards (Complex)
                          </p>
                          <div className="space-y-2">
                            {additionalStandards.map((s) => (
                              <div
                                key={s.id}
                                className="flex items-start gap-3 p-3 bg-white rounded-lg border border-gray-100"
                              >
                                <Chip size="sm" variant="flat" color="secondary" className="flex-shrink-0 mt-0.5 font-mono">
                                  {s.code}
                                </Chip>
                                <p className="text-sm text-gray-700 flex-1">{s.title}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Link to detailed editing */}
                      <div className="px-5 py-3 border-t border-gray-100">
                        <Link href={`/compliance/${principle.id}`}>
                          <Button
                            size="sm"
                            className="bg-teal-primary text-white hover:bg-teal-dark"
                          >
                            Edit Compliance Records
                          </Button>
                        </Link>
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
        </div>
      )}
    </div>
  );
}
