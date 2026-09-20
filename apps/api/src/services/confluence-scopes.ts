/**
 * The Atlassian scopes CharityPilot asks for, and the ones each action needs.
 *
 * A SERVICE-LAYER MODULE for the reason `document-upload-limits.ts` is one: a
 * scope requirement is a fact about the integration, not about HTTP, and the
 * owner console's health view needs it without reaching into `routes/`.
 * `routes/integrations/index.ts` re-exports all three names, so every existing
 * import site keeps working.
 */

/**
 * The granular Confluence scopes, plus `offline_access`.
 *
 * **`offline_access` is not optional and is not decoration.** Without it
 * Atlassian issues no refresh token at all, the access token dies within the
 * hour, and every connected charity is silently disconnected before lunchtime
 * with nothing able to renew it. `connectConfluence` refuses a connection whose
 * exchange produced no refresh token for exactly this reason; this list is what
 * stops that refusal ever being reached.
 */
export const CONFLUENCE_OAUTH_SCOPES = [
  'read:page:confluence',
  'write:page:confluence',
  // Atlassian's v2 DELETE /pages/{id} requires this, and the purge that follows
  // it requires it too. Without it an erasure 403s, and confluence-client maps
  // a 403 to CONFLUENCE_RECONNECT_REQUIRED — a wrong diagnosis that would be
  // retried to dead-letter.
  'delete:page:confluence',
  'read:attachment:confluence',
  'write:attachment:confluence',
  'delete:attachment:confluence',
  'read:space:confluence',
  'read:content-details:confluence',
  'offline_access',
] as const;

/**
 * The scopes the explicit erasure workflow cannot proceed without.
 *
 * Deliberately narrower than `CONFLUENCE_OAUTH_SCOPES`: this is the set a
 * *request* is gated on, not the set we ask for. `search:confluence` is not
 * requested at all, even though the audit's CQL work would want it — the DPO's
 * standing ask is narrowest scopes, and a scope we do not yet use is one we
 * should not yet hold.
 */
export const CONFLUENCE_REQUIRED_ERASURE_SCOPES = [
  'delete:page:confluence',
  'delete:attachment:confluence',
] as const;

/**
 * What a connection is missing before it can erase.
 *
 * The single most common cause of an integration that looks healthy and cannot
 * erase: a charity that authorised before the delete scopes were added has a
 * working connection with a missing permission, and nothing about
 * `status: CONNECTED` says so.
 */
export function missingConfluenceScopes(granted: readonly string[]): string[] {
  const held = new Set(granted);
  return CONFLUENCE_REQUIRED_ERASURE_SCOPES.filter((scope) => !held.has(scope));
}
