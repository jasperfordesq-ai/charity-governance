import type { FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { handleError } from '../../utils/errors.js';
import { sendSuccess } from '../../utils/response.js';
import {
  SearchService,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_TYPES,
  type SearchType,
} from '../../services/search.service.js';

const searchQuerySchema = z.object({
  q: z.string().min(1, 'Give something to search for'),
  /**
   * A comma-separated list rather than a repeated parameter, because that is
   * what a URL built by hand looks like and both the connector and the web
   * application build these by hand.
   */
  types: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : value.split(',').map((part) => part.trim()).filter((part) => part.length > 0),
    )
    .pipe(z.array(z.enum(SEARCH_TYPES as [SearchType, ...SearchType[]])).optional()),
  limit: z.coerce.number().int().min(1).max(SEARCH_MAX_LIMIT).optional(),
});

export async function searchRoutes(app: FastifyInstance) {
  const service = new SearchService(app.prisma);

  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);

  app.get('/', async (request, reply) => {
    try {
      const { q, types, limit } = searchQuerySchema.parse(request.query);

      return sendSuccess(
        reply,
        await service.search(request.user.organisationId, q, {
          types,
          limit: limit ?? SEARCH_DEFAULT_LIMIT,
          // Read from the session, never from a parameter. A search that let
          // the caller name its own scope would be a way around the gate
          // rather than a search.
          dataScope: request.authSession?.dataScope ?? 'FULL',
        }),
      );
    } catch (err) {
      if (err instanceof ZodError) {
        return reply
          .status(400)
          .send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });
}
