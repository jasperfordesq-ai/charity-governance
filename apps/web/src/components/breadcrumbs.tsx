'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { GOVERNANCE_PRINCIPLES } from '@charitypilot/shared';
import { ChevronRight } from 'lucide-react';

const LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  compliance: 'Compliance',
  documents: 'Documents',
  board: 'Board',
  deadlines: 'Deadlines',
  organisation: 'Organisation',
  billing: 'Billing',
  export: 'Export',
};

const PRINCIPLE_LABELS = Object.fromEntries(
  GOVERNANCE_PRINCIPLES.flatMap((principle) => {
    const label = `Principle ${principle.number}: ${principle.title}`;
    return [
      [`governance-principle-${principle.number}`, label],
      [`principle-${principle.number}`, label],
      [`p${principle.number}`, label],
    ];
  }),
);

function titleCaseSegment(segment: string) {
  return segment.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function labelForSegment(seg: string, previousSegment?: string) {
  if (previousSegment === 'compliance') {
    return PRINCIPLE_LABELS[seg] ?? 'Principle details';
  }
  return LABELS[seg] ?? titleCaseSegment(seg);
}

export function Breadcrumbs() {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);

  if (segments.length <= 1) return null;

  const crumbs = segments.map((seg, i) => {
    const href = '/' + segments.slice(0, i + 1).join('/');
    const label = labelForSegment(seg, segments[i - 1]);
    const isLast = i === segments.length - 1;
    return { href, label, isLast };
  });

  return (
    <nav aria-label="Breadcrumb" className="mb-4">
      <ol className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
        {crumbs.map((crumb, i) => (
          <li key={crumb.href} className="flex items-center gap-1.5">
            {i > 0 && (
              <ChevronRight className="w-3 h-3 text-gray-300 dark:text-gray-600" strokeWidth={2} aria-hidden="true" />
            )}
            {crumb.isLast ? (
              <span aria-current="page" className="text-gray-700 dark:text-gray-300 font-medium">{crumb.label}</span>
            ) : (
              <Link href={crumb.href} className="hover:text-teal-primary dark:hover:text-teal-bright transition-colors">
                {crumb.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
