/**
 * The behaviour behind `(dashboard)/integrations/confluence/callback/page.tsx`.
 *
 * It lives here rather than inline in the page's `useEffect` for one reason:
 * three guarantees on this path are stated as fact in `docs/ARCHITECTURE.md`
 * — the kind of statement a DPO can be shown — and none of them was pinned by
 * a test while they were buried in a component this project has no renderer
 * for. Replacing the scrub call with a comment used to leave the whole
 * `apps/web` suite green.
 *
 * The three:
 *
 * 1. **The URL is scrubbed before the code is spent.** `code` and `state` are
 *    single-use secrets that Atlassian delivers in the query string.
 *    `history.replaceState` removes them from the address bar and the history
 *    entry, so a reload or a Back cannot resubmit them — and it runs *before*
 *    the exchange, not after, so it still runs when the exchange throws.
 * 2. **The exchange runs at most once.** React StrictMode double-mounts an
 *    effect in development, and a second POST would spend an already-spent
 *    code and show the administrator a `code-spent` error for a connection
 *    that actually succeeded.
 * 3. **An Atlassian denial never reaches the exchange.** When the
 *    administrator declines on Atlassian's consent screen the redirect
 *    carries `?error=…` and no code; that is a fixed message, not a failed
 *    network call.
 */
import { removeSensitiveSearchParams } from './url-security';
import { completeConfluenceCallback, type CallbackOutcome } from './confluence-callback';

export const CODE_PARAM = 'code';
export const STATE_PARAM = 'state';
export const ATLASSIAN_ERROR_PARAM = 'error';

export const ATLASSIAN_DENIED_MESSAGE =
  'Atlassian did not return an authorisation. Start the connection again from CharityPilot.';

/**
 * The minimum of `window` this needs. Structural rather than `Window` so the
 * scrub can be driven directly by a test without a DOM.
 */
export type CallbackUrlWindow = {
  location: { href: string };
  history: {
    state: unknown;
    replaceState: (state: unknown, unused: string, url: string) => void;
  };
};

export type ConfluenceCallbackPageDeps = {
  /** Reads a parameter out of the page's `searchParams`. */
  getParam: (name: string) => string | null;
  /** Removes the secrets from the address bar. */
  scrubUrl: () => void;
  /** Renews the session, then spends the code. */
  exchange: (input: { code: string; state: string }) => Promise<CallbackOutcome>;
  /** Hands the outcome back to the page. */
  setOutcome: (outcome: CallbackOutcome) => void;
};

function defaultWindow(): CallbackUrlWindow | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as CallbackUrlWindow);
}

/**
 * Replaces the current history entry with the same URL minus `code`, `state`
 * and `error`. A no-op on the server, where there is no history to replace.
 */
export function scrubCallbackUrlSecrets(win: CallbackUrlWindow | undefined = defaultWindow()): void {
  if (!win) return;

  const scrubbed = removeSensitiveSearchParams(win.location.href, [
    CODE_PARAM,
    STATE_PARAM,
    ATLASSIAN_ERROR_PARAM,
  ]);
  win.history.replaceState(win.history.state, '', scrubbed);
}

/**
 * The page's effect body, run at most once per mount pair.
 *
 * `ranRef` is the page's own `useRef`; it is passed in rather than owned here
 * so that the guard survives exactly as long as the component instance does,
 * which is what makes it a StrictMode double-mount guard rather than a
 * module-level latch that would also block a genuine second attempt.
 */
export function runConfluenceCallbackOnce(
  ranRef: { current: boolean },
  deps: ConfluenceCallbackPageDeps,
): void {
  if (ranRef.current) return;
  ranRef.current = true;

  const code = deps.getParam(CODE_PARAM);
  const state = deps.getParam(STATE_PARAM);
  const deniedByAtlassian = deps.getParam(ATLASSIAN_ERROR_PARAM);

  // The code and state have now been read out of the URL for good — they are
  // never re-derived from `window.location` again on this page, and the URL
  // itself is scrubbed immediately, whatever happens next. Before the
  // exchange, deliberately: an exchange that throws must not leave them in
  // the address bar.
  deps.scrubUrl();

  if (deniedByAtlassian || !code || !state) {
    deps.setOutcome({ kind: 'failed', message: ATLASSIAN_DENIED_MESSAGE });
    return;
  }

  deps.exchange({ code, state }).then(deps.setOutcome);
}

/**
 * The wiring the page actually uses: the real scrub and the real exchange.
 */
export function confluenceCallbackPageDeps(
  getParam: (name: string) => string | null,
  setOutcome: (outcome: CallbackOutcome) => void,
): ConfluenceCallbackPageDeps {
  return {
    getParam,
    scrubUrl: () => scrubCallbackUrlSecrets(),
    exchange: completeConfluenceCallback,
    setOutcome,
  };
}
