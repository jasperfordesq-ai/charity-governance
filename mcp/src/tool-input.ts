/**
 * Input validation for tool arguments, hand-written on purpose.
 *
 * The connector has two runtime dependencies and that is a stated security
 * property: every dependency is code that runs on the operator's machine with
 * their credential within reach. The inputs here are integers, enums and
 * opaque identifiers, which is not enough surface to justify a third.
 *
 * Validation denies by default in both directions. An argument the tool does
 * not declare is refused rather than ignored, because silently ignoring one
 * would let a caller believe a filter had been applied when it had not — a
 * model asking for page 2 and being handed page 1 again would have no way to
 * tell.
 */
export type ParamSpec =
  | { kind: 'page' }
  | { kind: 'pageSize' }
  | { kind: 'year' }
  | { kind: 'enum'; name: string; values: readonly string[] }
  | { kind: 'flag'; name: string }
  | { kind: 'id'; name: string }
  /** Free text the caller writes, bounded and required. */
  | { kind: 'text'; name: string; max: number; describe: string }
  /** Several of a fixed set at once, sent as one comma-separated value. */
  | { kind: 'enumList'; name: string; values: readonly string[]; describe: string }
  /** A whole number the caller chooses, within a stated range. */
  | { kind: 'count'; name: string; min: number; max: number; describe: string };

/**
 * A path parameter is interpolated into a URL path, so the character set is
 * the guard rather than escaping applied afterwards: with no slash, dot,
 * question mark or hash, the value cannot open a new path segment, traverse
 * upwards into another route, or begin a query string, however it is
 * concatenated downstream.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

export function paramName(spec: ParamSpec): string {
  switch (spec.kind) {
    case 'page':
      return 'page';
    case 'pageSize':
      return 'pageSize';
    case 'year':
      return 'year';
    default:
      return spec.name;
  }
}

function integerIn(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}.`);
  }
  return value;
}

export function inputSchemaFor(params: readonly ParamSpec[]): object {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const spec of params) {
    const name = paramName(spec);
    switch (spec.kind) {
      case 'page':
        properties[name] = { type: 'integer', minimum: 1, description: 'Page number, from 1.' };
        break;
      case 'pageSize':
        properties[name] = {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Records per page, up to 100.',
        };
        break;
      case 'year':
        properties[name] = {
          type: 'integer',
          minimum: 2000,
          maximum: 2200,
          description: 'Reporting year.',
        };
        break;
      case 'enum':
        properties[name] = { type: 'string', enum: [...spec.values] };
        break;
      case 'flag':
        properties[name] = { type: 'boolean' };
        break;
      case 'id':
        properties[name] = {
          type: 'string',
          description: 'Identifier as returned by the matching list tool.',
        };
        required.push(name);
        break;
      case 'text':
        properties[name] = {
          type: 'string',
          minLength: 1,
          maxLength: spec.max,
          description: spec.describe,
        };
        required.push(name);
        break;
      case 'enumList':
        properties[name] = {
          type: 'array',
          items: { type: 'string', enum: [...spec.values] },
          description: spec.describe,
        };
        break;
      case 'count':
        properties[name] = {
          type: 'integer',
          minimum: spec.min,
          maximum: spec.max,
          description: spec.describe,
        };
        break;
    }
  }

  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) schema.required = required;
  return schema;
}

export function buildPath(
  path: string,
  params: readonly ParamSpec[],
  args: Record<string, unknown>,
): string {
  const declared = new Set(params.map(paramName));
  for (const key of Object.keys(args)) {
    if (!declared.has(key)) {
      const accepted = [...declared].join(', ');
      throw new Error(
        `Unknown argument "${key}". This tool accepts: ${accepted.length > 0 ? accepted : 'no arguments'}.`,
      );
    }
  }

  let out = path;
  const query: string[] = [];

  for (const spec of params) {
    const name = paramName(spec);
    const value = args[name];

    if (spec.kind === 'id') {
      if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
        throw new Error(
          `${name} must be an identifier of letters, digits, hyphens or underscores.`,
        );
      }
      out = out.replace(`:${name}`, value);
      continue;
    }

    // Checked before the skip below, because free text is required: an
    // absent `q` is a caller that forgot to say what it was looking for,
    // not a filter left off, and sending the request without it would put
    // the refusal at the far end of a round trip.
    if (spec.kind === 'text') {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${name} must be some text to look for.`);
      }
      if (value.length > spec.max) {
        throw new Error(`${name} must be at most ${spec.max} characters.`);
      }
      query.push(`${name}=${encodeURIComponent(value)}`);
      continue;
    }

    if (value === undefined) continue;

    switch (spec.kind) {
      case 'page':
        query.push(`page=${integerIn(name, value, 1, Number.MAX_SAFE_INTEGER)}`);
        break;
      case 'pageSize':
        query.push(`pageSize=${integerIn(name, value, 1, 100)}`);
        break;
      case 'year':
        query.push(`year=${integerIn(name, value, 2000, 2200)}`);
        break;
      case 'enum':
        if (typeof value !== 'string' || !spec.values.includes(value)) {
          throw new Error(`${name} must be one of: ${spec.values.join(', ')}.`);
        }
        query.push(`${name}=${encodeURIComponent(value)}`);
        break;
      case 'flag':
        if (typeof value !== 'boolean') throw new Error(`${name} must be true or false.`);
        // The API tests for the literal string "true"; anything else reads as
        // off, so a false flag is omitted rather than sent as "false".
        if (value) query.push(`${name}=true`);
        break;
      case 'enumList': {
        if (!Array.isArray(value)) throw new Error(`${name} must be a list.`);
        const unknown = value.filter(
          (entry) => typeof entry !== 'string' || !spec.values.includes(entry),
        );
        if (unknown.length > 0) {
          throw new Error(
            `${name} may only contain: ${spec.values.join(', ')}. `
            + `Received: ${unknown.map((entry) => String(entry)).join(', ')}.`,
          );
        }
        // An empty list means the same as not asking, so it is not sent:
        // an empty `types=` would otherwise read as a filter matching nothing.
        if (value.length > 0) {
          query.push(`${name}=${value.map((entry) => encodeURIComponent(String(entry))).join(',')}`);
        }
        break;
      }
      case 'count':
        query.push(`${name}=${integerIn(name, value, spec.min, spec.max)}`);
        break;
    }
  }

  if (out.includes('/:')) {
    throw new Error(`Path parameter missing for ${path}.`);
  }
  return query.length > 0 ? `${out}?${query.join('&')}` : out;
}
