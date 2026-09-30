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

// ───────────────────────────────────────────────────────────────────────────
// THE WORD "DELETED" IS FORBIDDEN IN EVERY LINE BELOW.
// ───────────────────────────────────────────────────────────────────────────
//
// Confluence answers a 404 through its v2 API for a page in the site's trash
// AND for one that has been purged. The reconcile job separates them with a v1
// read, and that distinction is the entire product value of this feature — one
// is restorable by the charity's own administrators, in their own trash, and
// the other is not restorable by anyone.
//
// "Deleted" collapses the two. A trustee told their policy was deleted, when it
// is sitting in their site's trash and could be restored in thirty seconds, has
// been told something false by a governance product about a governance record.
// A trustee told it was deleted when it is genuinely unrecoverable has been
// told something true only by accident.
//
// `integration-status.test.ts` pins this by regex over every string this module
// can produce. Do not add a sentence here without running it.

/** Mirrors `DocumentPublicationRemoteState` in the API's Prisma schema. */
export type ConfluenceRemoteState = 'VISIBLE' | 'ARCHIVED' | 'TRASHED' | 'GONE' | 'UNKNOWN';

/** Mirrors the publication states the API reports for a document. */
export type ConfluencePublicationState =
  | 'NOT_PUBLISHED'
  | 'PENDING'
  | 'PUBLISHED'
  | 'FAILED'
  | 'RETIRED';

export type ConfluenceMirror = {
  publication: ConfluencePublicationState;
  /** Null/omitted means the response cannot establish whether a page ID was recorded. */
  pageRecorded?: boolean | null;
  /** False means the recorded page belongs to a different site from this connection. */
  pageSiteMatchesConnection?: boolean | null;
  /** Whether the recorded page IDs belong to the selected publishing site and space. */
  recordedPageMatchesDestination?: boolean | null;
  /** False means no active Confluence connection is available for this page. */
  connectionAvailable?: boolean | null;
  /** False means an existing approval does not cover this active site and space. */
  approvalDestinationCurrent?: boolean | null;
  /** Exact active destination shown to an Admin before a publication decision. */
  publishDestination?: {
    siteId: string;
    siteUrl: string | null;
    spaceId: string;
    spaceKey: string;
    spaceName: string;
  } | null;
  pageUrl: string | null;
  remote: {
    state: ConfluenceRemoteState;
    title: string | null;
    version: number | null;
    lastReconciledAt: string | null;
    reconcileError: string | null;
  } | null;
};

export type MirrorDisplay = {
  /** One short line for a badge. */
  label: string;
  /** The sentence shown beneath it. Never the word "deleted". */
  detail: string;
  tone: 'neutral' | 'positive' | 'warning' | 'danger';
  /** True when the charity can act: retry a failure, or look in their own trash. */
  actionable: boolean;
  /** A former current document needs a separate review of any recorded copy. */
  historicalReview?: string;
};

function checkedSuffix(lastReconciledAt: string | null): string {
  if (lastReconciledAt === null) return '';
  const parsed = new Date(lastReconciledAt);
  if (Number.isNaN(parsed.getTime())) return '';
  // The date only. An exact timestamp invites a reader to treat this as live,
  // and it is a six-hourly poll.
  return `, checked ${parsed.toISOString().slice(0, 10)}`;
}

function recordedPageState(mirror: ConfluenceMirror): boolean | null {
  if (mirror.pageUrl !== null) return true;
  return typeof mirror.pageRecorded === 'boolean' ? mirror.pageRecorded : null;
}

/**
 * What to show a trustee about the Confluence copy of one document.
 *
 * The publication state comes first: a page CharityPilot never managed to
 * create has no remote state worth describing, and describing one would imply
 * a page exists.
 */
function describeConfluenceMirrorBase(mirror: ConfluenceMirror | null): MirrorDisplay {
  if (mirror === null || mirror.publication === 'NOT_PUBLISHED') {
    return {
      label: 'Not published',
      detail: 'This document is held in CharityPilot only. It has not been published to Confluence.',
      tone: 'neutral',
      actionable: false,
    };
  }

  if (mirror.publication === 'PENDING') {
    const recorded = recordedPageState(mirror);
    return {
      label: 'Publishing',
      detail: recorded === true
        ? 'A Confluence page reference has been recorded, but publishing has not finished. Do not rely on the external copy yet.'
        : recorded === false
          ? 'This document is queued to be published to Confluence; no page reference is recorded yet.'
          : 'Publishing is queued or in progress, but this response cannot establish whether a Confluence page was recorded. Do not rely on the external copy yet.',
      tone: 'neutral',
      actionable: false,
    };
  }

  if (mirror.publication === 'FAILED') {
    const recorded = recordedPageState(mirror);
    return {
      label: recorded === true ? 'Page reference recorded' : 'Publishing stopped',
      detail: recorded === true
        ? 'A Confluence page reference was recorded, but publishing did not finish. Review the external page and attachment before retrying.'
        : recorded === false
          ? 'Publishing stopped before CharityPilot recorded a Confluence page. An administrator can investigate and try again.'
          : 'Publishing stopped, but this response cannot establish whether a Confluence page was recorded. Review the external site before retrying.',
      tone: 'danger',
      actionable: true,
    };
  }

  if (mirror.publication === 'RETIRED') {
    return {
      label: 'No longer tracked',
      detail:
        'This document was removed from CharityPilot. The Confluence page was left in place, ' +
        'which is deliberate — removing a record here does not touch the charity’s own site.',
      tone: 'neutral',
      actionable: false,
    };
  }

  // PUBLISHED, so what matters now is what the page looks like at the far end.
  if (mirror.remote === null) {
    return {
      label: 'Published',
      detail: 'Published to Confluence. The page has not been checked yet.',
      tone: 'positive',
      actionable: false,
    };
  }

  const checked = checkedSuffix(mirror.remote.lastReconciledAt);

  switch (mirror.remote.state) {
    case 'VISIBLE':
      return {
        label: 'Published',
        detail: `Published to Confluence${checked}.`,
        tone: 'positive',
        actionable: false,
      };
    case 'ARCHIVED':
      return {
        label: 'Archived in Confluence',
        detail: `The page has been archived in Confluence${checked}. It is still there and can be restored by a site administrator.`,
        tone: 'warning',
        actionable: true,
      };
    case 'TRASHED':
      return {
        label: 'No longer visible in Confluence',
        // Restorable, and by THEM. This is the sentence the whole v1 trashed
        // read exists to make it possible to write truthfully.
        detail: `No longer visible in Confluence${checked} — it is in the site’s trash and can be restored there.`,
        tone: 'warning',
        actionable: true,
      };
    case 'GONE':
      return {
        label: 'No longer visible in Confluence',
        // NOT "deleted", even though this is the case where it very likely was.
        // CharityPilot polled and could not find it; it cannot witness who
        // removed it or whether it is recoverable by some route it cannot see.
        detail: `No longer visible in Confluence${checked} — the page could not be found.`,
        tone: 'danger',
        actionable: false,
      };
    case 'UNKNOWN':
    default:
      return {
        label: 'Could not check Confluence',
        detail:
          'CharityPilot could not read this page in Confluence, so what it says there is unknown. ' +
          // "does not have permission", not "no longer has permission". The
          // phrase "no longer" is reserved for the two states that genuinely
          // mean the page is not visible, and a reader skimming this line must
          // not take a permissions problem for a missing document.
          'This usually means the connection does not have permission to read it.',
        tone: 'warning',
        actionable: false,
      };
  }
}

export function describeConfluenceMirror(mirror: ConfluenceMirror | null, isCurrentDocument = true,
  approvalNeedsReview = false, approvalWithdrawnWithCopy = false): MirrorDisplay {
  let display = describeConfluenceMirrorBase(mirror);
  if (approvalWithdrawnWithCopy) {
    display = {
      label: 'Publication approval withdrawn',
      detail: 'A Confluence page reference remains, but this document has no current publication approval. Review the external copy separately; its recorded state does not establish that the page is gone or safe to rely on.',
      tone: 'warning',
      actionable: false,
    };
  } else if (approvalNeedsReview) {
    display = {
      label: 'Publication approval needs review',
      detail: 'The selected Confluence site or space is not covered by this document’s recorded approval. Review the destination and any existing copy, then record a reasoned approval for this destination before publication continues.',
      tone: 'warning',
      actionable: false,
    };
  } else if (mirror && recordedPageState(mirror) === true && mirror.connectionAvailable === false) {
    display = {
      label: 'Connection unavailable',
      detail: 'A Confluence page reference is recorded, but this charity has no active Confluence connection. Review the page on its original site before relying on its current status or retrying publication.',
      tone: 'warning',
      actionable: false,
    };
  } else if (mirror && recordedPageState(mirror) === true && mirror.pageSiteMatchesConnection === false) {
    const lead = mirror.publication === 'PENDING' ? 'Publishing has not finished. '
      : mirror.publication === 'FAILED' ? 'Publishing stopped before completion. '
        : mirror.publication === 'RETIRED' ? 'This document is no longer tracked for publication. ' : '';
    const nextStep = mirror.publication === 'FAILED'
      ? 'Review the original site and reconcile the recorded page before retrying publication.'
      : 'Review the original site before relying on the copy; this connection does not establish its current status.';
    display = {
      label: 'Page on another site',
      detail: `${lead}The recorded Confluence page belongs to a different site from the current connection. ${nextStep}`,
      tone: 'warning',
      actionable: false,
    };
  } else if (mirror && recordedPageState(mirror) === true && mirror.connectionAvailable === true
    && mirror.pageSiteMatchesConnection === null) {
    display = {
      label: 'Page site unverified',
      detail: 'A Confluence page reference is recorded, but CharityPilot cannot confirm that it belongs to the currently connected site. Review the original site before relying on the copy or retrying publication.',
      tone: 'warning',
      actionable: false,
    };
  }
  if (isCurrentDocument || mirror === null ||
    (mirror.publication === 'NOT_PUBLISHED' && mirror.pageUrl === null)) return display;

  const recorded = recordedPageState(mirror);
  const hasRecordedCopy = mirror.publication === 'PUBLISHED' || recorded === true;

  return {
    ...display,
    label: display.label === 'Published' ? 'Historical copy recorded' : display.label,
    tone: display.tone === 'positive' || display.tone === 'neutral' ? 'warning' : display.tone,
    ...(mirror.publication === 'FAILED' && !approvalNeedsReview && !approvalWithdrawnWithCopy && mirror.connectionAvailable !== false && mirror.pageSiteMatchesConnection !== false
      && !(recorded === true && mirror.connectionAvailable === true && mirror.pageSiteMatchesConnection === null) ? {
      detail: recorded === true
        ? 'A Confluence page reference was recorded, but publishing did not finish. This document is no longer CURRENT, so publication cannot be retried; review the external copy separately.'
        : recorded === false
          ? 'The last Confluence publishing attempt stopped before CharityPilot recorded a page. This document is no longer CURRENT, so publication cannot be retried.'
          : 'The last Confluence publishing attempt stopped, but this response cannot establish whether a page was recorded. This document is no longer CURRENT, so publication cannot be retried; review the external site separately.',
      actionable: false,
    } : {}),
    ...(mirror.publication === 'PENDING' ? {
      detail: 'A publishing job is recorded for this non-current document. Review its final state before relying on the external copy.',
    } : {}),
    historicalReview: approvalNeedsReview
      ? 'This document is not CURRENT in CharityPilot. A recorded Confluence approval no longer covers the selected destination; review any existing copy separately. A new publication is not permitted.'
      : mirror.connectionAvailable === false
      ? 'This document is not CURRENT in CharityPilot. A page reference remains while the Confluence connection is inactive; review and manage the copy on its original site. A new publication is not permitted.'
      : mirror.pageSiteMatchesConnection === false
      ? 'This document is not CURRENT in CharityPilot. Its recorded page belongs to another Confluence site; review and manage that copy on the original site. A new publication is not permitted.'
      : recorded === true && mirror.connectionAvailable === true && mirror.pageSiteMatchesConnection === null
        ? 'This document is not CURRENT in CharityPilot. The recorded page site cannot be confirmed against the connection; review the original site. A new publication is not permitted.'
      : hasRecordedCopy
      ? 'This document is not CURRENT in CharityPilot. A Confluence copy or page reference remains in the publication record; review its remote status and manage that copy separately.'
      : recorded === null
        ? 'This document is not CURRENT in CharityPilot. Page-reference status is unavailable; review the external site and recorded publishing job. A new publication is not permitted.'
        : 'This document is not CURRENT in CharityPilot. Review the recorded publishing job; a new publication is not permitted.',
  };
}

/** Every sentence this module can produce, for the copy guard to scan. */
export function allMirrorCopy(): string[] {
  const states: ConfluenceRemoteState[] = ['VISIBLE', 'ARCHIVED', 'TRASHED', 'GONE', 'UNKNOWN'];
  const publications: ConfluencePublicationState[] = [
    'NOT_PUBLISHED',
    'PENDING',
    'PUBLISHED',
    'FAILED',
    'RETIRED',
  ];

  const copy: string[] = [];
  for (const publication of publications) {
    for (const pageRecorded of [false, true, null]) {
      for (const pageSiteMatchesConnection of [true, false, null]) {
        for (const connectionAvailable of [true, false, null]) {
          const withoutRemote = describeConfluenceMirror({ publication, pageRecorded, pageSiteMatchesConnection,
            connectionAvailable, pageUrl: null, remote: null });
          copy.push(withoutRemote.label, withoutRemote.detail);
          const historicalWithoutLink = describeConfluenceMirror({ publication, pageRecorded, pageSiteMatchesConnection,
            connectionAvailable, pageUrl: null, remote: null }, false);
          copy.push(historicalWithoutLink.label, historicalWithoutLink.detail,
            ...(historicalWithoutLink.historicalReview ? [historicalWithoutLink.historicalReview] : []));
        }
      }
    }
    const historical = describeConfluenceMirror({ publication, pageUrl: 'https://example.invalid/page', remote: null }, false);
    copy.push(historical.label, historical.detail, ...(historical.historicalReview ? [historical.historicalReview] : []));
    const staleApproval = describeConfluenceMirror({ publication, pageUrl: null, remote: null }, true, true);
    copy.push(staleApproval.label, staleApproval.detail);
    const withdrawnApproval = describeConfluenceMirror({ publication, pageRecorded: true,
      pageUrl: null, remote: null }, true, false, true);
    copy.push(withdrawnApproval.label, withdrawnApproval.detail);
    for (const state of states) {
      const display = describeConfluenceMirror({
        publication,
        pageUrl: null,
        remote: { state, title: null, version: null, lastReconciledAt: null, reconcileError: null },
      });
      copy.push(display.label, display.detail);
    }
  }
  copy.push(...[describeConfluenceMirror(null).label, describeConfluenceMirror(null).detail]);
  return copy;
}
