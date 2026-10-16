import { z } from 'zod';
import type { ConfluenceClient } from './confluence-client.js';
import { AppError } from '../utils/app-error.js';

const input = z.object({
  action: z.enum(['TRASH', 'PURGE']),
  pageId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
}).strict();
type Outcome = 'ACKNOWLEDGED' | 'REFUSED' | 'UNRESOLVED';

/** Internal transport primitive, not a permission consumer or execution API.
 * A future coordinator must durably consume exact current authority before
 * invoking this once, and preserve/reconcile uncertain outcomes after restart.
 * Never use acknowledgement or a 404 as proof of absence, purge or all copies.
 * The separate ordinary-erasure helpers intentionally retain their old policy.
 */
export async function requestRetainedConfluenceCopyMutationOnce(client: ConfluenceClient, raw: unknown) {
  const target = input.parse(raw);
  let requestOutcome: Outcome = 'UNRESOLVED';
  try {
    const response = await client.request({ method: 'DELETE', api: 'v2',
      path: `pages/${target.pageId}`,
      ...(target.action === 'PURGE' ? { query: { purge: 'true' } } : {}),
      idempotent: false,
    });
    if (response.status === 204) requestOutcome = 'ACKNOWLEDGED';
  } catch (error) {
    // Keep raw provider error bodies, credentials and transport details out of
    // the durable outcome. Even a missing target requires separate readback.
    if (error instanceof AppError && error.code === 'CONFLUENCE_RECONNECT_REQUIRED'
      && error.details !== null && typeof error.details === 'object'
      && 'status' in error.details && (error.details.status === 401 || error.details.status === 403)) {
      requestOutcome = 'REFUSED';
    }
  }
  return { requestOutcome, automaticRetryAllowed: false as const,
    providerAbsenceVerified: false as const, allCopiesVerified: false as const };
}
