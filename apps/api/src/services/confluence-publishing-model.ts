/**
 * The publishing model: what a published page is SHAPED like.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THIS FILE MAKES THE TIER 3 QUESTIONS EXPRESSIBLE. IT DOES NOT ANSWER THEM.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The audit's Tier 3 is a list of decisions for the owner and the DPO to take
 * together, and several of them are forks rather than features — most sharply
 * "a stub page plus an attachment" versus "the document rendered as the page
 * body", which is the mirror question itself. Building either one as *the*
 * behaviour would settle a question that is not an engineer's to settle.
 *
 * So each one becomes a per-organisation setting whose **default is exactly
 * what CharityPilot does today**. Nothing changes for any existing charity;
 * what changes is that the conversation now has something to point at, and
 * agreeing an answer is a configuration change rather than a rewrite.
 *
 * ## Why defaults matter more than the options here
 *
 * `DEFAULT_PUBLISHING_MODEL` reproduces the current behaviour field for field,
 * and a test asserts that an organisation with no configuration publishes
 * byte-identically to one from before this file existed. That is the property
 * that makes shipping this safe before the meeting: a charity connected today
 * cannot have its pages change shape because an option now exists.
 *
 * ## What is NOT here
 *
 * Forge Remote. It needs a separate Forge application, its own deployment and
 * an Atlassian registration, none of which is a configuration flag — and the
 * DPO's condition for considering it at all was that polling proves
 * insufficient. Polling has not yet run once against a real site.
 */

/** How a published page's title is built. */
export type PublicationNamingConvention =
  /** The document's own name. What CharityPilot does today. */
  | 'DOCUMENT_NAME'
  /**
   * The charity's own prefixes — reportedly `POL -` for policies and `NOS -`
   * for standard operating procedures on the hOUR Timebank Governance Hub.
   *
   * REPORTEDLY. This has never been seen against a real site. It is offered
   * rather than applied because a page that looks native and is subtly wrong
   * is worse than one that is obviously ours.
   */
  | 'CATEGORY_PREFIXED';

/** What the page body contains. THE MIRROR QUESTION. */
export type PublicationBodyMode =
  /**
   * A wrapper page that names the document and points back to CharityPilot,
   * with the file attached. What CharityPilot does today, and what the storage
   * spec assumes: Confluence is a published mirror, Supabase in Ireland is
   * authoritative.
   */
  | 'STUB_WITH_ATTACHMENT'
  /**
   * The document's substance rendered as the page itself.
   *
   * **This is the fork, not a formatting preference.** It makes the Confluence
   * page a thing a reader can read rather than a pointer to a file, which is
   * closer to the architecture the DPO signed off on 2026-09-18 — and it puts
   * the document's content into a system whose residency CharityPilot does not
   * control, which is Open Question 1. Choosing it is a governance decision.
   */
  | 'FULL_BODY';

export type ConfluencePublishingModel = {
  naming: PublicationNamingConvention;
  bodyMode: PublicationBodyMode;
  /**
   * A page every published page is filed under, so CharityPilot's pages do not
   * land loose at the space root. Null means the space root, which is what
   * happens today.
   */
  parentPageId: string | null;
  /** `charitypilot` plus the document category, so a space can be filtered. */
  applyLabels: boolean;
  /**
   * Mirror CharityPilot's approval state onto the page through Confluence's v1
   * content-state API.
   *
   * Off by default and deliberately so: setting a content state **publishes a
   * new page version**, so this is CharityPilot writing to a charity's
   * Confluence on its own initiative every time an approval changes. That is
   * exactly the class of write the DPO asked to discuss before it is built
   * into the default.
   */
  mirrorContentState: boolean;
  /**
   * A data-classification label, for sites on a plan that has them.
   *
   * A string rather than a boolean because the classification names are the
   * charity's own, defined in their Atlassian instance; CharityPilot cannot
   * enumerate them and must not invent one.
   */
  classificationLabel: string | null;
};

/**
 * Exactly what CharityPilot does today.
 *
 * Every field here is the current behaviour, not a preference. Changing one of
 * these defaults changes what every existing charity's pages look like, which
 * is the decision this file exists to keep out of the code.
 */
export const DEFAULT_PUBLISHING_MODEL: ConfluencePublishingModel = Object.freeze({
  naming: 'DOCUMENT_NAME',
  bodyMode: 'STUB_WITH_ATTACHMENT',
  parentPageId: null,
  applyLabels: false,
  mirrorContentState: false,
  classificationLabel: null,
});

const NAMING_VALUES: readonly PublicationNamingConvention[] = ['DOCUMENT_NAME', 'CATEGORY_PREFIXED'];
const BODY_VALUES: readonly PublicationBodyMode[] = ['STUB_WITH_ATTACHMENT', 'FULL_BODY'];

/** Confluence labels are lowercase, no spaces. Bounded so a stored value cannot be absurd. */
const LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,60}$/;

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Reads the model out of the integration's `config`, falling back to today's
 * behaviour for anything absent or unrecognised.
 *
 * LENIENT ON PURPOSE, in one direction only. An unreadable or unknown value
 * resolves to the default — which is the current behaviour — rather than
 * throwing, because a malformed setting must never stop a charity's documents
 * publishing. It can only ever fail *towards* what the product already did.
 */
export function readPublishingModel(stored: unknown): ConfluencePublishingModel {
  // The `publishingModel` COLUMN, not a key inside `config`. A reconnect
  // overwrites `config` wholesale, which would silently revert a charity's
  // chosen body mode and rewrite pages that already exist in their site back to
  // stubs on the next edit. See the 20260921050000 migration.
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return DEFAULT_PUBLISHING_MODEL;
  }
  const record = stored as Record<string, unknown>;

  const naming = readString(record, 'naming');
  const bodyMode = readString(record, 'bodyMode');
  const classification = readString(record, 'classificationLabel');

  return {
    naming: NAMING_VALUES.includes(naming as PublicationNamingConvention)
      ? (naming as PublicationNamingConvention)
      : DEFAULT_PUBLISHING_MODEL.naming,
    bodyMode: BODY_VALUES.includes(bodyMode as PublicationBodyMode)
      ? (bodyMode as PublicationBodyMode)
      : DEFAULT_PUBLISHING_MODEL.bodyMode,
    parentPageId: readString(record, 'parentPageId'),
    applyLabels: record.applyLabels === true,
    mirrorContentState: record.mirrorContentState === true,
    classificationLabel:
      classification !== null && LABEL_PATTERN.test(classification) ? classification : null,
  };
}

/** The category prefix the `CATEGORY_PREFIXED` convention applies, if any. */
export function categoryPrefix(category: string): string | null {
  switch (category) {
    case 'POLICY':
      return 'POL';
    case 'PROCEDURE':
      return 'NOS';
    default:
      // No guess. A category with no confirmed prefix publishes under its own
      // name, which is honest, rather than under an invented one.
      return null;
  }
}

/**
 * The labels a published page carries, lowercase and deduplicated.
 *
 * `charitypilot` is always first when labels are on: a space administrator
 * asking "what did this tool create in my site" must be able to answer it with
 * one filter, and that question is the whole reason labels are worth applying.
 */
export function publicationLabels(
  model: ConfluencePublishingModel,
  doc: { category: string },
): string[] {
  if (!model.applyLabels) return [];

  const labels = ['charitypilot'];
  const category = doc.category.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (LABEL_PATTERN.test(category)) labels.push(category);
  if (model.classificationLabel !== null) labels.push(model.classificationLabel);

  return [...new Set(labels)];
}
