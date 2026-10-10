/**
 * Coordinate refreshes made by separate tabs on the same origin. The stamp
 * carries no token, account identifier or other credential. A tab that waited
 * for another successful refresh can use the newly rotated browser cookies.
 */
const REFRESH_LOCK_NAME = 'charitypilot:session-refresh';
const REFRESH_STAMP_KEY = 'charitypilot:session-refresh-stamp';
const LOGOUT_FENCE_PREFIX = 'logout:';
const UNCERTAIN_REFRESH_FENCE_PREFIX = 'refresh-uncertain:';
const IN_FLIGHT_REFRESH_PREFIX = 'probe:';
const SAFE_REFRESH_REFUSAL_PREFIX = 'refresh-refused:';

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

export class SessionReauthenticationRequiredError extends Error {
  constructor() {
    super('This session may have been revoked or rotated. Sign in again.');
    this.name = 'SessionReauthenticationRequiredError';
  }
}

function isReauthenticationFence(stamp: string | null): boolean {
  return stamp?.startsWith(LOGOUT_FENCE_PREFIX) === true
    || stamp?.startsWith(UNCERTAIN_REFRESH_FENCE_PREFIX) === true
    || stamp?.startsWith(IN_FLIGHT_REFRESH_PREFIX) === true;
}

function readStamp(storage: StorageLike | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(REFRESH_STAMP_KEY) ?? null;
  } catch {
    throw new SessionRefreshLockUnavailableError();
  }
}

/** A successful new login replaces a prior sign-out fence. No credential is
 * stored here; the cookie is issued and protected by the server. */
export function markSessionEstablished(
  storage: StorageLike | undefined,
  newStamp: () => string = () => crypto.randomUUID(),
): void {
  try {
    storage?.setItem(REFRESH_STAMP_KEY, `login:${newStamp()}`);
  } catch {
    // Browser storage can be unavailable; no token is stored locally.
  }
}

/** Serialize cookie-issuing login and invitation acceptance with logout and
 * refresh. The successful response, cookie update and stamp belong to one
 * cross-tab critical section. */
export async function coordinateSessionEstablishment<T>(
  establish: () => Promise<T>,
  locks: LockManagerLike | undefined,
  storage: StorageLike | undefined,
  newStamp: () => string = () => crypto.randomUUID(),
): Promise<T> {
  const perform = async () => {
    const result = await establish();
    markSessionEstablished(storage, newStamp);
    return result;
  };
  return locks ? locks.request(REFRESH_LOCK_NAME, perform) : perform();
}

/** Keep logout's server revocation and cookie clearance in the same
 * cross-tab critical section as refresh. Persist the fence before the
 * request so another tab cannot retry a spent token if this tab closes
 * while the response is in flight.
 * Only a successful new login clears this noncredential fence.
 */
export async function coordinateSessionLogout(
  logout: () => Promise<void>,
  locks: LockManagerLike | undefined,
  storage: StorageLike | undefined,
  newStamp: () => string = () => crypto.randomUUID(),
): Promise<void> {
  const perform = async () => {
    const fence = `${LOGOUT_FENCE_PREFIX}${newStamp()}`;
    try {
      storage?.setItem(REFRESH_STAMP_KEY, fence);
    } catch {
      // If shared storage stays unwritable, renewal fails before token use.
    }
    try {
      await logout();
    } finally {
      // Under a Web Lock, no new login can complete before this callback
      // exits. Retry a transiently failed fence write without overwriting a
      // newer login on browsers where the lock is unavailable.
      if (locks) {
        try {
          storage?.setItem(REFRESH_STAMP_KEY, fence);
        } catch {
          // A persistently unwritable stamp blocks renewal before token use.
        }
      }
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
  isSafePreRotationRefusal?: (error: unknown) => boolean,
): Promise<void> {
  if (!locks || !storage) {
    if (isReauthenticationFence(readStamp(storage))) throw new SessionReauthenticationRequiredError();
    // A reactive retry can arrive after another tab has already rotated the
    // shared cookies. A current access session needs no refresh. If it is
    // expired, neither a probe nor a lock alone can distinguish a completed
    // sign-out when shared storage is unavailable. Never present a single-use
    // token without both the lock and the shared noncredential stamp.
    if (isSessionCurrent && await isSessionCurrent()) return;
    throw new SessionRefreshLockUnavailableError();
  }

  const before = readStamp(storage);
  await locks.request(REFRESH_LOCK_NAME, async () => {
    const after = readStamp(storage);
    if (isReauthenticationFence(after)) throw new SessionReauthenticationRequiredError();
    if (before !== after && after !== null
      && !after.startsWith(SAFE_REFRESH_REFUSAL_PREFIX)) return;
    // Another browser request can rotate the shared cookies without updating
    // this tab's stamp. A failed storage write can also leave an old non-null
    // stamp in place. For reactive retries, verify the current cookie under
    // the lock before presenting a single-use token.
    // Proactive renewals omit this check because a still-valid access token
    // does not prove that its requested extension already happened.
    if (isSessionCurrent && await isSessionCurrent()) return;
    try {
      // Prove that the cross-tab stamp can be written before presenting a
      // single-use cookie. The in-flight marker remains a reauthentication
      // fence if the response or final stamp write fails ambiguously.
      storage.setItem(REFRESH_STAMP_KEY, `${IN_FLIGHT_REFRESH_PREFIX}${newStamp()}`);
    } catch {
      throw new SessionRefreshLockUnavailableError();
    }
    try {
      await refresh();
    } catch (error) {
      // A lost response may mean the server rotated the single-use cookie
      // while the browser retained its old value. A received refusal known to
      // precede rotation is retryable; every other failure stays fenced.
      try {
        storage.setItem(REFRESH_STAMP_KEY,
          `${isSafePreRotationRefusal?.(error) === true
            ? SAFE_REFRESH_REFUSAL_PREFIX : UNCERTAIN_REFRESH_FENCE_PREFIX}${newStamp()}`);
      } catch {
        // The initial write succeeded; a later read/write failure also
        // blocks renewal before the token is presented again.
      }
      throw error;
    }
    try {
      storage?.setItem(REFRESH_STAMP_KEY, newStamp());
    } catch {
      // The in-flight marker remains; later renewals require a new login.
    }
  });
}
