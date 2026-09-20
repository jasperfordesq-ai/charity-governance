import type { ApiClient } from './client.js';
import { ConnectorError } from './errors.js';
import { REFERENCE_SCHEME, resolveReference } from './references.js';

/**
 * Context a client can attach without being asked.
 *
 * Tools answer a question; a resource is something a person or a client
 * chooses to put in front of the model before any question is asked. The two
 * things worth holding for a whole conversation are the Governance Code and
 * the regulator guidance behind it: both are reference data, both are the
 * frame every other answer is judged against, and neither changes during a
 * session.
 *
 * Records are deliberately not listed here. There may be thousands, listing
 * them would be a second, worse search, and `search` with `fetch` already
 * reaches any of them. A record is offered as a resource template instead, so
 * a client that wants to attach one by reference can, using the same
 * `charitypilot://` reference search hands out.
 */
export interface ResourceDescriptor {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

export const GOVERNANCE_CODE_URI = 'charitypilot://governance-code';
export const REGULATOR_GUIDANCE_URI = 'charitypilot://regulator-guidance';

export const RESOURCES: readonly ResourceDescriptor[] = [
  {
    uri: GOVERNANCE_CODE_URI,
    name: 'governance-code',
    title: 'Charities Governance Code',
    description:
      'The six principles and their standards, with this charity’s recorded status against '
      + 'each one. Reference data plus where this charity stands.',
    mimeType: 'application/json',
  },
  {
    uri: REGULATOR_GUIDANCE_URI,
    name: 'regulator-guidance',
    title: 'Irish regulator guidance',
    description:
      'What each Governance Code standard asks for under Irish law: whether the obligation is '
      + 'in force, the evidence it wants, whether a board must approve it, which specialist '
      + 'should review it, and the sources. The same for every charity in Ireland.',
    mimeType: 'application/json',
  },
];

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: `${REFERENCE_SCHEME}{kind}/{id}`,
    name: 'record',
    title: 'One CharityPilot record',
    description:
      'Any record the search tool returned, by its reference. The same fields the tool for '
      + 'that kind of record would return, with the same ones withheld.',
    mimeType: 'application/json',
  },
];

interface Read {
  uri: string;
  mimeType: string;
  text: string;
}

/**
 * The route behind each fixed resource.
 *
 * Both are reads of reference data, so neither needs the field policy: the
 * Governance Code carries this charity's own compliance status, which is
 * governance rather than personal data, and the guidance carries nothing
 * about anybody at all.
 */
const FIXED: Record<string, string> = {
  [GOVERNANCE_CODE_URI]: '/api/v1/compliance/principles',
  [REGULATOR_GUIDANCE_URI]: '/api/v1/compliance/guidance',
};

export function isFixedResource(uri: string): boolean {
  return uri in FIXED;
}

/**
 * Reads one resource.
 *
 * A record reference is handed to `runRecord`, which the server wires to its
 * own tool dispatch, so reading a record as a resource goes through the same
 * level check, toolset check and personal-data gate as reading it as a tool.
 * A resource that quietly skipped those would be a way around them.
 */
export async function readResource(
  uri: string,
  client: ApiClient,
  runRecord: (tool: string, args: Record<string, string>) => Promise<unknown>,
): Promise<Read> {
  const path = FIXED[uri];
  if (path !== undefined) {
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(await client.get<unknown>(path), null, 2),
    };
  }

  if (!uri.startsWith(REFERENCE_SCHEME)) {
    throw new ConnectorError(
      'RESOURCE_UNKNOWN',
      `"${uri}" is not a CharityPilot resource. List the resources to see what there is.`,
    );
  }

  const target = resolveReference(uri);
  return {
    uri,
    mimeType: 'application/json',
    text: JSON.stringify(await runRecord(target.tool, target.args), null, 2),
  };
}
