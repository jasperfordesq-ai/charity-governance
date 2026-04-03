'use client';

import { useEffect, useState, useCallback } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import { Card, Button, Select, SelectItem } from '@heroui/react';
import { api } from '@/lib/api';
import type { ComplianceSummary } from '@charitypilot/shared';
import { GOVERNANCE_PRINCIPLES } from '@charitypilot/shared';

export default function ExportPage() {
  useDocumentTitle('Export Report');
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(currentYear);
  const [summary, setSummary] = useState<ComplianceSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - i);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/compliance/summary?year=${year}`);
      setSummary(res.data);
    } catch (err) {
      console.error('Failed to load compliance summary', err);
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  /* ── Fetch report HTML and open in new tab for print-to-PDF ── */
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await api.get(`/export/compliance-report?year=${year}`, {
        responseType: 'text',
      });
      const html = typeof res.data === 'string' ? res.data : String(res.data);
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      // Clean up after a short delay to allow the new tab to load
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      console.error('Export failed', err);
    } finally {
      setExporting(false);
    }
  };

  const scoreColour = (pct: number) => {
    if (pct >= 80) return 'text-green-600';
    if (pct >= 50) return 'text-amber-500';
    return 'text-red-500';
  };

  const scoreLabel = (pct: number) => {
    if (pct >= 80) return 'Compliant';
    if (pct >= 50) return 'Working Towards';
    if (pct > 0) return 'In Progress';
    return 'Not Started';
  };

  return (
    <div className="space-y-8 max-w-3xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Export Compliance Report</h1>
        <p className="text-sm text-gray-500 mt-1">
          Generate a printable compliance report for your CRA submission. The report opens in a new tab where you can print to PDF.
        </p>
      </div>

      {/* Year selector and export button */}
      <Card className="border border-gray-200 shadow-sm p-6">
        <div className="flex flex-col sm:flex-row sm:items-end gap-4">
          <Select
            label="Reporting Year"
            selectedKeys={new Set([String(year)])}
            onSelectionChange={(keys) => {
              const val = Array.from(keys)[0];
              if (val) setYear(Number(val));
            }}
            className="w-48"
          >
            {yearOptions.map((y) => (
              <SelectItem key={String(y)}>{String(y)}</SelectItem>
            ))}
          </Select>

          <Button
            className="bg-teal-primary text-white hover:bg-teal-dark"
            size="lg"
            onPress={handleExport}
            isLoading={exporting}
          >
            <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Generate Compliance Report
          </Button>
        </div>
      </Card>

      {/* Preview of what will be included */}
      <div>
        <h2 className="text-lg font-semibold text-gray-800 mb-4">Report Preview</h2>
        <p className="text-sm text-gray-500 mb-4">
          The exported report will include the following sections:
        </p>

        {loading ? (
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="p-5 animate-pulse">
                <div className="h-4 bg-gray-200 rounded w-1/3 mb-3" />
                <div className="h-3 bg-gray-200 rounded w-2/3" />
              </Card>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Organisation details section */}
            <Card className="border border-gray-200 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-5 h-5 text-teal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008z" />
                </svg>
                <h3 className="text-sm font-semibold text-gray-800">Organisation Details</h3>
              </div>
              <p className="text-xs text-gray-500">
                Name, RCN, legal form, complexity, charitable purpose, contact details.
              </p>
            </Card>

            {/* Overall compliance score */}
            {summary && (
              <Card className="border border-gray-200 shadow-sm p-5">
                <div className="flex items-center gap-2 mb-2">
                  <svg className="w-5 h-5 text-teal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <h3 className="text-sm font-semibold text-gray-800">Overall Compliance Score</h3>
                </div>
                <div className="flex items-center gap-4">
                  <span className={`text-2xl font-bold ${scoreColour(summary.percentComplete)}`}>
                    {Math.round(summary.percentComplete)}%
                  </span>
                  <div>
                    <span className={`text-xs font-semibold ${scoreColour(summary.percentComplete)}`}>
                      {scoreLabel(summary.percentComplete)}
                    </span>
                    <span className="block text-xs text-gray-500">
                      {summary.compliant} compliant / {summary.totalApplicable} applicable standards
                    </span>
                  </div>
                </div>
              </Card>
            )}

            {/* Per-principle breakdown */}
            <Card className="border border-gray-200 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-3">
                <svg className="w-5 h-5 text-teal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                </svg>
                <h3 className="text-sm font-semibold text-gray-800">Compliance by Principle</h3>
              </div>
              <div className="space-y-2">
                {GOVERNANCE_PRINCIPLES.map((p) => {
                  const pSummary = summary?.byPrinciple?.find(
                    (bp) => bp.principleNumber === p.number,
                  );
                  const pct = pSummary?.percentComplete ?? 0;

                  return (
                    <div
                      key={p.number}
                      className="flex items-center justify-between text-sm py-1.5 border-b border-gray-100 last:border-0"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-mono font-bold text-gray-400 w-4">
                          {p.number}
                        </span>
                        <span className="text-gray-700 truncate">{p.title}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className={`text-xs font-medium ${scoreColour(pct)}`}>
                          {scoreLabel(pct)}
                        </span>
                        <span className={`text-sm font-semibold ${scoreColour(pct)}`}>
                          {Math.round(pct)}%
                        </span>
                        {pSummary && (
                          <span className="text-xs text-gray-400">
                            ({pSummary.compliant}/{pSummary.totalApplicable})
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* Standard details */}
            <Card className="border border-gray-200 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-5 h-5 text-teal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <h3 className="text-sm font-semibold text-gray-800">Detailed Standard Responses</h3>
              </div>
              <p className="text-xs text-gray-500">
                Each standard with its compliance status, action taken, and evidence. Internal notes are excluded from the export.
              </p>
            </Card>

            {/* Board register */}
            <Card className="border border-gray-200 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-5 h-5 text-teal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                </svg>
                <h3 className="text-sm font-semibold text-gray-800">Board Members Register</h3>
              </div>
              <p className="text-xs text-gray-500">
                Active board members with roles, appointment dates, conduct signed status, and induction status.
              </p>
            </Card>

            {/* Document list */}
            <Card className="border border-gray-200 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-5 h-5 text-teal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <h3 className="text-sm font-semibold text-gray-800">Supporting Documents</h3>
              </div>
              <p className="text-xs text-gray-500">
                List of uploaded documents with their categories and linked standards.
              </p>
            </Card>
          </div>
        )}
      </div>

      {/* Additional info */}
      <Card className="border border-amber-200 bg-amber-50/50 p-5">
        <div className="flex items-start gap-3">
          <svg className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          <div>
            <p className="text-sm font-medium text-amber-800">Before exporting</p>
            <p className="text-xs text-amber-700 mt-0.5">
              Make sure all your compliance records are up to date and your organisation profile is complete.
              Internal notes (marked as such in the editor) will not be included in the exported report.
              The report is formatted for printing -- use your browser&apos;s &quot;Print to PDF&quot; option to save a copy.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
