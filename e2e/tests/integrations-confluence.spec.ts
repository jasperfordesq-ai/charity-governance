import { test, expect } from '../fixtures';
import { gotoWithDevServerRetry } from '../helpers/navigation';

/**
 * Journey: the Confluence connector, end to end, against a fake Atlassian.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * NOTHING HERE TOUCHES A REAL ATLASSIAN SITE, AND IT CANNOT.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The stack runs a `fake-atlassian` service on the internal network with no
 * published port. The API reaches it only because `CHARITYPILOT_FAKE_ATLASSIAN`
 * is `1` in `compose.e2e.yml`; `atlassian-endpoints.ts` refuses the override
 * under `NODE_ENV=production`, and `validateProductionEnv` refuses to boot a
 * production deployment carrying the variable at all. `atlassian-endpoints.test.ts`
 * pins each of those fences separately.
 *
 * The journey is the one the audit named: disclosure → callback → space choice
 * → status. What it is really testing is that the four surfaces agree — that
 * the disclosure cannot be bypassed, that connecting and choosing a destination
 * are separate acts, and that "Connected" never on its own reads as
 * "publishing".
 */

/** The API path the web app proxies to. Kept in one place so a rename is one edit. */
const CONFLUENCE_API = /\/api\/v1\/integrations\/confluence/;

test.describe('Confluence connector', () => {
  test('disclosure, connect, choose a space, and only then publishing', async ({ ownerPage }) => {
    await gotoWithDevServerRetry(ownerPage, '/integrations');

    // ── 1. Not connected, and saying so plainly ──────────────────────────
    await expect(ownerPage.getByRole('button', { name: 'Connect Confluence' })).toBeVisible();

    // ── 2. The disclosure is the gate, not a footnote beside it ──────────
    const authorize = ownerPage.waitForResponse(
      (r) => /\/confluence\/authorize$/.test(r.url()) && r.request().method() === 'GET',
    );
    await ownerPage.getByRole('button', { name: 'Connect Confluence' }).click();
    const authorizeResponse = await authorize;
    expect(authorizeResponse.status()).toBe(200);

    // The link to Atlassian only ever renders from `buildConnectView`, which
    // throws rather than returning a URL when the disclosure is missing. So the
    // presence of this button is itself the assertion that the limits were
    // shown: there is no path to the link that skips them.
    const continueButton = ownerPage.getByRole('link', { name: /continue to Atlassian/i });
    await expect(continueButton).toBeVisible();

    // The two limits a DPO cares about most must be on screen before consent.
    await expect(ownerPage.getByText(/trash/i).first()).toBeVisible();

    const authorizationUrl = await continueButton.getAttribute('href');
    expect(authorizationUrl, 'the authorize link must carry a URL').toBeTruthy();

    // ── 3. The callback, driven as Atlassian would drive it ──────────────
    //
    // The `state` is signed by the API and travels in the authorize URL. Taking
    // it from there rather than minting one is deliberate: a test that forged a
    // state would pass even if the CSRF defence were removed.
    const state = new URL(authorizationUrl as string).searchParams.get('state');
    expect(state, 'authorize must mint a signed state').toBeTruthy();

    const callback = ownerPage.waitForResponse(
      (r) => /\/confluence\/callback$/.test(r.url()) && r.request().method() === 'POST',
    );
    await gotoWithDevServerRetry(
      ownerPage,
      `/integrations/confluence/callback?code=fake-authorization-code&state=${encodeURIComponent(state as string)}`,
    );
    const callbackResponse = await callback;
    expect(callbackResponse.status(), await callbackResponse.text()).toBe(200);

    // ── 4. Connected — and NOT publishing, which is the point ────────────
    await gotoWithDevServerRetry(ownerPage, '/integrations');
    await expect(ownerPage.getByText('Charity E2E')).toBeVisible();

    // A charity that believes it is mirroring and is not is worse off than one
    // that knows it has a step left. Connecting is the opt-in; choosing a space
    // is the destination; neither substitutes for the other.
    await expect(ownerPage.getByRole('button', { name: /Choose a space/i })).toBeVisible();

    // ── 5. The space picker lists what the site actually has ─────────────
    const spaces = ownerPage.waitForResponse(
      (r) => /\/confluence\/spaces/.test(r.url()) && r.request().method() === 'GET',
    );
    await ownerPage.getByRole('button', { name: /Choose a space/i }).click();
    expect((await spaces).status()).toBe(200);

    await ownerPage.getByRole('button', { name: /Confluence space/i }).click();
    await ownerPage.getByRole('option', { name: /Governance \(GOV\)/ }).click();

    const savedSpace = ownerPage.waitForResponse(
      (r) => /\/confluence\/publish-space$/.test(r.url()) && r.request().method() === 'PUT',
    );
    await ownerPage.getByRole('button', { name: 'Publish into this space' }).click();
    expect((await savedSpace).status()).toBe(200);

    // ── 6. Now, and only now, it is publishing ───────────────────────────
    //
    // Read from the status call the PAGE makes, not one this test issues.
    // Driving the API directly would bypass the browser origin fence, which is
    // the thing these specs exist to exercise. The runner enforces it with a
    // source guard forbidding direct Playwright APIRequestContext calls in
    // these specs, so the rule is structural rather than remembered.
    const status = await ownerPage.waitForResponse(
      (r) => /\/confluence\/status$/.test(r.url()) && r.request().method() === 'GET',
    );
    const statusBody = (await status.json()) as {
      data: {
        status: string;
        publishing: boolean;
        publishSpace: { key: string } | null;
        declaredEnvironment: { controlledByCharityPilot: boolean };
      };
    };
    expect(statusBody.data.status).toBe('CONNECTED');
    expect(statusBody.data.publishSpace?.key).toBe('GOV');
    expect(statusBody.data.publishing).toBe(true);

    // The residency caveat travels on every status response, so a client cannot
    // render a declaration without it.
    expect(statusBody.data.declaredEnvironment.controlledByCharityPilot).toBe(false);

    // And the screen says so too. A charity reads the page, not the payload.
    await expect(ownerPage.getByText(/Governance/).first()).toBeVisible();
  });

  test('no token material reaches the browser on any connector response', async ({ ownerPage }) => {
    const bodies: string[] = [];
    ownerPage.on('response', (response) => {
      if (!CONFLUENCE_API.test(response.url())) return;
      void response
        .text()
        .then((text) => bodies.push(text))
        .catch(() => undefined);
    });

    await gotoWithDevServerRetry(ownerPage, '/integrations');
    await ownerPage.getByRole('button', { name: 'Connect Confluence' }).click();
    await expect(ownerPage.getByRole('link', { name: /continue to Atlassian/i })).toBeVisible();

    expect(bodies.length, 'this assertion proves nothing over zero responses').toBeGreaterThan(0);
    for (const body of bodies) {
      const lowered = body.toLowerCase();
      // The API's own unit tests pin this by allow-list; this is the same rule
      // asserted where it actually matters — on the wire, in a browser.
      for (const forbidden of ['access_token', 'refresh_token', 'client_secret', 'ciphertext']) {
        expect(lowered, `a connector response carried ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  test('a callback with a state from nowhere is refused', async ({ ownerPage }) => {
    // The CSRF defence for the whole flow. A forged state must not reach the
    // token exchange — the fake would happily issue a token to it.
    //
    // Driven through the callback PAGE rather than by posting directly, both
    // because the runner forbids direct APIRequestContext calls in these specs, and because
    // this is the shape a real attack takes: a victim's browser, following a
    // link, carrying the victim's cookies.
    const callback = ownerPage.waitForResponse(
      (r) => /\/confluence\/callback$/.test(r.url()) && r.request().method() === 'POST',
    );
    await gotoWithDevServerRetry(
      ownerPage,
      '/integrations/confluence/callback?code=fake-authorization-code&state=not-a-signed-state',
    );

    const response = await callback;
    expect(response.status()).toBe(400);
    expect(((await response.json()) as { code?: string }).code).toBe('CONFLUENCE_OAUTH_STATE_INVALID');

    // And the charity is told, rather than left on a blank page believing they
    // are connected.
    await expect(ownerPage.getByText(/could not|not be completed|try again/i).first()).toBeVisible();
  });
});
