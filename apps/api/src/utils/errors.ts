import type { FastifyReply } from 'fastify';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function sendError(reply: FastifyReply, error: AppError): void {
  reply.status(error.statusCode).send({
    error: error.message,
    code: error.code,
    details: error.details,
  });
}

export function handleError(reply: FastifyReply, err: unknown): void {
  if (err instanceof AppError) {
    sendError(reply, err);
    return;
  }
  reply.status(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
}
