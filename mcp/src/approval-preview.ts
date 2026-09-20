import type { ApprovalPreview } from './session.js';

export type ApprovalState = 'pending' | 'approved' | 'consumed' | 'expired';

/**
 * What `approve` prints before it asks for a password.
 *
 * The summary is the API's, built from the route it matched and the record it
 * found, never from anything the agent sent. A person reading this is checking
 * the agent's account of what it is about to do against the server's.
 */
export function formatApprovalPreview(preview: ApprovalPreview): string {
  return (
    'You are about to approve:\n'
    + `  ${preview.summary}\n`
    + `  Action: ${preview.method} ${preview.routePattern}\n`
    + `  Record: ${preview.resourceId ?? '(none)'}\n`
    + `  Expires: ${preview.expiresAt}\n`
  );
}

export function approvalState(preview: ApprovalPreview, now: Date): ApprovalState {
  if (preview.consumedAt) return 'consumed';
  if (preview.approvedAt) return 'approved';
  const expires = Date.parse(preview.expiresAt);
  if (Number.isFinite(expires) && expires <= now.getTime()) return 'expired';
  return 'pending';
}

export function explainState(state: Exclude<ApprovalState, 'pending'>): string {
  switch (state) {
    case 'approved':
      return 'This approval is already approved. Ask the assistant to try the action again; nothing more is needed here.';
    case 'consumed':
      return 'This approval has already been used. If the action is wanted again, ask the assistant to attempt it and approve the new identifier it prints.';
    case 'expired':
      return 'This approval has expired. Ask the assistant to attempt the action again and approve the new identifier it prints.';
  }
}
