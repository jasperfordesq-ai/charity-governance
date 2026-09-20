import { ApiError, ApprovalRequiredError } from './client.js';
import { NotConnectedError } from './session.js';
import { FileAccessError } from './files.js';
import { ConnectorError } from './errors.js';
import { redactSecrets } from './redact.js';

/**
 * How a value, or a thrown error, becomes a tool result.
 *
 * Every result carries the same object twice: as text, for clients that read
 * only text, and as structured content, for clients that can branch on it.
 * Every error carries a code and what to do next, so an agent can tell an
 * approval refusal from a stale read without parsing prose.
 */
export type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: true;
};

export interface StructuredError {
  code: string;
  retryable: boolean;
  action: string;
  status?: number;
  retryAfterSeconds?: number;
  approvalId?: string;
  command?: string;
  expiresAt?: string;
  resourceId?: string;
}

/** Structured content must be an object; anything else is wrapped as `data`. */
export function asObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { data: value };
}

export function okResult(value: unknown): ToolResult {
  const payload = asObject(value);
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

export function describeError(error: unknown): StructuredError {
  if (error instanceof ApprovalRequiredError) {
    const out: StructuredError = {
      code: error.code,
      retryable: true,
      action: 'approve',
      approvalId: error.approvalId,
      command: error.command,
      expiresAt: error.expiresAt,
    };
    if (error.resourceId) out.resourceId = error.resourceId;
    return out;
  }
  if (error instanceof ApiError) {
    const out: StructuredError = {
      code: error.code ?? `HTTP_${error.status}`,
      retryable: error.retryable,
      action: error.action,
      status: error.status,
    };
    if (error.retryAfterSeconds !== null) out.retryAfterSeconds = error.retryAfterSeconds;
    return out;
  }
  if (error instanceof NotConnectedError) {
    return { code: error.code, retryable: false, action: 'connect' };
  }
  if (error instanceof ConnectorError) {
    return { code: error.code, retryable: error.retryable, action: error.action };
  }
  if (error instanceof FileAccessError) {
    return { code: 'FILE_ACCESS', retryable: false, action: 'fix_arguments' };
  }
  // Everything else thrown inside a tool is the connector's own validation
  // refusing the arguments: an unknown field, a bad date, a missing identifier.
  return { code: 'INVALID_ARGUMENTS', retryable: false, action: 'fix_arguments' };
}

export function errorResult(error: unknown): ToolResult {
  const described = describeError(error);
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text', text: redactSecrets(message) }],
    structuredContent: { ...described },
  };
}
