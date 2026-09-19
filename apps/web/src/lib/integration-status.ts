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

export type ConfluenceSpace = {
  id: string;
  key: string;
  name: string;
};

export type ConfluenceStatusResponse = {
  provider: 'CONFLUENCE';
  status: ConfluenceConnectionStatus;
  siteUrl: string | null;
  siteName: string | null;
  siteCount: number | null;
  connectedAt: string | null;
  lastError: string | null;
  /** The chosen publish destination, or null when there is none to use. */
  publishSpace: ConfluenceSpace | null;
  /** CONNECTED *and* a destination that still resolves. Never one without the other. */
  publishing: boolean;
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

// ── connected is not publishing ──────────────────────────────────────────────

/**
 * What an administrator is told when they change the space, every time they
 * are offered the choice.
 *
 * It exists because the obvious assumption is wrong and expensive: changing
 * the destination does **not** move, copy or re-publish anything. Every page
 * CharityPilot has already published keeps the location recorded against it,
 * which is precisely what keeps it erasable — Phase 5's eraser works from the
 * recorded `cloudId` and `pageId` rather than recomputing where a document
 * "should" be. A charity that changed the space believing its published
 * documents would follow would be wrong about where its records are, and
 * wrong in the direction that matters when somebody asks for erasure.
 */
export const CONFLUENCE_PUBLISH_SPACE_CHANGE_NOTE =
  'Changing the space changes where documents published from now on will go. Documents already published stay ' +
  'exactly where they were published: CharityPilot keeps the recorded location of each one, which is what makes ' +
  'it erasable later, and nothing is moved, copied or deleted in Confluence when you change this.';

export type PublishingDisplay = {
  publishing: boolean;
  tone: 'success' | 'warning' | 'neutral';
  label: string;
  /** The plain statement of what is and is not happening. Never hedged. */
  headline: string;
  /** What it means or what is left to do; null when there is nothing to add. */
  detail: string | null;
  /** Whether the space picker is worth showing at all. */
  showSpacePicker: boolean;
};

/**
 * Whether this organisation's documents are actually being published, and how
 * the screen says so.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * CONNECTED IS NOT PUBLISHING, AND THE SCREEN MUST NOT LET THE TWO BLUR.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Connecting Confluence is the opt-in; choosing a space is the destination.
 * An organisation with the first and not the second is connected and
 * publishing nothing — and a charity that believes it is mirroring its
 * governance documents and is not is worse off than one that knows it has a
 * step left. So the connected-without-a-space case gets its own warning tone
 * and says so in as many words, rather than being folded into the green
 * "Connected" the connection card already shows.
 *
 * `publishing` is asserted three ways — the API's own flag, a live connection
 * and a resolved space — and all three must agree. They are three readings of
 * one fact, and if they ever disagree the safe answer is the one that does not
 * tell a charity its documents are being mirrored.
 */
export function describeConfluencePublishing(status: ConfluenceStatusResponse): PublishingDisplay {
  if (status.status !== 'CONNECTED') {
    return {
      publishing: false,
      tone: 'neutral',
      label: 'Not publishing',
      headline: 'Governance documents are not being published to Confluence.',
      detail: 'Connect this organisation’s Confluence site first, then choose the space to publish into.',
      showSpacePicker: false,
    };
  }

  const space = status.publishSpace;

  if (space === null || space === undefined) {
    return {
      publishing: false,
      tone: 'warning',
      label: 'Connected — not publishing yet',
      headline: 'Confluence is connected, but nothing is being published yet.',
      detail:
        'CharityPilot publishes a governance document only once you have chosen the Confluence space it should ' +
        'go into. Until you choose one, nothing is published and your documents stay in CharityPilot only.',
      showSpacePicker: true,
    };
  }

  if (status.publishing !== true) {
    // The API says there is a space but not that publication is live. Two
    // readings of one fact disagreeing is not a moment to reassure anybody.
    return {
      publishing: false,
      tone: 'warning',
      label: 'Connected — not publishing yet',
      headline: 'Confluence is connected, but nothing is being published yet.',
      detail: 'Choose the Confluence space to publish into.',
      showSpacePicker: true,
    };
  }

  return {
    publishing: true,
    tone: 'success',
    label: 'Publishing',
    headline: `Governance documents are published to ${spaceLabel(space)}.`,
    detail: CONFLUENCE_PUBLISH_SPACE_CHANGE_NOTE,
    showSpacePicker: true,
  };
}

/** A space as an administrator should read it: its name, with its key to disambiguate. */
export function spaceLabel(space: ConfluenceSpace): string {
  const name = typeof space.name === 'string' ? space.name.trim() : '';
  return name.length > 0 ? `${name} (${space.key})` : space.key;
}

/**
 * The spaces from `GET /confluence/spaces`, or an empty list.
 *
 * Narrow on purpose, exactly as the API is: a space needs an id and a key to
 * be choosable, and nothing else about a space object is carried onto this
 * screen. A malformed entry is dropped rather than throwing — a picker that
 * shows the spaces it understood is more use than an error page.
 */
export function parseConfluenceSpaces(payload: unknown): ConfluenceSpace[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const raw = (payload as { spaces?: unknown }).spaces;
  if (!Array.isArray(raw)) return [];

  const spaces: ConfluenceSpace[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (!isNonEmptyString(record.id) || !isNonEmptyString(record.key)) continue;
    spaces.push({
      id: record.id,
      key: record.key,
      name: typeof record.name === 'string' ? record.name : '',
    });
  }
  return spaces;
}
