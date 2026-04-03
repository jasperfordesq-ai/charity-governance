import type { FastifyReply } from 'fastify';

/**
 * Standard API response wrapper.
 * All successful responses use: { data, ...meta }
 * List responses add: { data, total, page, pageSize, hasMore }
 */
export function sendSuccess<T>(reply: FastifyReply, data: T, status = 200) {
  return reply.status(status).send({ data });
}

export function sendCreated<T>(reply: FastifyReply, data: T) {
  return reply.status(201).send({ data });
}

export function sendNoContent(reply: FastifyReply) {
  return reply.status(204).send();
}
