'use client';

/**
 * What a trustee sees about the Confluence copy of one document.
 *
 * DELIBERATELY THIN. Every sentence this renders comes from
 * `describeConfluenceMirror`, which is plain TypeScript in `lib/` and is
 * guarded by a regex test asserting that nothing it can produce ever says
 * "deleted" — because Confluence answers 404 for a page in the site's trash and
 * for one that has been purged alike, and one of those is restorable by the
 * charity in thirty seconds. Copy written inline here would sit outside that
 * guard, so there is none: this component chooses a colour and lays out what
 * the library gave it.
 *
 * The chip is ABSENT, not "Not published", when the mirror could not be read.
 * `loadDocumentMirrors` resolves to an empty map on failure, so a document with
 * no entry renders nothing — "we could not ask" is not "there is no page", and
 * only one of those is safe to tell a trustee.
 */
import { Button } from '@heroui/react';
import { StatusChip, type StatusTone } from '@/components/ui/status';
import { describeConfluenceMirror, type ConfluenceMirror } from '@/lib/integration-status';

const TONES: Record<ReturnType<typeof describeConfluenceMirror>['tone'], StatusTone> = {
  neutral: 'neutral',
  positive: 'success',
  warning: 'warning',
  danger: 'danger',
};

export function ConfluenceMirrorChip({
  mirror,
  isCurrentDocument,
  approvalNeedsReview = false,
  approvalWithdrawnWithCopy = false,
  canManage,
  onRetry,
  retrying,
}: {
  /** Undefined means the mirror could not be read. Renders nothing. */
  mirror: ConfluenceMirror | undefined;
  isCurrentDocument: boolean;
  approvalNeedsReview?: boolean;
  approvalWithdrawnWithCopy?: boolean;
  canManage: boolean;
  onRetry?: () => void | Promise<void>;
  retrying?: boolean;
}) {
  if (mirror === undefined) return null;

  const display = describeConfluenceMirror(mirror, isCurrentDocument, approvalNeedsReview, approvalWithdrawnWithCopy);
  const showRetry = canManage && isCurrentDocument && display.actionable && mirror.publication === 'FAILED' && onRetry;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <StatusChip tone={TONES[display.tone]} ariaLabel={`Confluence: ${display.label}`}>
        {display.label}
      </StatusChip>
      <span className="text-xs leading-5 text-gray-600 dark:text-gray-300">{display.detail}</span>
      {display.historicalReview ? <span className="text-xs font-medium leading-5 text-amber-800 dark:text-amber-300">{display.historicalReview}</span> : null}
      {mirror.pageUrl ? (
        <a
          className="text-xs font-medium text-teal-dark underline dark:text-teal-bright"
          href={mirror.pageUrl}
          // An external site the charity administers. `noopener` because the
          // target document can otherwise reach back through `window.opener`.
          target="_blank"
          rel="noopener noreferrer"
        >
          Open in Confluence
        </a>
      ) : null}
      {showRetry ? (
        <Button size="sm" variant="flat" isDisabled={retrying} onPress={() => void onRetry()}>
          {retrying ? 'Retrying…' : 'Try publishing again'}
        </Button>
      ) : null}
    </div>
  );
}
