/**
 * Validation for the bodies of write tools, hand-written for the same reason
 * the argument validation is: every dependency here runs on the operator's
 * machine with their credential within reach, and these are strings, dates,
 * small integers and enumerations.
 *
 * Deny-by-default in both directions, and it matters more on the way in than
 * it did on the way out. A field the tool does not declare is refused rather
 * than forwarded, so a model cannot reach a column the connector never meant
 * to expose by guessing its name. A field the tool declares and the caller
 * omits is simply absent, so a patch never blanks something it was not asked
 * to change.
 */
/**
 * Fields that carry no record content at all.
 *
 * A concurrency stamp and a "yes I mean it" confirmation say something about
 * the request, not about the charity or anyone in it, so the personal-data
 * rules have nothing to say about them. Without this, a tool would be judged
 * to write personal data because it asks which version of a row it is changing.
 */
export type ControlField = { control?: true };

export type FieldSpec = ControlField & (
  | { kind: 'string'; name: string; max: number; min?: number; required?: boolean; describe?: string }
  | { kind: 'date'; name: string; required?: boolean; describe?: string }
  | { kind: 'timestamp'; name: string; required?: boolean; describe?: string }
  | { kind: 'integer'; name: string; min: number; max: number; required?: boolean; describe?: string }
  | { kind: 'boolean'; name: string; required?: boolean; describe?: string }
  | { kind: 'enum'; name: string; values: readonly string[]; required?: boolean; describe?: string }
  | { kind: 'id'; name: string; required?: boolean; describe?: string }
  | { kind: 'dayList'; name: string; required?: boolean; describe?: string }
);

/** A calendar date with no time and no zone, which is what the API accepts. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** An instant with an offset, used for the optimistic-concurrency fields. */
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

export function bodySchemaFor(fields: readonly FieldSpec[]): object {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of fields) {
    const describe = field.describe ? { description: field.describe } : {};
    switch (field.kind) {
      case 'string':
        properties[field.name] = {
          type: 'string',
          maxLength: field.max,
          ...(field.min === undefined ? {} : { minLength: field.min }),
          ...describe,
        };
        break;
      case 'date':
        properties[field.name] = {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: field.describe ?? 'A date, as YYYY-MM-DD.',
        };
        break;
      case 'timestamp':
        properties[field.name] = {
          type: 'string',
          description:
            field.describe
            ?? 'The updatedAt value from the record being changed, exactly as read. '
              + 'CharityPilot refuses the change if the record moved in the meantime.',
        };
        break;
      case 'integer':
        properties[field.name] = {
          type: 'integer',
          minimum: field.min,
          maximum: field.max,
          ...describe,
        };
        break;
      case 'boolean':
        properties[field.name] = { type: 'boolean', ...describe };
        break;
      case 'enum':
        properties[field.name] = { type: 'string', enum: [...field.values], ...describe };
        break;
      case 'id':
        properties[field.name] = {
          type: 'string',
          description: field.describe ?? 'Identifier as returned by the matching read tool.',
        };
        break;
      case 'dayList':
        properties[field.name] = {
          type: 'array',
          items: { type: 'integer', minimum: 1, maximum: 365 },
          description: field.describe ?? 'Days before the due date to send a reminder.',
        };
        break;
    }
    if (field.required) required.push(field.name);
  }

  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) schema['required'] = required;
  return schema;
}

function refuse(name: string, expectation: string): never {
  throw new Error(`${name} ${expectation}`);
}

export function buildBody(
  fields: readonly FieldSpec[],
  args: Record<string, unknown>,
): Record<string, unknown> {
  const declared = new Map(fields.map((field) => [field.name, field]));

  for (const key of Object.keys(args)) {
    if (!declared.has(key)) {
      const accepted = [...declared.keys()].join(', ');
      throw new Error(
        `Unknown field "${key}". This tool accepts: ${accepted.length > 0 ? accepted : 'no fields'}.`,
      );
    }
  }

  const body: Record<string, unknown> = {};

  for (const field of fields) {
    const value = args[field.name];

    if (value === undefined) {
      if (field.required) refuse(field.name, 'is required.');
      // Absent rather than null: a patch must not blank a column it was never
      // asked to change.
      continue;
    }

    switch (field.kind) {
      case 'string': {
        if (typeof value !== 'string') refuse(field.name, 'must be text.');
        if (value.length > field.max) {
          refuse(field.name, `must be ${field.max} characters or fewer.`);
        }
        // Checked here as well as at the API so a caller learns the rule from
        // the refusal rather than from a validation error a round trip later.
        if (field.min !== undefined && value.length < field.min) {
          refuse(field.name, `must be at least ${field.min} characters.`);
        }
        body[field.name] = value;
        break;
      }
      case 'date': {
        if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
          refuse(field.name, 'must be a date as YYYY-MM-DD.');
        }
        body[field.name] = value;
        break;
      }
      case 'timestamp': {
        if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
          refuse(
            field.name,
            'must be the updatedAt value from the record, copied exactly as it was read.',
          );
        }
        body[field.name] = value;
        break;
      }
      case 'integer': {
        if (
          typeof value !== 'number'
          || !Number.isInteger(value)
          || value < field.min
          || value > field.max
        ) {
          refuse(field.name, `must be a whole number between ${field.min} and ${field.max}.`);
        }
        body[field.name] = value;
        break;
      }
      case 'boolean': {
        if (typeof value !== 'boolean') refuse(field.name, 'must be true or false.');
        body[field.name] = value;
        break;
      }
      case 'enum': {
        if (typeof value !== 'string' || !field.values.includes(value)) {
          refuse(field.name, `must be one of: ${field.values.join(', ')}.`);
        }
        body[field.name] = value;
        break;
      }
      case 'id': {
        if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
          refuse(field.name, 'must be an identifier of letters, digits, hyphens or underscores.');
        }
        body[field.name] = value;
        break;
      }
      case 'dayList': {
        if (
          !Array.isArray(value)
          || value.length > 12
          || !value.every(
            (day) => typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 365,
          )
        ) {
          refuse(field.name, 'must be up to twelve whole numbers between 1 and 365.');
        }
        body[field.name] = value;
        break;
      }
    }
  }

  return body;
}
