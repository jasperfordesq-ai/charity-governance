/**
 * Coordinate refreshes made by separate tabs on the same origin. The stamp
 * carries no token, account identifier or other credential. A tab that waited
 * for another successful refresh can use the newly rotated browser cookies.
 */
const REFRESH_LOCK_NAME = 'charitypilot:session-refresh';
const REFRESH_STAMP_KEY = 'charitypilot:session-refresh-stamp';

type LockManagerLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export class SessionRefreshLockUnavailableError extends Error {
  constructor() {
    super('This browser cannot safely coordinate session renewal across tabs. Sign in again.');
    this.name = 'SessionRefreshLockUnavailableError';
  }
}

function readStamp(storage: StorageLike | undefined): string | null {
  try {
    return storage?.getItem(REFRESH_STAMP_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Keep logout's server revocation and cookie clearance in the same
 * cross-tab critical section as refresh. The stamp tells a refresh that was
 * already waiting on the lock to retry its original request without
 * presenting the just-revoked single-use token. It contains no credential.
 */
export async function coordinateSessionLogout(
  logout: () => Promise<void>,
  locks: LockManagerLike | undefined,
  storage: StorageLike | undefined,
  newStamp: () => string = () => crypto.randomUUID(),
): Promise<void> {
  const perform = async () => {
    await logout();
    try {
      storage?.setItem(REFRESH_STAMP_KEY, newStamp());
    } catch {
      // A held Web Lock still serializes callers when storage is unavailable.
    }
  };
  if (locks) await locks.request(REFRESH_LOCK_NAME, perform);
  else await perform();
}

export async function coordinateSessionRefresh(
  refresh: () => Promise<void>,
  locks: LockManagerLike | undefined,
  storage: StorageLike | undefined,
  newStamp: () => string = () => crypto.randomUUID(),
  isSessionCurrent?: () => Promise<boolean>,
): Promise<void> {
  if (!locks) {
    // A reactive retry can arrive after another tab has already rotated the
    // shared cookies. A current access session needs no refresh. If it is
    // expired, neither a probe nor localStorage can serialize simultaneous
    // tabs here. Never present a single-use token without cross-tab locking.
    if (isSessionCurrent && await isSessionCurrent()) return;
    throw new SessionRefreshLockUnavailableError();
  }

  const before = readStamp(storage);
  await locks.request(REFRESH_LOCK_NAME, async () => {
    const after = readStamp(storage);
    if (before !== after && after !== null) return;
    // Another browser request can rotate the shared cookies without updating
    // this tab's stamp. A failed storage write can also leave an old non-null
    // stamp in place. For reactive retries, verify the current cookie under
    // the lock before presenting a single-use token.
    // Proactive renewals omit this check because a still-valid access token
    // does not prove that its requested extension already happened.
    if (isSessionCurrent && await isSessionCurrent()) return;
    await refresh();
    try {
      storage?.setItem(REFRESH_STAMP_KEY, newStamp());
    } catch {
      // The lock still serializes refresh calls if storage is unavailable.
    }
  });
}
