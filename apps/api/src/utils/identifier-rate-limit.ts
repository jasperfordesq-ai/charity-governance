import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';

function bodyRecord(request: FastifyRequest): Record<string, unknown> {
  return request.body && typeof request.body === 'object' && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {};
}

function normaliseIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed.slice(0, 320) : null;
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function bodyIdentifierRateLimit(fields: string[], max = 5) {
  return {
    max,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator(request: FastifyRequest) {
      const body = bodyRecord(request);
      const identifier = fields
        .map((field) => normaliseIdentifier(body[field]))
        .find((value): value is string => Boolean(value)) ?? 'missing-identifier';

      return `${request.ip}:${digest(identifier)}`;
    },
  };
}
