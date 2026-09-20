'use client';

/**
 * Approvals waiting for this person.
 *
 * When an AI assistant asks CharityPilot to do something that cannot be
 * undone — remove a trustee, delete a document, void a minute — the API
 * refuses and records an approval. Nothing happens until a person grants it
 * with their password.
 *
 * `charitypilot-mcp approve` does that at a terminal, and that is what keeps
 * the assistant which asked from also granting it: an agent can write to a
 * process's input, but it cannot type at a terminal. A trustee running a
 * desktop AI client has no terminal, and so could approve nothing at all.
 * This page is their way in.
 *
 * Two rules this page must not break:
 *
 * - **The summary is the server's.** It is built by the API from the route it
 *   matched and the record it found, never from anything the assistant sent,
 *   because the whole point is to let a person check the assistant's account
 *   of what it is about to do against CharityPilot's own.
 * - **The password is asked for here, every time.** Granting is a fresh
 *   decision, not something an open session carries.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Input } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { logClientError } from '@/lib/client-logger';
import { useDocumentTitle } from '@/lib/use-title';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { ErrorState, InlineStatus, LoadingState } from '@/components/ui/states';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { statusPanelClassName } from '@/components/ui/status';

interface PendingApproval {
  approvalId: string;
  summary: string;
  method: string;
  routePattern: string;
  resourceId: string | null;
  createdAt: string;
  expiresAt: string;
}

function expiresIn(expiresAt: string, now: number): string {
  const seconds = Math.round((Date.parse(expiresAt) - now) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return 'expired';
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

export default function ApprovalsPage() {
  useDocumentTitle('Approvals');

  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState('');
  const [granted, setGranted] = useState('');
  // Recomputed on a timer so a five-minute window is seen to close rather
  // than sitting at the figure it had when the page loaded.
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const response = await api.get('/auth/approvals');
      setPending((response.data?.data ?? []) as PendingApproval[]);
    } catch (err) {
      logClientError('Failed to load pending approvals', err);
      setLoadError(apiErrorMessage(err, 'Pending approvals could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const startGranting = (approvalId: string) => {
    setOpenId(approvalId);
    setPassword('');
    setGrantError('');
    setGranted('');
  };

  const grant = async (approval: PendingApproval) => {
    setGranting(true);
    setGrantError('');
    try {
      const response = await api.post(
        `/auth/approvals/${encodeURIComponent(approval.approvalId)}/grant`,
        { password },
      );
      setGranted(
        (response.data?.summary as string | null)
          ?? 'The action is approved.',
      );
      setOpenId(null);
      setPassword('');
      setPending((current) =>
        current.filter((row) => row.approvalId !== approval.approvalId));
    } catch (err) {
      // Deliberately not logged with the password anywhere near it, and the
      // API answers every failure identically, so nothing here can say which
      // condition failed.
      setGrantError(apiErrorMessage(err, 'That approval could not be granted.'));
    } finally {
      setGranting(false);
    }
  };

  return (
    <AppPage
      title="Approvals"
      description="Actions an AI assistant has asked for that cannot be undone. Nothing happens until you approve it here, or in your own terminal."
    >
      <AppSection>
        {loading ? <LoadingState title="Loading approvals" /> : null}
        {loadError ? (
          <ErrorState
            title="Approvals could not be loaded"
            description={loadError}
            action={<Button size="sm" variant="flat" onPress={() => void load()}>Try again</Button>}
          />
        ) : null}

        {granted ? (
          <InlineStatus tone="success">
            {`Approved: ${granted}. Ask the assistant to try the action again; the approval covers that one action and nothing else.`}
          </InlineStatus>
        ) : null}

        {!loading && !loadError && pending.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Nothing is waiting for your approval. An assistant that asks for something
            irreversible will appear here, and will stay for five minutes.
          </p>
        ) : null}

        <ul className="flex flex-col gap-4">
          {pending.map((approval) => (
            <li key={approval.approvalId} className={statusPanelClassName('warning', 'p-4')}>
              <p className="text-base font-medium text-slate-900 dark:text-slate-100">
                {approval.summary}
              </p>
              <dl className="mt-2 grid gap-1 text-xs text-slate-600 dark:text-slate-400">
                <div className="flex gap-2">
                  <dt className="font-medium">Action</dt>
                  <dd>{`${approval.method} ${approval.routePattern}`}</dd>
                </div>
                {approval.resourceId ? (
                  <div className="flex gap-2">
                    <dt className="font-medium">Record</dt>
                    <dd>{approval.resourceId}</dd>
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <dt className="font-medium">Expires in</dt>
                  <dd>{expiresIn(approval.expiresAt, now)}</dd>
                </div>
              </dl>

              {openId === approval.approvalId ? (
                <form
                  className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void grant(approval);
                  }}
                >
                  <Input
                    type="password"
                    label="Your password"
                    autoComplete="current-password"
                    value={password}
                    onValueChange={setPassword}
                    isRequired
                    size="sm"
                    className="sm:max-w-xs"
                  />
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      size="sm"
                      className={primaryActionButtonClassName}
                      isLoading={granting}
                      isDisabled={granting || password.length === 0}
                    >
                      Approve this action
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="flat"
                      isDisabled={granting}
                      onPress={() => setOpenId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <Button
                  size="sm"
                  variant="flat"
                  className="mt-3"
                  onPress={() => startGranting(approval.approvalId)}
                >
                  Approve
                </Button>
              )}

              {grantError && openId === approval.approvalId ? (
                <InlineStatus tone="danger">{grantError}</InlineStatus>
              ) : null}
            </li>
          ))}
        </ul>
      </AppSection>
    </AppPage>
  );
}
