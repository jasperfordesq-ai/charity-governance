export type AuthenticatedReportPopup = {
  closed: boolean;
  opener: unknown;
  location: {
    replace: (url: string) => void;
  };
  close: () => void;
};

export type AuthenticatedReportOpenResult =
  | { status: 'opened' }
  | { status: 'blocked' }
  | { status: 'closed' }
  | { status: 'error'; error: unknown };

export async function openAuthenticatedReport({
  openPopup,
  fetchReport,
  createObjectUrl,
  revokeObjectUrl,
  scheduleRevoke,
}: {
  openPopup: () => AuthenticatedReportPopup | null;
  fetchReport: () => Promise<Blob>;
  createObjectUrl: (report: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  scheduleRevoke: (callback: () => void, delayMs: number) => void;
}): Promise<AuthenticatedReportOpenResult> {
  const popup = openPopup();
  if (!popup) return { status: 'blocked' };

  let objectUrl: string | null = null;
  try {
    // Break the opener relationship synchronously, before the authenticated
    // request yields, so the eventual report tab cannot control the app tab.
    popup.opener = null;
    const report = await fetchReport();
    if (popup.closed) return { status: 'closed' };

    objectUrl = createObjectUrl(report);
    popup.location.replace(objectUrl);
    const openedUrl = objectUrl;
    scheduleRevoke(() => revokeObjectUrl(openedUrl), 60_000);
    return { status: 'opened' };
  } catch (error) {
    if (objectUrl) revokeObjectUrl(objectUrl);
    try {
      popup.close();
    } catch {
      // The failed popup may already have been closed by the browser.
    }
    return { status: 'error', error };
  }
}
