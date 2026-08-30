'use client';

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';

/**
 * Reissue the one-time invitation link for a pending invite.
 *
 * On the personal-server profile the link is never emailed: it is shown once
 * when the invite is created and the token is stored hashed, so an operator who
 * navigates away cannot read it back. Reissuing mints a replacement and
 * invalidates the previous link, which is why the server audits it.
 *
 * Failure is reported locally rather than through the page-level banner so the
 * message appears beside the button that caused it.
 */
export function useInviteLinkReissue(
  setManualInviteUrl: Dispatch<SetStateAction<string | null>>,
) {
  const [reissuingInviteId, setReissuingInviteId] = useState<string | null>(null);
  const [reissueError, setReissueError] = useState<string | null>(null);

  const reissueInviteLink = useCallback(
    async (inviteId: string) => {
      setReissueError(null);
      setManualInviteUrl(null);
      setReissuingInviteId(inviteId);

      try {
        const { data } = await api.post<{ manualInviteUrl?: string }>(
          `/team/invites/${inviteId}/link`,
        );
        const inviteUrl = typeof data.manualInviteUrl === 'string' ? data.manualInviteUrl : null;
        setManualInviteUrl(inviteUrl);
        if (!inviteUrl) {
          setReissueError('No link was issued for this invitation.');
        }
      } catch (err: unknown) {
        setReissueError(apiErrorMessage(err, 'The invitation link could not be reissued.'));
      } finally {
        setReissuingInviteId(null);
      }
    },
    [setManualInviteUrl],
  );

  return { reissueInviteLink, reissuingInviteId, reissueError };
}
