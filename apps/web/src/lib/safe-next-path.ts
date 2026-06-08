import { isProtectedAppPath } from './protected-routes';

const DEFAULT_LOGIN_DESTINATION = '/dashboard';

function currentOrigin(): string {
  return typeof window === 'undefined' ? 'https://app.charitypilot.ie' : window.location.origin;
}

export function safeNextPath(nextPath: string | null, origin = currentOrigin()): string {
  if (!nextPath || !nextPath.startsWith('/')) {
    return DEFAULT_LOGIN_DESTINATION;
  }

  try {
    const baseOrigin = new URL(origin).origin;
    const destination = new URL(nextPath, baseOrigin);
    if (destination.origin !== baseOrigin) {
      return DEFAULT_LOGIN_DESTINATION;
    }

    const path = `${destination.pathname}${destination.search}${destination.hash}`;
    return isProtectedAppPath(path) ? path : DEFAULT_LOGIN_DESTINATION;
  } catch {
    return DEFAULT_LOGIN_DESTINATION;
  }
}
