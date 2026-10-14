import type { ComplianceNarrativeWarning } from '../types/api.js';

/**
 * One stale-narrative warning per standard and kind, worded for the board.
 *
 * The API returns one raw warning per linked document and per passed target,
 * which is the detail a connector or audit needs. A board reading the report
 * or the sign-off screen needs one line per standard: "3 documents linked
 * since this record was last edited (latest 11 Oct 2026)". A passed target is
 * a separate line on the same standard. Shared so the report and the web
 * screen can never word or group them differently. Still a warning, never a
 * blocker.
 */
export interface GroupedNarrativeWarning {
  key: string;
  kind: ComplianceNarrativeWarning['kind'];
  standardId: string;
  standardCode: string;
  recordUpdatedAt: string;
  /** EVIDENCE_LINKED_AFTER_NARRATIVE: the distinct documents, oldest link first. */
  documentIds: string[];
  latestLinkedAt: string | null;
  /** TARGET_DATE_PASSED: the passed dates, YYYY-MM-DD, earliest first. */
  targetDates: string[];
  /** The board-facing sentence, without the standard code. */
  message: string;
}

/** "11 Oct 2026": unambiguous whichever way round the reader writes dates. */
export function narrativeWarningDate(value: string): string {
  return new Date(value).toLocaleDateString('en-IE', {
    timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric',
  });
}

function listDates(dates: string[]): string {
  const shown = dates.map(narrativeWarningDate);
  return shown.length <= 1 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

export function groupNarrativeWarnings(
  warnings: readonly ComplianceNarrativeWarning[] | null | undefined,
): GroupedNarrativeWarning[] {
  const groups = new Map<string, GroupedNarrativeWarning>();
  for (const warning of warnings ?? []) {
    const key = `${warning.standardId}|${warning.kind}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key, kind: warning.kind, standardId: warning.standardId, standardCode: warning.standardCode,
        recordUpdatedAt: warning.recordUpdatedAt, documentIds: [], latestLinkedAt: null, targetDates: [], message: '',
      };
      groups.set(key, group);
    }
    if (warning.kind === 'EVIDENCE_LINKED_AFTER_NARRATIVE') {
      if (!group.documentIds.includes(warning.documentId)) group.documentIds.push(warning.documentId);
      if (!group.latestLinkedAt || warning.linkedAt > group.latestLinkedAt) group.latestLinkedAt = warning.linkedAt;
    } else if (!group.targetDates.includes(warning.targetDate)) {
      group.targetDates.push(warning.targetDate);
    }
  }

  // The order a standard first appears in is the report's own order; within
  // one standard the linked-evidence line comes before the target line.
  const ordered = [...groups.values()];
  const firstSeen = [...new Set((warnings ?? []).map((warning) => warning.standardId))];
  ordered.sort((a, b) => firstSeen.indexOf(a.standardId) - firstSeen.indexOf(b.standardId)
    || (a.kind === b.kind ? 0 : a.kind === 'EVIDENCE_LINKED_AFTER_NARRATIVE' ? -1 : 1));

  for (const group of ordered) {
    if (group.kind === 'EVIDENCE_LINKED_AFTER_NARRATIVE') {
      const count = group.documentIds.length;
      group.message = `${count} document${count === 1 ? '' : 's'} linked since this record was last edited`
        + ` (latest ${narrativeWarningDate(group.latestLinkedAt!)})`;
    } else {
      group.targetDates.sort();
      const plural = group.targetDates.length > 1;
      group.message = `Target date${plural ? 's' : ''} ${listDates(group.targetDates)} ${plural ? 'have' : 'has'} passed`;
    }
  }
  return ordered;
}
