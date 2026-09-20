import type { FastifyReply } from 'fastify';
import { buildErrorAlertPayload, sendErrorAlert, shouldSendErrorAlert } from '../services/error-alerts.service.js';
import { serializeErrorForLog } from './logger.js';
import { AppError } from './app-error.js';

// Re-exported so the many `from '../utils/errors.js'` imports keep working;
// the class moved out only so that pure modules can throw it without pulling
// fastify in. See ./app-error.ts.
export { AppError };

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function reportHandledServerError(
  reply: FastifyReply,
  error: Error & { code?: string },
  statusCode: number,
): void {
  if (statusCode < 500) return;

  reply.request.log.error(
    { safeError: serializeErrorForLog(error), statusCode },
    'Route-caught request failed',
  );

  if (!shouldSendErrorAlert(statusCode)) return;

  const payload = buildErrorAlertPayload(error, reply.request, statusCode);
  void sendErrorAlert(payload).catch((alertError) => {
    reply.request.log.error(
      { safeError: serializeErrorForLog(alertError), statusCode },
      'Failed to send error alert webhook',
    );
  });
}

/**
 * Both of these return the reply, and every caller must return what they
 * return.
 *
 * Fastify decides an async handler has answered by looking at what its promise
 * resolves to. `reply.sent` is `raw.writableEnded`, which is still false while
 * an async `onSend` hook is running, so a handler that sends and then resolves
 * with `undefined` looks to Fastify like a handler that never answered — and
 * Fastify sends again, re-running the whole `onSend` chain over a response
 * whose head is already written.
 *
 * Returning `void` from here made that impossible to fix at the call site:
 * `return handleError(reply, err)` still resolves `undefined`. Returning the
 * reply works because `Reply` is itself a thenable whose `then` waits for the
 * response to finish, so the handler's promise cannot settle until the answer
 * is fully out. `tests/routes-answer-once.test.ts` holds the behaviour and
 * `tests/guards-stop-the-request.test.ts` holds the call sites.
 */
export function sendError(reply: FastifyReply, error: AppError): FastifyReply {
  reportHandledServerError(reply, error, error.statusCode);

  const exposeMessage = error.statusCode < 500 || !isProduction();
  const payload: {
    error: string;
    code: string;
    details?: unknown;
  } = {
    error: exposeMessage ? error.message : 'Internal server error',
    code: exposeMessage ? error.code : 'INTERNAL_ERROR',
  };

  if (error.details !== undefined && exposeMessage) {
    payload.details = error.details;
  }

  return reply.status(error.statusCode).send(payload);
}

export function handleError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AppError) {
    return sendError(reply, err);
  }

  const error = err instanceof Error ? err : new Error('Unexpected non-error exception');
  reportHandledServerError(reply, error, 500);

  return reply.status(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
}
