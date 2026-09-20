import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

/**
 * One search across the records a charity keeps.
 *
 * It exists because an agent working without a screen could only page
 * registers. Asked "what did we decide about the safeguarding policy", it had
 * to fetch the whole minute book, every document and four registers, and read
 * them. This answers with the handful of records that mention it.
 *
 * ## What a search may match
 *
 * The personal-data gate governs matching, not only returning. A hit is
 * itself an answer: told that a conflict record matches "Mary Kelly", a
 * caller has learned that Mary Kelly appears in it, even if no field comes
 * back. So while the session's scope is WITHHELD, the free-text columns the
 * field policy withholds are not searched at all, and no hit can be built
 * from one. A session whose scope is FULL searches both sets.
 *
 * That makes the same query answer differently under the two scopes, which is
 * the correct behaviour and is reported in the response so nobody mistakes a
 * narrow answer for an empty one.
 *
 * ## Why this is `contains` rather than Postgres full text
 *
 * At this size — a charity's register is tens of rows, its minute book
 * hundreds — a case-insensitive substring match over a handful of columns is
 * immediate, and it finds partial words, which is what somebody typing into a
 * search box expects. Full text would add a tsvector column and a GIN index
 * per table, and would stop matching "safeguard" against "safeguarding"
 * without stemming configured for it.
 *
 * The trade is ranking: these results are ordered by kind and recency, not by
 * relevance. Revisit that when a single charity's minute book passes a few
 * thousand resolutions, which is the point at which reading them all in order
 * stops being reasonable.
 */

/** A kind of record this can look in. */
export type SearchType =
  | 'BoardMember'
  | 'GoverningAct'
  | 'Resolution'
  | 'ConflictRecord'
  | 'RiskRecord'
  | 'ComplaintRecord'
  | 'FundraisingRecord'
  | 'Document'
  | 'Deadline'
  | 'GovernanceStandard';

interface Searchable {
  /** The Prisma delegate. */
  readonly delegate: string;
  /**
   * Columns matched and quoted back whatever the session's scope.
   *
   * Every one of these is on the connector's safe list for the same model, so
   * a search can never quote text a read of the same record would withhold.
   */
  readonly safeFields: readonly string[];
  /** Columns matched and quoted back only under a FULL scope. */
  readonly personalFields: readonly string[];
  /** Names the hit while the gate is closed. The first with a value wins. */
  readonly titleFields: readonly string[];
  /**
   * Names the hit under a FULL scope, tried before `titleFields`.
   *
   * Several of these records have no useful name of their own until the
   * withheld side is available: a conflict is known by the trustee it is
   * about, a resolution by its text.
   */
  readonly fullTitleFields?: readonly string[];
  /**
   * True when the route that reads this kind is behind the Complete plan.
   *
   * Search would otherwise be a way around that gate: a charity on the
   * smaller plan cannot open the minute book or the registers, and being
   * able to find what is in them is most of the way to reading them.
   */
  readonly completePlanOnly?: boolean;
  /** Reference data shared by every charity carries no organisationId. */
  readonly tenantScoped: boolean;
  /** The reference an agent passes back to fetch the record. */
  readonly refPath: string;
  /** How the newest rows are found. */
  readonly orderBy: Record<string, 'asc' | 'desc'>;
}

export const SEARCHABLE: Record<SearchType, Searchable> = {
  BoardMember: {
    delegate: 'boardMember',
    safeFields: ['name', 'role'],
    // A trustee's email, previous names and other directorships are on the
    // register the charity keeps, not the one the public sees.
    personalFields: ['email', 'residentialAddress', 'formerNames', 'otherDirectorships'],
    titleFields: ['name'],
    tenantScoped: true,
    refPath: 'board-member',
    orderBy: { appointedDate: 'desc' },
  },
  GoverningAct: {
    delegate: 'governingAct',
    completePlanOnly: true,
    safeFields: ['reference', 'title', 'statutoryBasis'],
    personalFields: ['notes'],
    titleFields: ['title', 'reference'],
    tenantScoped: true,
    refPath: 'governing-act',
    orderBy: { actDate: 'desc' },
  },
  Resolution: {
    // The text of a resolution is the single most useful thing to search and
    // the single most likely to name somebody, which is exactly why it is on
    // the withheld side rather than left out of the index.
    delegate: 'resolution',
    completePlanOnly: true,
    safeFields: ['itemNumber'],
    personalFields: ['text', 'abstentions'],
    titleFields: ['itemNumber'],
    fullTitleFields: ['text'],
    tenantScoped: true,
    refPath: 'resolution',
    orderBy: { createdAt: 'desc' },
  },
  ConflictRecord: {
    delegate: 'conflictRecord',
    completePlanOnly: true,
    safeFields: ['minuteReference'],
    personalFields: ['trusteeName', 'matter', 'nature', 'actionTaken', 'decision'],
    titleFields: ['minuteReference'],
    fullTitleFields: ['trusteeName'],
    tenantScoped: true,
    refPath: 'conflict-record',
    orderBy: { dateDeclared: 'desc' },
  },
  RiskRecord: {
    delegate: 'riskRecord',
    completePlanOnly: true,
    safeFields: ['title', 'boardMinuteReference'],
    personalFields: ['description', 'mitigation', 'owner'],
    titleFields: ['title'],
    tenantScoped: true,
    refPath: 'risk-record',
    orderBy: { createdAt: 'desc' },
  },
  ComplaintRecord: {
    delegate: 'complaintRecord',
    completePlanOnly: true,
    safeFields: ['boardMinuteReference'],
    personalFields: ['summary', 'source', 'actionTaken', 'outcome'],
    titleFields: ['boardMinuteReference'],
    fullTitleFields: ['summary'],
    tenantScoped: true,
    refPath: 'complaint-record',
    orderBy: { receivedDate: 'desc' },
  },
  FundraisingRecord: {
    delegate: 'fundraisingRecord',
    completePlanOnly: true,
    safeFields: ['name', 'activityType', 'boardMinuteReference'],
    personalFields: ['thirdPartyFundraiser', 'controls', 'reviewOutcome'],
    titleFields: ['name'],
    tenantScoped: true,
    refPath: 'fundraising-record',
    orderBy: { createdAt: 'desc' },
  },
  Document: {
    // `fileUrl` is absent deliberately. It is the storage path, it encodes the
    // original filename, and it must never leave the API.
    delegate: 'document',
    safeFields: ['name', 'boardMinuteReference'],
    personalFields: ['description', 'owner'],
    titleFields: ['name'],
    tenantScoped: true,
    refPath: 'document',
    orderBy: { createdAt: 'desc' },
  },
  Deadline: {
    delegate: 'deadline',
    safeFields: ['title'],
    personalFields: ['description'],
    titleFields: ['title'],
    tenantScoped: true,
    refPath: 'deadline',
    orderBy: { dueDate: 'asc' },
  },
  GovernanceStandard: {
    // The Governance Code itself: the same text for every charity in Ireland,
    // with nothing personal in it and no tenant to scope it to.
    delegate: 'governanceStandard',
    safeFields: ['code', 'title'],
    personalFields: [],
    titleFields: ['title', 'code'],
    tenantScoped: false,
    refPath: 'standard',
    orderBy: { sortOrder: 'asc' },
  },
};

export const SEARCH_TYPES = Object.keys(SEARCHABLE) as SearchType[];

/** Below this, a query matches most of the charity and answers nothing. */
export const SEARCH_MIN_QUERY_LENGTH = 2;
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;

/** How much of a long field is quoted back around the match. */
const SNIPPET_RADIUS = 60;

export interface SearchHit {
  type: SearchType;
  id: string;
  title: string | null;
  /** Which column matched, so a caller can tell a name from a note. */
  field: string;
  /** The matching text, in its own casing, with long fields trimmed. */
  snippet: string;
  /** Pass this to the fetch tool to read the whole record. */
  ref: string;
}

export interface SearchResult {
  query: string;
  dataScope: 'WITHHELD' | 'FULL';
  data: SearchHit[];
  /** Kinds that returned as many as were asked for and may hold more. */
  truncated: SearchType[];
  /** Kinds actually looked in, after the requested filter and the plan. */
  searched: SearchType[];
  note?: string;
  /** Said when a kind was left out because of the plan rather than the query. */
  planNote?: string;
}

/**
 * The window of a long field around the first match.
 *
 * Ellipses are the plain three dots rather than the single character, because
 * this text is read back by models and by people in terminals.
 */
function snippetOf(value: string, at: number, queryLength: number): string {
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(value.length, at + queryLength + SNIPPET_RADIUS);
  return (
    (start > 0 ? '...' : '')
    + value.slice(start, end).replace(/\s+/g, ' ').trim()
    + (end < value.length ? '...' : '')
  );
}

/** Long enough to recognise a record, short enough to list a page of them. */
const MAX_TITLE_LENGTH = 120;

/**
 * The first named field with something in it, bounded.
 *
 * Some of these titles come from free text — a resolution is known by what it
 * says — so an unbounded one would put a paragraph where a line belongs.
 */
function titleOf(row: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = row[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (trimmed.length === 0) continue;
    return trimmed.length > MAX_TITLE_LENGTH
      ? `${trimmed.slice(0, MAX_TITLE_LENGTH)}...`
      : trimmed;
  }
  return null;
}

/**
 * Which column matched, and the text around it.
 *
 * Only ever passed the columns this scope is allowed to see, so the answer
 * cannot quote something a read of the same record would withhold. A row that
 * matched in the database but shows no match here is dropped rather than
 * returned with an empty snippet: Postgres and JavaScript disagree about
 * case for a few characters, and a hit nobody can see the reason for is
 * worse than no hit.
 */
function matchIn(
  row: Record<string, unknown>,
  fields: readonly string[],
  needle: string,
): { field: string; snippet: string } | null {
  const lowered = needle.toLowerCase();

  for (const field of fields) {
    const value = row[field];
    if (typeof value !== 'string') continue;
    const at = value.toLowerCase().indexOf(lowered);
    if (at === -1) continue;
    return { field, snippet: snippetOf(value, at, needle.length) };
  }
  return null;
}

export interface SearchOptions {
  /** Which kinds to look in. Absent means all of them. */
  types?: readonly SearchType[];
  limit?: number;
  /** The session's scope, which decides what may be matched at all. */
  dataScope: 'WITHHELD' | 'FULL';
}

export class SearchService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Whether this charity's plan reaches the Governance Code's additional
   * standards. Mirrors the compliance service's own rule, so a search cannot
   * surface a standard the compliance pages would not show.
   */
  private async planScope(organisationId: string): Promise<{
    complete: boolean;
    additionalStandards: boolean;
  }> {
    const [organisation, subscription] = await Promise.all([
      this.prisma.organisation.findUnique({
        where: { id: organisationId },
        select: { complexity: true },
      }),
      this.prisma.subscription.findUnique({
        where: { organisationId },
        select: { plan: true },
      }),
    ]);

    const complete = subscription?.plan === 'COMPLETE';
    return {
      complete,
      additionalStandards: complete && organisation?.complexity === 'COMPLEX',
    };
  }

  async search(
    organisationId: string,
    rawQuery: string,
    options: SearchOptions,
  ): Promise<SearchResult> {
    const query = rawQuery.trim();

    // `%` and `_` are wildcards to the database underneath, and there is no
    // way to escape them through this query builder. A query made only of
    // them matches every row of every table, which is not a search.
    if (query.replace(/[%_\s]/g, '').length < SEARCH_MIN_QUERY_LENGTH) {
      throw new AppError(
        400,
        'SEARCH_QUERY_TOO_SHORT',
        `Give at least ${SEARCH_MIN_QUERY_LENGTH} characters to search for. `
          + 'Per cent and underscore are wildcards here and do not count.',
      );
    }

    const limit = Math.min(
      SEARCH_MAX_LIMIT,
      Math.max(1, options.limit ?? SEARCH_DEFAULT_LIMIT),
    );
    const requested = options.types?.length ? options.types : SEARCH_TYPES;
    const full = options.dataScope === 'FULL';

    // One lookup for both questions the plan decides: which kinds may be
    // searched at all, and how much of the Governance Code is in scope.
    const plan = await this.planScope(organisationId);

    const data: SearchHit[] = [];
    const truncated: SearchType[] = [];
    const searched: SearchType[] = [];

    for (const type of requested) {
      const spec = SEARCHABLE[type];

      // Left out of `searched` as well as out of the results: a charity on
      // the smaller plan should see that the minute book was not looked in,
      // not be told there is nothing in it.
      if (spec.completePlanOnly && !plan.complete) continue;

      const fields = full ? [...spec.safeFields, ...spec.personalFields] : spec.safeFields;

      // A kind with nothing searchable under this scope is left out of
      // `searched`, so the caller can see that the gate, not the query, is
      // why nothing came back from it.
      if (fields.length === 0) continue;
      searched.push(type);

      const where: Record<string, unknown> = {
        ...(spec.tenantScoped ? { organisationId } : {}),
        ...(type === 'GovernanceStandard' && !plan.additionalStandards
          ? { isCore: true }
          : {}),
        OR: fields.map((field) => ({
          [field]: { contains: query, mode: 'insensitive' },
        })),
      };

      const delegate = (this.prisma as unknown as Record<string, {
        findMany: (args: unknown) => Promise<Record<string, unknown>[]>;
      }>)[spec.delegate];

      const rows = await delegate.findMany({
        where,
        // One more than asked for, purely to know whether to say there are
        // more. The extra row is never returned.
        take: limit + 1,
        orderBy: spec.orderBy,
      });

      if (rows.length > limit) truncated.push(type);

      for (const row of rows.slice(0, limit)) {
        const match = matchIn(row, fields, query);
        if (!match) continue;

        data.push({
          type,
          id: String(row.id),
          // Built only from fields this scope may quote, so a hit's own title
          // cannot be the leak.
          title: titleOf(
            row,
            full && spec.fullTitleFields
              ? [...spec.fullTitleFields, ...spec.titleFields]
              : spec.titleFields,
          ),
          field: match.field,
          snippet: match.snippet,
          ref: `charitypilot://${spec.refPath}/${String(row.id)}`,
        });
      }
    }

    const result: SearchResult = {
      query,
      dataScope: options.dataScope,
      data,
      truncated,
      searched,
    };

    if (!plan.complete) {
      result.planNote =
        'The minute book and the four governance registers are on the Complete plan and '
        + 'were not searched.';
    }

    if (!full) {
      result.note =
        'This session withholds personal data, so free-text notes, narratives and names '
        + 'were not searched and cannot be matched. Connect with personal data released to '
        + 'search them.';
    }

    return result;
  }
}
