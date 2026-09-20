import type { SessionPosture } from './session-level.js';

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
export function formatStatus(
  me: StatusIdentity,
  posture: SessionPosture | null,
  allowPersonalData: boolean,
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
  );
}
