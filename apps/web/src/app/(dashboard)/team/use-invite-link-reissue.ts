'use client';

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';

type NullableMessageSetter = Dispatch<SetStateAction<string | null>>;

/**
 * Reissue the one-time invitation link for a pending invite.
 *
 * On the personal-server profile the link is never emailed: it is shown once
 * when the invite is created and the token is stored hashed, so an operator who
 * navigates away cannot read it back. Reissuing mints a replacement and
 * invalidates the previous link, which is why the server audits it.
 */
export function useInviteLinkReissue({
  setManualInviteUrl,
  setMessage,
  setError,
}: {
  setManualInviteUrl: NullableMessageSetter;
  setMessage: NullableMessageSetter;
  setError: NullableMessageSetter;
}) {
  const [reissuingInviteId, setReissuingInviteId] = useState<string | null>(null);

  const reissueInviteLink = useCallback(
    async (inviteId: string) => {
      setError(null);
      setMessage(null);
      setManualInviteUrl(null);
      setReissuingInviteId(inviteId);

      try {
        const { data } = await api.post<{ manualInviteUrl?: string }>(
          `/team/invites/${inviteId}/link`,
        );
        const inviteUrl = typeof data.manualInviteUrl === 'string' ? data.manualInviteUrl : null;
        setManualInviteUrl(inviteUrl);
        setMessage(
          inviteUrl
            ? 'New link created. Copy it now — the previous link no longer works.'
            : 'No link was issued for this invitation.',
        );
      } catch (err: unknown) {
        setError(apiErrorMessage(err, 'The invitation link could not be reissued.'));
      } finally {
        setReissuingInviteId(null);
      }
    },
    [setError, setManualInviteUrl, setMessage],
  );

  return { reissueInviteLink, reissuingInviteId };
}
