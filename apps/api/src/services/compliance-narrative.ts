import type { ComplianceNarrativeWarning } from '@charitypilot/shared';

/**
 * Finds compliance narratives that events have overtaken.
 *
 * Found in live use on 2026-10-14: two trustees signed the code of conduct,
 * the signed declarations were uploaded and linked to the standards, and the
 * report still said nobody had signed, with a target date six weeks gone,
 * because the narrative is free text that nobody had retyped.
 *
 * These are warnings. They never block approval, and they are never part of
 * the hashed approval evidence: a date-dependent value inside that hash would
 * withdraw every approval at midnight.
 */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

// "Target:" then one date, in the forms a trustee writes in Ireland:
// "3 September 2026", "3rd Sept 2026", "2026-09-03" or "03/09/2026"
// (day first). Anything else is left alone rather than guessed at.
const TARGET_PATTERN =
  /\btarget\s*:\s*(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\/(\d{1,2})\/(\d{4})|(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?\s+(\d{4}))/gi;

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/** Every valid "Target:" date in the text, as YYYY-MM-DD, in order of appearance. */
export function targetDatesIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const dates: string[] = [];
  for (const match of text.matchAll(TARGET_PATTERN)) {
    let date: string | null = null;
    if (match[1]) {
      date = isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    } else if (match[4]) {
      date = isoDate(Number(match[6]), Number(match[5]), Number(match[4]));
    } else if (match[7]) {
      const month = MONTHS[match[8]!.toLowerCase()];
      date = month ? isoDate(Number(match[9]), month, Number(match[7])) : null;
    }
    if (date) dates.push(date);
  }
  return dates;
}

/** Today's date in Ireland, as YYYY-MM-DD: a target is a calendar day there. */
export function irishToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export interface NarrativeWarningInput {
  /** In report order. */
  standards: ReadonlyArray<{ id: string; code: string }>;
  records: ReadonlyMap<string, { actionTaken: string | null; updatedAt: Date }>;
  /** Links to CURRENT, not-removed documents only, with when each was made. */
  links: ReadonlyArray<{ standardId: string; documentId: string; linkedAt: Date }>;
  now: Date;
}

export function narrativeWarnings(input: NarrativeWarningInput): ComplianceNarrativeWarning[] {
  const today = irishToday(input.now);
  const warnings: ComplianceNarrativeWarning[] = [];

  for (const standard of input.standards) {
    const record = input.records.get(standard.id);
    // No record means no narrative to be stale; readiness already reports it.
    if (!record) continue;
    const recordUpdatedAt = record.updatedAt.toISOString();

    const later = input.links
      .filter((link) => link.standardId === standard.id && link.linkedAt.getTime() > record.updatedAt.getTime())
      .sort((a, b) => a.linkedAt.getTime() - b.linkedAt.getTime() || a.documentId.localeCompare(b.documentId));
    for (const link of later) {
      warnings.push({
        kind: 'EVIDENCE_LINKED_AFTER_NARRATIVE',
        standardId: standard.id,
        standardCode: standard.code,
        recordUpdatedAt,
        documentId: link.documentId,
        linkedAt: link.linkedAt.toISOString(),
      });
    }

    for (const targetDate of new Set(targetDatesIn(record.actionTaken))) {
      if (targetDate < today) {
        warnings.push({
          kind: 'TARGET_DATE_PASSED',
          standardId: standard.id,
          standardCode: standard.code,
          recordUpdatedAt,
          targetDate,
        });
      }
    }
  }

  return warnings;
}
