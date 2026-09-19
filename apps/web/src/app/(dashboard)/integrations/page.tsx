'use client';

/**
 * The connect and disconnect screen for Confluence.
 *
 * This is the page that finally makes Phase 5's exit criterion 5 true: the
 * disclosure `GET /confluence/authorize` returns beside `authorizationUrl`
 * has existed since Phase 5, and until this page nothing ever displayed it.
 * All of the logic that matters is in `@/lib/integration-status` — this
 * component stays thin on purpose, so that logic can be (and is) tested
 * without rendering anything. See that module's doc for the two rules this
 * page must never break:
 *
 * - The authorize link is only ever rendered from `buildConnectView`'s
 *   return value, never from the raw API response, so it cannot appear on
 *   screen without the disclosure next to it.
 * - The disconnect confirmation renders `CONFLUENCE_DISCONNECT_COPY`
 *   verbatim, and nothing on this page may claim CharityPilot revoked
 *   anything at Atlassian.
 * - **Connected is not publishing.** Whether documents are actually being
 *   published comes from `describeConfluencePublishing`, never from the
 *   connection status: an organisation that connected but has not chosen a
 *   space is publishing nothing, and this page says so rather than leaving a
 *   charity to infer from a green "Connected" chip that it is mirroring.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Select, SelectItem } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { logClientError } from '@/lib/client-logger';
import { useDocumentTitle } from '@/lib/use-title';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { ConfirmActionModal } from '@/components/ui/confirm-action-modal';
import { ErrorState, InlineStatus, LoadingState } from '@/components/ui/states';
import { StatusChip, statusPanelClassName } from '@/components/ui/status';
import {
  buildConnectView,
  describeConfluencePublishing,
  describeConfluenceStatus,
  parseConfluenceSpaces,
  spaceLabel,
  CONFLUENCE_ALPHA_BADGE_LABEL,
  CONFLUENCE_DISCONNECT_COPY,
  type ConfluenceSpace,
  type ConfluenceStatusResponse,
  type ConnectView,
} from '@/lib/integration-status';
import { ExternalLink } from 'lucide-react';

const EMPTY_STATUS: ConfluenceStatusResponse = {
  provider: 'CONFLUENCE',
  status: 'NOT_CONNECTED',
  siteUrl: null,
  siteName: null,
  siteCount: null,
  connectedAt: null,
  lastError: null,
  publishSpace: null,
  publishing: false,
};

function formatConnectedAt(value: string | null): string | null {
  if (!value) return null;
  try {
    return new Date(value).toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return null;
  }
}

export default function IntegrationsPage() {
  useDocumentTitle('Integrations');

  const [status, setStatus] = useState<ConfluenceStatusResponse>(EMPTY_STATUS);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Populated only by buildConnectView — never assigned the raw authorize
  // response — so the authorize link can never reach the screen without a
  // disclosure alongside it.
  const [connectView, setConnectView] = useState<ConnectView | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // The spaces this charity could publish into, loaded on demand from the API
  // rather than typed in: an id that was never listed is refused by the API
  // anyway, and offering a free-text box would invite exactly that.
  const [spaces, setSpaces] = useState<ConfluenceSpace[]>([]);
  const [spacesLoading, setSpacesLoading] = useState(false);
  const [spacesError, setSpacesError] = useState<string | null>(null);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [savingSpace, setSavingSpace] = useState(false);
  const [spaceError, setSpaceError] = useState<string | null>(null);

  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<ConfluenceStatusResponse>('/integrations/confluence/status');
      setStatus(res.data);
      setStatusError(null);
    } catch (err) {
      logClientError('Failed to load Confluence connection status', err);
      setStatusError(apiErrorMessage(err, 'The Confluence connection status could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const startConnect = useCallback(async () => {
    setConnectLoading(true);
    setConnectError(null);
    setConnectView(null);
    try {
      const res = await api.get('/integrations/confluence/authorize');
      // buildConnectView throws on a missing or incomplete disclosure — the
      // catch below turns that into an error message, never a partial view.
      setConnectView(buildConnectView(res.data));
    } catch (err) {
      logClientError('Failed to prepare the Confluence connection', err);
      setConnectError(
        apiErrorMessage(err, 'The Confluence connection could not be started. Please try again.'),
      );
    } finally {
      setConnectLoading(false);
    }
  }, []);

  const loadSpaces = useCallback(async () => {
    setSpacesLoading(true);
    setSpacesError(null);
    try {
      const res = await api.get('/integrations/confluence/spaces');
      setSpaces(parseConfluenceSpaces(res.data));
    } catch (err) {
      logClientError('Failed to load the Confluence spaces', err);
      setSpacesError(apiErrorMessage(err, 'The list of Confluence spaces could not be loaded.'));
    } finally {
      setSpacesLoading(false);
    }
  }, []);

  const savePublishSpace = useCallback(async () => {
    if (!selectedSpaceId) return;
    setSavingSpace(true);
    setSpaceError(null);
    try {
      await api.put('/integrations/confluence/publish-space', { spaceId: selectedSpaceId });
      // Re-read rather than trusting the local guess: the status response is
      // the one place that decides whether this organisation is publishing.
      await fetchStatus();
    } catch (err) {
      logClientError('Failed to choose the Confluence publish space', err);
      setSpaceError(apiErrorMessage(err, 'That space could not be saved. Please try again.'));
    } finally {
      setSavingSpace(false);
    }
  }, [fetchStatus, selectedSpaceId]);

  const cancelConnect = useCallback(() => {
    setConnectView(null);
    setConnectError(null);
  }, []);

  const confirmDisconnect = useCallback(async () => {
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      await api.delete('/integrations/confluence');
      setDisconnectOpen(false);
      await fetchStatus();
    } catch (err) {
      logClientError('Failed to disconnect Confluence', err);
      setDisconnectError(apiErrorMessage(err, 'Confluence could not be disconnected. Please try again.'));
    } finally {
      setDisconnecting(false);
    }
  }, [fetchStatus]);

  const display = describeConfluenceStatus(status);
  const publishing = describeConfluencePublishing(status);
  const connectedAt = formatConnectedAt(status.connectedAt);

  return (
    <AppPage
      eyebrow="Integrations"
      title="Confluence"
      description="Connect this organisation's Confluence site so governance documents can be published there. This integration is alpha — read the limits below before you connect."
      actions={
        <StatusChip tone="warning" ariaLabel={`Confluence is a ${CONFLUENCE_ALPHA_BADGE_LABEL.toLowerCase()} feature`}>
          {CONFLUENCE_ALPHA_BADGE_LABEL}
        </StatusChip>
      }
    >
      {statusError ? (
        <ErrorState
          title="Connection status could not be loaded"
          description={statusError}
          action={
            <Button size="sm" variant="flat" onPress={fetchStatus}>
              Retry
            </Button>
          }
        />
      ) : null}

      {loading ? (
        <LoadingState
          title="Loading Confluence connection"
          description="Checking whether this organisation is connected to Confluence."
        />
      ) : (
        <AppSection title="Confluence connection">
          <div className={statusPanelClassName(display.tone, 'p-5 shadow-sm')}>
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone={display.tone}>{display.label}</StatusChip>
              {status.siteName ? (
                <span className="text-sm font-medium text-gray-800 dark:text-gray-100">{status.siteName}</span>
              ) : null}
            </div>

            {status.siteUrl ? (
              <p className="mt-2 max-w-xl break-all text-sm text-gray-600 dark:text-gray-300">{status.siteUrl}</p>
            ) : null}

            {connectedAt ? (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Connected {connectedAt}</p>
            ) : null}

            {status.lastError ? (
              <p className="mt-2 text-sm text-rose-700 dark:text-rose-300">{status.lastError}</p>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              {display.showConnect ? (
                <Button color="primary" radius="lg" onPress={startConnect} isLoading={connectLoading}>
                  Connect Confluence
                </Button>
              ) : null}
              {display.showDisconnect ? (
                <Button
                  color="danger"
                  variant="flat"
                  radius="lg"
                  onPress={() => {
                    setDisconnectError(null);
                    setDisconnectOpen(true);
                  }}
                >
                  Disconnect
                </Button>
              ) : null}
            </div>
          </div>
        </AppSection>
      )}

      {loading ? null : (
        <AppSection title="Where documents are published">
          <div className={statusPanelClassName(publishing.tone, 'p-5 shadow-sm')}>
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone={publishing.tone}>{publishing.label}</StatusChip>
            </div>

            <p className="mt-2 max-w-2xl text-sm font-medium text-gray-900 dark:text-gray-100">
              {publishing.headline}
            </p>
            {publishing.detail ? (
              <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-700 dark:text-gray-300">{publishing.detail}</p>
            ) : null}

            {publishing.showSpacePicker ? (
              <div className="mt-4 space-y-3">
                {spaces.length === 0 ? (
                  <Button
                    color={publishing.publishing ? 'default' : 'primary'}
                    variant={publishing.publishing ? 'flat' : 'solid'}
                    radius="lg"
                    onPress={loadSpaces}
                    isLoading={spacesLoading}
                  >
                    {publishing.publishing ? 'Change the space' : 'Choose a space'}
                  </Button>
                ) : (
                  <div className="flex flex-wrap items-end gap-2">
                    <Select
                      className="max-w-sm"
                      label="Confluence space"
                      selectedKeys={selectedSpaceId ? new Set([selectedSpaceId]) : new Set<string>()}
                      onSelectionChange={(keys) => {
                        const value = Array.from(keys)[0] as string | undefined;
                        setSelectedSpaceId(value ?? null);
                      }}
                    >
                      {spaces.map((space) => (
                        <SelectItem key={space.id}>{spaceLabel(space)}</SelectItem>
                      ))}
                    </Select>
                    <Button
                      color="primary"
                      radius="lg"
                      isDisabled={!selectedSpaceId}
                      isLoading={savingSpace}
                      onPress={savePublishSpace}
                    >
                      Publish into this space
                    </Button>
                  </div>
                )}

                {spacesError ? <InlineStatus tone="danger">{spacesError}</InlineStatus> : null}
                {spaceError ? <InlineStatus tone="danger">{spaceError}</InlineStatus> : null}
              </div>
            ) : null}
          </div>
        </AppSection>
      )}

      {connectError ? <InlineStatus tone="danger">{connectError}</InlineStatus> : null}

      {connectView ? (
        <AppSection title="Before you connect">
          <div className={statusPanelClassName('warning', 'p-5 shadow-sm')}>
            <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">{connectView.headline}</p>

            <h3 className="mt-4 text-sm font-semibold text-gray-950 dark:text-gray-50">
              What erasure can and cannot promise
            </h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-6 text-gray-700 dark:text-gray-300">
              {connectView.erasurePoints.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>

            <h3 className="mt-4 text-sm font-semibold text-gray-950 dark:text-gray-50">
              What disconnecting can and cannot promise
            </h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-6 text-gray-700 dark:text-gray-300">
              {connectView.disconnectingPoints.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>

            {connectView.reference ? (
              <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{connectView.reference}</p>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                as="a"
                href={connectView.authorizationUrl}
                color="primary"
                radius="lg"
                endContent={<ExternalLink className="h-4 w-4" aria-hidden="true" />}
              >
                I understand — continue to Atlassian
              </Button>
              <Button variant="flat" radius="lg" onPress={cancelConnect}>
                Not now
              </Button>
            </div>
          </div>
        </AppSection>
      ) : null}

      <ConfirmActionModal
        isOpen={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        ariaLabel="Confirm disconnecting Confluence"
        title="Disconnect Confluence?"
        confirmLabel="Disconnect"
        confirmColor="danger"
        confirming={disconnecting}
        onCancel={() => setDisconnectError(null)}
        onConfirm={confirmDisconnect}
      >
        <p>{CONFLUENCE_DISCONNECT_COPY}</p>
        {disconnectError ? (
          <p className="mt-3 font-medium text-rose-700 dark:text-rose-300">{disconnectError}</p>
        ) : null}
      </ConfirmActionModal>
    </AppPage>
  );
}
