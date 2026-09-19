/**
 * The logic behind `(dashboard)/integrations/page.tsx` — the connect and
 * disconnect screen for Confluence.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE DISCLOSURE IS THE GATE. NOT A FOOTNOTE NEXT TO IT.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * `GET /confluence/authorize` (`apps/api/src/routes/integrations/index.ts`,
 * `CONFLUENCE_CONNECT_DISCLOSURE`) hands back `disclosure` beside
 * `authorizationUrl` on purpose: no caller can read the URL off that response
 * without also reading the limits. `buildConnectView` below is the one seam
 * this page uses to turn that response into something it can render, and it
 * throws rather than returning a URL when the disclosure is missing or
 * incomplete. A page that only ever renders the *return value* of this
 * function — never `response.data.authorizationUrl` directly — cannot show
 * the link without showing the limits first, because there is no path to the
 * link that skips this check.
 *
 * The disclosure text itself is not duplicated here. It travels from the API
 * response through untouched; this module only validates its shape and
 * reshapes it for rendering (flattening the two note lists onto named
 * fields). The prose stays pinned exactly once, in the API's own test file
 * (`integrations-route.test.ts`), which is where a reassuring edit would be
 * caught.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE DISCONNECT COPY IS A CONSTANT, NOT A TEMPLATE STRING BUILT ON THE PAGE.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * `CONFLUENCE_DISCONNECT_COPY` below is the only sentence the disconnect
 * screen shows about what disconnecting does. It is worded from
 * `CONFLUENCE_CONNECT_DISCLOSURE.disconnecting` and carries the same two
 * rules: our copy of the credentials is provably deleted, and nothing here
 * may ever claim CharityPilot revoked anything at Atlassian — Atlassian
 * documents no endpoint that does that. The 90-day lapse and the
 * administrator's own connected-apps setting are offered as the two remedies
 * that actually work, both attributed to Atlassian, neither promised by
 * CharityPilot. `integration-status.test.ts` pins this by regex and by
 * mutation, deliberately: this is the one string on this page a reassuring
 * edit would cost a charity its answer to a regulator.
 */

// ── the authorize response → the connect view ───────────────────────────────

export type ConfluenceDisclosure = {
  stage: string;
  headline: string;
  erasure: readonly string[];
  disconnecting: readonly string[];
  reference: string;
};

export type ConfluenceAuthorizeResponse = {
  authorizationUrl: string;
  disclosure: ConfluenceDisclosure;
};

export type ConnectView = {
  authorizationUrl: string;
  stage: string;
  headline: string;
  erasurePoints: readonly string[];
  disconnectingPoints: readonly string[];
  reference: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

/**
 * Turns `GET /confluence/authorize`'s response into a `ConnectView`, or
 * throws.
 *
 * There is no partial success: an authorizationUrl without a usable
 * disclosure is refused exactly like a missing authorizationUrl, because a
 * caller that only renders what this function returns can then never end up
 * with a link on screen and no limits next to it. `authorizationUrl` is also
 * required to be an `https://` URL — Atlassian's own authorize endpoint is
 * always https, and a scheme this narrow check rejects is never one this
 * page should hand an administrator regardless of what produced it.
 */
export function buildConnectView(authorize: {
  authorizationUrl: unknown;
  disclosure: unknown;
}): ConnectView {
  const { authorizationUrl, disclosure } = authorize;

  if (!isNonEmptyString(authorizationUrl) || !authorizationUrl.startsWith('https://')) {
    throw new Error(
      'buildConnectView requires a non-empty https:// authorizationUrl; refusing to build a connect view without one.',
    );
  }

  if (!disclosure || typeof disclosure !== 'object' || Array.isArray(disclosure)) {
    throw new Error(
      'buildConnectView requires a disclosure. The authorize link may never be shown without the erasure and ' +
        'disconnect limits next to it.',
    );
  }

  const record = disclosure as Record<string, unknown>;

  if (
    !isNonEmptyString(record.headline) ||
    !isNonEmptyStringArray(record.erasure) ||
    !isNonEmptyStringArray(record.disconnecting)
  ) {
    throw new Error(
      'buildConnectView requires a complete disclosure (a headline, at least one erasure point and at least one ' +
        'disconnecting point). A partial disclosure is treated the same as a missing one.',
    );
  }

  return {
    authorizationUrl,
    stage: isNonEmptyString(record.stage) ? record.stage : 'alpha',
    headline: record.headline,
    erasurePoints: record.erasure,
    disconnectingPoints: record.disconnecting,
    reference: isNonEmptyString(record.reference) ? record.reference : '',
  };
}

// ── the disconnect copy ──────────────────────────────────────────────────────

/**
 * Shown on the disconnect confirmation, in full, every time. See the module
 * doc for why this is a single constant and not text assembled on the page.
 *
 * The three facts below may never soften, per the module doc: what is
 * provable (credential deletion), what is not (revocation at Atlassian), and
 * the two remedies that actually work, both attributed to Atlassian.
 */
export const CONFLUENCE_DISCONNECT_COPY =
  'Disconnecting deletes CharityPilot’s copy of your Confluence credentials — that part is complete and ' +
  'verifiable. CharityPilot also attempts to withdraw the authorisation at Atlassian, but Atlassian documents no ' +
  'way for an app to do this, so the attempt may silently do nothing; CharityPilot does not claim to have revoked ' +
  'your access. Atlassian documents that an unused authorisation expires automatically after 90 days — that ' +
  'is Atlassian’s own behaviour, not a CharityPilot guarantee, and nothing here would notice if they changed ' +
  'it. The only way to withdraw access immediately and be certain of it is yours to take: remove CharityPilot in ' +
  'your Atlassian account’s connected-apps settings.';

// ── the alpha marking ────────────────────────────────────────────────────────

/**
 * The one label the interface uses to mark Confluence as alpha — in the
 * dashboard navigation and again on the page itself, so nobody can land on
 * either without seeing it. Kept as a named export rather than a literal
 * repeated in two components so the wiring test in
 * `integration-status.test.ts` can pin that both actually use it.
 */
export const CONFLUENCE_ALPHA_BADGE_LABEL = 'Alpha';

// ── the status response → the status card ───────────────────────────────────

/**
 * Mirrors `GET /confluence/status`'s response shape exactly (see
 * `apps/api/src/routes/integrations/index.ts`). `status` is never widened or
 * narrowed here — this module has no opinion on the API's output guard, and
 * none is needed: it only decides what a status maps to on screen.
 */
export type ConfluenceConnectionStatus = 'CONNECTED' | 'DISCONNECTED' | 'NOT_CONNECTED' | 'ERROR';

export type ConfluenceStatusResponse = {
  provider: 'CONFLUENCE';
  status: ConfluenceConnectionStatus;
  siteUrl: string | null;
  siteName: string | null;
  siteCount: number | null;
  connectedAt: string | null;
  lastError: string | null;
};

export type StatusDisplay = {
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  label: string;
  showConnect: boolean;
  showDisconnect: boolean;
};

/**
 * What the status card shows and which of the two actions are offered.
 *
 * `ERROR` offers both actions rather than neither: the stored connection is
 * unhealthy, so an administrator may need to disconnect it before connecting
 * again, and hiding either action would leave them stuck reading a status
 * report with no way to act on it.
 */
export function describeConfluenceStatus(status: ConfluenceStatusResponse): StatusDisplay {
  switch (status.status) {
    case 'CONNECTED':
      return { tone: 'success', label: 'Connected', showConnect: false, showDisconnect: true };
    case 'ERROR':
      return { tone: 'danger', label: 'Connection error', showConnect: true, showDisconnect: true };
    case 'DISCONNECTED':
    case 'NOT_CONNECTED':
    default:
      return { tone: 'neutral', label: 'Not connected', showConnect: true, showDisconnect: false };
  }
}
