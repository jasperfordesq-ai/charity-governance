/**
 * What `(dashboard)/layout.tsx` does with a session that is loading, dead, or
 * unverified — decided here, where a test can drive it.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT INLINE IN THE LAYOUT
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The layout used to answer a dead session with, in effect:
 *
 *     useEffect(() => {
 *       if (!isLoading && !user) {
 *         const next = `${window.location.pathname}${window.location.search}`;
 *         router.replace(`/login?next=${encodeURIComponent(next)}`);
 *       }
 *     });
 *     …
 *     if (!user || !user.emailVerified) return null;
 *
 * On the Confluence callback path that is the same credential leak the
 * middleware was fixed for, arriving through a client-side route the
 * middleware never sees. `window.location.search` still holds
 * `?code=<live>&state=<state>` straight from Atlassian, so the live
 * authorization code lands in `/login?next=…`, and from there in the address
 * bar, the history entry, the `Referer` of `/login`'s subresources and the
 * proxy access log — the proxy's own filter deletes only TOP-LEVEL `code` and
 * `state`, never one nested inside `next`.
 *
 * It is NOT saved by the callback page scrubbing its own URL first. The
 * `return null` above means `{children}` never renders, so on exactly this
 * trigger the page never mounts and its scrub never runs. (That is the hole in
 * the "child effects run before parent effects" argument: they do, but only if
 * the child mounts.)
 *
 * So the callback path is excluded from both redirects and rendered WITHOUT
 * the dashboard chrome — it has to actually mount, because renewing the
 * session is the one thing it exists to do. And, as depth for every other
 * path, `next` is built by the shared `safeNextValue`, the same one the
 * middleware uses.
 */
import { renewsItsOwnSession } from './protected-routes';
import { safeNextValue } from './url-security';

export type DashboardSession = {
  isLoading: boolean;
  user: { emailVerified: boolean } | null;
};

export type DashboardLocation = {
  pathname: string;
  search: string;
};

/**
 * What the layout should render.
 *
 * - `loading` — the auth context has not answered yet.
 * - `dashboard` — a verified session: the full chrome.
 * - `renew-in-place` — render `{children}` alone, no chrome, no navigation,
 *   no tenant data. Only for a path that renews its own session, and only
 *   while that session is not usable.
 * - `blank` — render nothing; a redirect is on its way.
 */
export type DashboardBody = 'loading' | 'dashboard' | 'renew-in-place' | 'blank';

export function dashboardBody(
  session: DashboardSession,
  pathname: string,
): DashboardBody {
  if (session.isLoading) return 'loading';
  if (session.user && session.user.emailVerified) return 'dashboard';

  // No usable session. A page that renews its own session has to be allowed to
  // mount and do so; anything else waits for the redirect below.
  return renewsItsOwnSession(pathname) ? 'renew-in-place' : 'blank';
}

/**
 * Where the layout should send the visitor, or `null` to stay put.
 *
 * Takes the location explicitly — the layout reads it from `window.location`
 * inside its effect, which is the only place that is safe to do — so that the
 * secrets this has to keep out of `next` are real inputs here rather than
 * something a test has to simulate.
 */
export function dashboardRedirect(
  session: DashboardSession,
  location: DashboardLocation,
): string | null {
  if (session.isLoading) return null;

  // Both redirects are withheld for a self-renewing path, for the same reason
  // and not only the first one: bouncing the callback to `/verify-email`
  // carries no secret, but it abandons the connection just as completely, and
  // the page is the thing that knows how to report why.
  if (renewsItsOwnSession(location.pathname)) return null;

  if (!session.user) {
    // Preserve the intended destination so login can return the visitor here
    // (`safeNextPath` validates it on the way back in). Without this, deep
    // links land on /dashboard.
    return `/login?next=${encodeURIComponent(safeNextValue(location.pathname, location.search))}`;
  }

  if (!session.user.emailVerified) return '/verify-email';

  return null;
}
