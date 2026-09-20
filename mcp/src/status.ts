import type { SessionPosture } from './session-level.js';
import type { StoredCredential } from './credentials.js';

export interface StatusIdentity {
  email: string;
  name: string;
  role: string;
  organisation?: { name?: string } | null;
}

/**
 * What `status` prints.
 *
 * The level comes from the API, because that is where it is held. It used to
 * print the flag the process was started with, which defaults to write, so a
 * credential connected at read level was reported as WRITE by anyone who ran
 * status without repeating the flag.
 */
function formatCredentials(
  credentials: readonly StoredCredential[],
  currentOrigin: string,
): string {
  const held = credentials.filter((credential) => credential.present);
  // One credential is the ordinary case and needs no explaining. The block
  // exists for the operator who has connected to more than one host and would
  // otherwise have no way to tell, because `disconnect` acts on whichever one
  // the base URL names.
  if (held.length <= 1) return '';

  const lines = held.map((credential) => {
    const here = credential.origin === currentOrigin.toLowerCase() ? '  (this one)' : '';
    return `  ${credential.origin}${here}`;
  });

  return (
    `\nThis machine holds credentials for:\n${lines.join('\n')}\n`
    + 'Every command acts on whichever host --base-url names.\n'
  );
}

export function formatStatus(
  me: StatusIdentity,
  posture: SessionPosture | null,
  allowPersonalData: boolean,
  /** Presence per host, never a token. Empty means nothing was looked up. */
  credentials: readonly StoredCredential[] = [],
  currentOrigin = '',
): string {
  const level = posture
    ? posture.accessLevel.toUpperCase()
    : 'unknown (this API predates the session route, so the level it holds cannot be read)';

  // The scope belongs to the session, so it is reported from the session. An
  // API too old to hold one falls back to the flag this process was started
  // with, and says which it is reading.
  const scope =
    posture?.dataScope === 'full'
      ? 'ALLOWED by this session'
      : posture?.dataScope === 'withheld'
        ? 'withheld by this session'
        : `${allowPersonalData ? 'ALLOWED' : 'withheld'} by this process (this API holds no scope)`;

  return (
    `Connected as ${me.name} <${me.email}> (${me.role})\n`
    + `Organisation: ${me.organisation?.name ?? '(unnamed organisation)'}\n`
    + `Access level: ${level}\n`
    + `Personal data: ${scope}\n`
    + formatCredentials(credentials, currentOrigin)
  );
}
