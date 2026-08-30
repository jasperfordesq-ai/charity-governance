import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isPersonalServerDeployment } from '../../utils/personal-server.js';
import { ownerAuthRoutes } from './auth.js';

// Optional extra tightening: when OWNER_ALLOWED_ORIGINS is set, the console
// answers only requests from those origins, so it can be moved behind Tailscale
// or a private hostname later without a rewrite. Unset means "same policy as the
// tenant app", so this is opt-in hardening and never a deployment blocker.
function ownerOriginGuard(app: FastifyInstance): void {
  const configured = process.env.OWNER_ALLOWED_ORIGINS?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!configured?.length) return;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    // A same-origin, non-CORS request sends no Origin header; the existing
    // browser-origin-protection plugin already covers unsafe methods there.
    if (!origin) return;
    if (!configured.includes(origin)) {
      reply.status(403).send({ error: 'Not found', code: 'OWNER_ORIGIN_REJECTED' });
    }
  });
}

export async function ownerRoutes(app: FastifyInstance): Promise<void> {
  // Single-charity installs must not expose a platform console at all. Returning
  // before registering anything means every owner path 404s naturally.
  if (isPersonalServerDeployment()) return;

  ownerOriginGuard(app);
  await app.register(ownerAuthRoutes);
}
