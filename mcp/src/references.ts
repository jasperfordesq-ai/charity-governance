import { ConnectorError } from './errors.js';
import type { ToolAnnotations } from './tools.js';

/**
 * Reading the record a search found.
 *
 * Search answers with references rather than with whole records, because a
 * page of hits across ten kinds would be a page of ten different shapes, most
 * of it unread. A reference says which tool reads it, and this turns one into
 * that call.
 *
 * It is a router and nothing more. The tool it names does the work, so the
 * level check, the toolset check and the personal-data gate all happen in the
 * one place they already happen, rather than a second time here where they
 * could come to disagree.
 */
export const REFERENCE_SCHEME = 'charitypilot://';

interface Target {
  /** The read tool that answers for this kind. */
  readonly tool: string;
  /** What that tool calls its identifier. */
  readonly arg: string;
}

/**
 * Every kind of reference the API's search route can hand out.
 *
 * Kept as data rather than derived, so a kind added at the API that nobody
 * mapped here is caught by the test that compares the two lists rather than
 * by an agent following a reference into a refusal.
 */
export const REFERENCE_TARGETS: Record<string, Target> = {
  'board-member': { tool: 'board_member_get', arg: 'id' },
  'governing-act': { tool: 'governing_act_get', arg: 'id' },
  resolution: { tool: 'resolution_get', arg: 'id' },
  'conflict-record': { tool: 'conflict_get', arg: 'id' },
  'risk-record': { tool: 'risk_get', arg: 'id' },
  'complaint-record': { tool: 'complaint_get', arg: 'id' },
  'fundraising-record': { tool: 'fundraising_get', arg: 'id' },
  document: { tool: 'document', arg: 'id' },
  deadline: { tool: 'deadline_get', arg: 'id' },
  // A standard is the Governance Code's own text, and what a charity wants to
  // know about one is its own position against it, which is what this reads.
  standard: { tool: 'compliance_record', arg: 'standardId' },
};

/**
 * The same character set the path parameters use.
 *
 * A reference is interpolated into a URL path downstream, so the character set
 * is the guard rather than escaping applied later: with no slash, dot,
 * question mark or hash, it cannot open a new path segment, traverse into
 * another route, or begin a query string.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

export const FETCH_TOOL = {
  name: 'fetch',
  description:
    'Read the whole record behind a reference returned by the search tool, such as '
    + 'charitypilot://governing-act/abc123. The record comes back exactly as the tool for '
    + 'its own kind would return it, with the same fields withheld.',
  inputSchema: {
    type: 'object',
    properties: {
      ref: {
        type: 'string',
        description: 'A reference as search returned it, beginning charitypilot://',
      },
    },
    required: ['ref'],
    additionalProperties: false,
  },
  annotations: {
    title: 'Fetch a record',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } satisfies ToolAnnotations,
};

export interface ResolvedReference {
  tool: string;
  args: Record<string, string>;
}

function refuse(message: string): never {
  throw new ConnectorError('REFERENCE_INVALID', message);
}

/**
 * Turns a reference into the tool call that reads it.
 *
 * Refuses rather than guesses. A reference the connector cannot place is far
 * more likely to be one a model wrote from memory than a real one, and
 * answering it with the nearest record would be worse than answering nothing.
 */
export function resolveReference(value: unknown): ResolvedReference {
  if (typeof value !== 'string' || value.trim().length === 0) {
    refuse('Give the ref from a search hit, such as charitypilot://document/abc123.');
  }

  const reference = value.trim();
  if (!reference.startsWith(REFERENCE_SCHEME)) {
    refuse(
      `A reference begins ${REFERENCE_SCHEME}. Search returns them; they are not written by hand.`,
    );
  }

  const rest = reference.slice(REFERENCE_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash === -1) {
    refuse(`"${reference}" names no record. A reference is ${REFERENCE_SCHEME}<kind>/<id>.`);
  }

  const kind = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  const target = REFERENCE_TARGETS[kind];

  if (!target) {
    refuse(
      `"${kind}" is not a kind of record this connector reads. It reads: `
      + `${Object.keys(REFERENCE_TARGETS).sort().join(', ')}.`,
    );
  }

  if (!ID_PATTERN.test(id)) {
    refuse(
      'The identifier in that reference is not one CharityPilot issues. Take the ref from a '
      + 'search hit rather than composing one.',
    );
  }

  return { tool: target.tool, args: { [target.arg]: id } };
}
