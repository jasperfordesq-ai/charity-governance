# Confluence OAuth Connection Lifecycle (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a charity connect its own Confluence site to CharityPilot and keep that connection alive indefinitely, without a race or a crash ever locking them out.

**Architecture:** Standard OAuth 2.0 3LO against `auth.atlassian.com`, with tokens sealed through the Phase 1 credential vault. The whole design is shaped by one fact: **Atlassian issues rotating, single-use refresh tokens.** Every refresh invalidates the token it was called with, so refreshes must be serialised per integration and the replacement must be durably stored before it is used.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Node 22, Fastify 5, Prisma 6, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/plans/2026-09-18-document-storage-providers-spec.md`
**Depends on:** `docs/superpowers/plans/2026-09-18-integration-credentials-phase-1.md` (complete)

---

## A correction to the earlier scoping

Previous notes in this project said Phase 2 was blocked until the Atlassian MCP connector could read `hour-timebank.atlassian.net`. **That was overstated, and it is worth being precise about why.**

The MCP connector is the tool *Claude* uses to read the owner's Confluence. It is unrelated to CharityPilot's own integration, which is a separate OAuth app that each tenant authorises. The Confluence REST API is public and documented, so the connection lifecycle and the client can both be built and tested without it.

What genuinely needs sight of a real space is the **publish pipeline** — deciding how a governance document maps onto a page, what the space structure should look like, and whether the `POL -` / `NOS -` prefixes Nikita uses are a convention to key off. That is a later phase, and it is the one to hold.

**What this phase really needs from the owner** is a registered Atlassian OAuth app. That is a configuration prerequisite, not a code one — see below.

---

## Prerequisite the owner must supply

Someone must create an OAuth 2.0 (3LO) app in the [Atlassian developer console](https://developer.atlassian.com/console/myapps/) and add the Confluence API with these granular scopes:

- `read:page:confluence`, `write:page:confluence`
- `read:attachment:confluence`, `write:attachment:confluence`
- `read:space:confluence`
- `read:content-details:confluence`
- **`offline_access`** — without it no refresh token is issued at all, and every charity is disconnected within an hour

The callback URL must be registered as `{API_URL}/integrations/confluence/callback`.

That yields a client ID and client secret, supplied as `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET`. **Tasks 1-3 can be built and tested without them**; only a live connection needs them.

---

## Global Constraints

- **No behaviour change for any existing deployment.** No organisation has an integration row; every route added here is inert until one is created.
- **A plaintext token never leaves the credential boundary.** Tokens are sealed by the Phase 1 vault before storage and never logged, never returned in a response, never put in an error message or an error `cause`. This includes the authorization `code` and the `client_secret`.
- **Callers must prove ownership.** The credential service binds a credential to its owner but does **not** authorize — its own module header says so. Every route added here must verify the requesting user's organisation owns the integration it names.
- **Refreshes are serialised per integration.** See the hazard below. A concurrent refresh must wait, not race.
- **`ATLASSIAN_CLIENT_SECRET` is required in production** when the Confluence integration is enabled, must be distinct from every other secret, and is validated at boot in the same way `INTEGRATION_ENCRYPTION_KEY` is.
- Migrations are additive only.
- ESM only; every relative import ends in `.js`.
- Current suite state: `apps/api` main **1102 pass / 0 fail**, real-PostgreSQL migration suite **4 pass / 0 fail**. Every task reports against this.

---

## The hazard this plan exists to handle

[Atlassian uses rotating refresh tokens](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/). Three consequences, each of which can permanently disconnect a charity:

**1. Every refresh invalidates the token it used.** The response carries a replacement. If two processes refresh concurrently — CharityPilot has web routes *and* background jobs — one wins and the other's token is already dead. Its retry fails with `invalid_grant`, and if that failure is treated as "the tenant revoked us", the integration is marked broken for no reason.

**2. A crash between refreshing and saving is unrecoverable.** The old token is invalidated the instant Atlassian responds. If the process dies before the replacement is durably stored, that charity cannot be refreshed again and must re-authorise by hand. The write must therefore happen immediately, in its own committed transaction, before the new access token is used for anything.

**3. Ninety days of inactivity expires the token**, with the clock reset on each use. A charity whose integration is idle for a quarter is silently disconnected. That is a product decision as much as a technical one — it should be visible, not discovered.

The repository already has the right idiom for (1): the storage-deletion pipeline uses a claim column (`claimedAt`) to serialise workers over rows. Follow it rather than inventing a lock.

---

## File Structure

**Create:**
- `apps/api/src/services/atlassian-oauth.ts` — token exchange and refresh against `auth.atlassian.com`. Pure HTTP plus parsing; no Prisma.
- `apps/api/src/services/confluence-connection.service.ts` — the lifecycle: connect, store, refresh-with-serialisation, disconnect.
- `apps/api/src/routes/integrations/index.ts` — the authorize / callback / status / disconnect routes.
- Tests for each.
- `apps/api/prisma/migrations/<stamp>_add_integration_refresh_claim/migration.sql`

**Modify:**
- `apps/api/prisma/schema.prisma` — the refresh claim columns on `OrganisationIntegration`.
- `apps/api/src/utils/env.ts` — validate the Atlassian client credentials.
- `apps/api/src/server.ts` — register the new routes.
- `docs/ARCHITECTURE.md` — document the rotation hazard and the serialisation rule.

---

### Task 1: Atlassian OAuth token exchange

**Files:**
- Create: `apps/api/src/services/atlassian-oauth.ts`
- Test: `apps/api/src/tests/atlassian-oauth.test.ts`

**Interfaces:**
- Produces:
  - `type AtlassianTokens = { accessToken: string; refreshToken: string | null; expiresAt: Date; scopes: string[] }`
  - `exchangeAuthorizationCode(code: string, redirectUri: string, deps?: OAuthDeps): Promise<AtlassianTokens>`
  - `refreshAccessToken(refreshToken: string, deps?: OAuthDeps): Promise<AtlassianTokens>`
  - `listAccessibleResources(accessToken: string, deps?: OAuthDeps): Promise<{ id: string; url: string; name: string }[]>`
  - `type OAuthDeps = { fetch?: typeof globalThis.fetch; clientId?: string; clientSecret?: string }`

`deps` exists so tests can inject a fake `fetch` — do not reach for a network mocking library, and do not make a real network call in a test.

Endpoints, exactly:
- Token: `POST https://auth.atlassian.com/oauth/token`
- Accessible resources: `GET https://api.atlassian.com/oauth/token/accessible-resources`

`expiresAt` is computed from the response's `expires_in` (seconds). Subtract a safety margin of 60 seconds so a token is never presented at the moment it expires.

> **Correction, added after Task 1's review.** An earlier version of this step said a missing
> `refresh_token` means `offline_access` was not granted. That is incomplete and the omission is
> dangerous. Atlassian may **also** omit `refresh_token` on a refresh when it has not rotated the
> token — in which case **the refresh token you already hold is still valid**.
>
> So `refreshToken: null` means "no replacement was issued", *not* "there is no refresh token".
> A caller that writes the response straight through — `update({ refreshToken: tokens.refreshToken })`
> — would null out a working refresh token and permanently break that charity's integration, silently.
>
> **The rule, which is safe under either reading: absent means unchanged.** Never clear a stored
> refresh token because a response omitted one. Task 3 must only overwrite when a replacement was
> actually returned. Say so at the type, not just in a comment.

- [ ] **Step 1: Write the failing test**

Cover: a successful code exchange parses all four fields; a successful refresh does the same; **a refresh response that omits `refresh_token` yields `refreshToken: null` rather than throwing** (see the correction above — `null` means "no replacement issued"); a non-2xx response throws an `AppError` whose message contains neither the code, the refresh token, nor the client secret; `listAccessibleResources` parses the cloud id list.

**Validate the success body rather than trusting it.** A 200 whose body lacks `expires_in` yields an `Invalid Date`, and every comparison against it is false — so a downstream expiry check neither fires nor refuses, and the row looks structurally fine. A 200 lacking `access_token` yields `undefined` typed as `string`, which the next task would encrypt and persist as a credential containing no credential. Both must throw `ATLASSIAN_OAUTH_RESPONSE_INVALID` instead, and both need a test.

**Carry the HTTP status into the error.** It is the one discriminator guaranteed present that can never echo the request, and without it a broken gateway and a rejected grant are indistinguishable.

Assert explicitly that the thrown error's `message`, `cause` and `details` contain none of the secret inputs — this project has repeatedly found leak paths only when a test looked for them.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run build && node --test dist/tests/atlassian-oauth.test.js
```

- [ ] **Step 3: Write the implementation**

Send the token request as `application/json` with `grant_type`, `client_id`, `client_secret`, `code`/`refresh_token` and `redirect_uri` as the docs require. On a non-2xx, read the body for logging **only** after confirming it cannot contain the request's secrets — Atlassian's error bodies carry an `error` and `error_description`, so surface those two fields and nothing else.

- [ ] **Step 4: Run the test to verify it passes**

- [ ] **Step 5: Commit**

---

### Task 2: The refresh claim, and its migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<stamp>_add_integration_refresh_claim/migration.sql`

Add to `OrganisationIntegration`:

```prisma
  // Serialises token refresh across the web process and the background jobs.
  // Atlassian's refresh tokens are single-use: a concurrent refresh invalidates
  // the loser's token and disconnects the charity. Follow the claim idiom used
  // by DocumentStorageDeletion rather than inventing a lock.
  refreshClaimedAt    DateTime?
  refreshClaimToken   String?
  refreshFailureCount Int       @default(0)
  lastRefreshedAt     DateTime?
```

**Write the migration by hand.** `prisma migrate dev` cannot run against this database — it reports pre-existing drift unrelated to this work and demands a destructive reset — and there is no shadow database configured. Apply with `npm run db:migrate:deploy`, which does not run drift detection. **Never run `migrate reset`, `db push`, `DROP` or `TRUNCATE`.** Four `ADD COLUMN` statements, all nullable or defaulted.

Run the full suite; nothing reads these columns yet, so the numbers should be unchanged.

---

### Task 3: The connection service, with serialised refresh

**Files:**
- Create: `apps/api/src/services/confluence-connection.service.ts`
- Test: `apps/api/src/tests/confluence-connection.service.test.ts`

**This is the task that matters.** Everything else is plumbing.

**Interfaces:**
- Produces:
  - `connectConfluence(prisma, { organisationId, userId, code, redirectUri }): Promise<{ integrationId: string; siteUrl: string }>`
  - `currentAccessToken(prisma, { integrationId }): Promise<string>`
  - `disconnectConfluence(prisma, { integrationId }): Promise<void>`

**`currentAccessToken` carries the whole hazard.** Required behaviour:

1. Load the integration and its stored access token. If the token is still valid (`expiresAt` in the future), return it without touching Atlassian.
2. Otherwise **claim the refresh**: a conditional update that sets `refreshClaimedAt` and a fresh `refreshClaimToken` only where `refreshClaimedAt` is null or older than a staleness window. Use the same shape as the storage-deletion claim — read that code before writing this.
3. If the claim was **not** won, another worker is refreshing. Wait briefly and re-read, rather than refreshing in parallel. If the winner finished, its new access token is now stored and you return it. **Never refresh without the claim.**
4. If the claim **was** won: refresh, then **store the replacement refresh token immediately and durably, before returning or using the new access token.** A crash between the Atlassian response and this write permanently disconnects the charity. Store it in its own committed write, not batched with anything else.
5. Release the claim on both success and failure. A claim leaked by a crash must age out via the staleness window rather than blocking forever.
6. On `invalid_grant`, distinguish the two causes rather than collapsing them: a genuinely revoked or expired grant should set `status: ERROR` with a `lastError` the admin can act on; a lost race should not. The claim in step 2 is what makes that distinction possible — if you did not hold the claim, you never called refresh, so an `invalid_grant` you see is real.

Tests must include: a valid token short-circuits with no HTTP call; an expired token refreshes once; **two concurrent callers produce exactly one refresh call**; a crash simulated between refresh and store leaves a state a later call can recover from; `invalid_grant` while holding the claim marks the integration errored; a stale claim is reclaimable.

The concurrency test is the point of this task. Make it fail if the claim is removed, and prove that it does.

---

### Task 4: Routes

**Files:**
- Create: `apps/api/src/routes/integrations/index.ts`
- Test: `apps/api/src/tests/integrations-route.test.ts`
- Modify: `apps/api/src/server.ts`

Four routes, all behind the existing `authGuard` and `requireAdmin`, following the shape of `routes/documents/index.ts`:

- `GET /integrations/confluence/authorize` — builds the authorization URL with `audience=api.atlassian.com`, `response_type=code`, `prompt=consent`, the scopes above **including `offline_access`**, and a `state` that is signed and bound to the requesting organisation. Returns the URL; does not redirect.
- `GET /integrations/confluence/callback` — validates `state` **before anything else**, rejects a mismatch, exchanges the code, stores the tokens, records the site, returns a result the web app can act on.
- `GET /integrations/confluence/status` — provider, status, site URL, `connectedAt`, `lastError`. **Never any token material, and never the fingerprint of one.**
- `DELETE /integrations/confluence` — disconnects and deletes the stored credentials.

**The `state` parameter is the CSRF defence for the whole flow.** An unvalidated callback lets an attacker attach their own Confluence site to a victim's organisation. Sign it with an existing secret, bind it to the organisation and a short expiry, and reject on any mismatch. Test the rejection path first.

Because the credential service binds but does not authorize, **every route must check that the requesting user's organisation owns the integration** before acting. Test that a user from organisation A cannot read or disconnect organisation B's integration.

**Prefer looking integrations up by `organisationId_provider`** — the unique index makes that the natural query, and it means an `integrationId` never has to be accepted from a request body at all. That is the structural version of the rule, and it is better than remembering to check.

#### Two obligations carried from Phase 1, which this task owns

Both were recorded as prose in `docs/ARCHITECTURE.md` with nothing that will fail if they are forgotten. This task is where they come due.

**1. Gate the connect flow on `INTEGRATION_ENCRYPTION_KEY` being present.** Phase 1 deliberately did **not** require that key on the personal-server appliance branch, because doing so would break every existing appliance install on upgrade for a key nothing used yet. The trade was explicit: the *feature* must be gated, not the *boot*. So the authorize and callback routes must refuse — clearly, with an actionable message — when the key is absent, on **every** deployment profile including the appliance. Without it, an appliance user would complete an entire OAuth round trip and only discover the problem when the first token store fails.

**Write a test that fails if this gate is removed.** The obligation currently has no enforcement at all; prose is what it has instead, and prose is what let it reach this plan.

**2. The authorization boundary is real work, not a formality.** `integration-credential.service.ts` opens with a banner stating that it binds but does not authorize: passing another charity's `integrationId` yields a context derived from *that* charity's row, and the decrypt succeeds. Phase 1's reviewer confirmed this is the one remaining path by which one tenant's credential could reach another, and left it standing precisely because no route existed. This task creates the routes. **Do not let the first one ship without ownership scoping.**

---

### Task 5: Environment validation and documentation

**Files:**
- Modify: `apps/api/src/utils/env.ts`, `apps/api/src/tests/env.test.ts`
- Modify: `.env.example`, `.env.production.example`, `.env.bluegreen.private-vm.example`, `docs/bluegreen-runbook.md`
- Modify: `docs/ARCHITECTURE.md`, `docs/production-runbook.md`

Validate `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET` in production, following `requireIntegrationEncryptionKey` exactly. The secret must be distinct from every other secret.

**Learn from Phase 1's blast-radius miss.** Adding a required production variable there broke both CI workflows and left the private-VM generator one `sed` line short. Before finishing:

- Add the variables to **every** `-e` list where production validation runs — there are five sites, and `scripts/check-production.test.mjs` now derives and asserts them. Run that suite.
- Add the `sed` substitution to `docs/bluegreen-runbook.md`, and confirm its placeholder count matches the template.
- Add them to `scripts/check-production.mjs`'s own `REQUIRED` list, which is maintained separately from the API's.

**Decide deliberately whether these should be required at all**, or required only when the Confluence integration is enabled. A deployment with no charity using Confluence should probably not be forced to hold Atlassian credentials — and that choice is easier to make now than to unpick later. State which you chose and why.

Document the rotation hazard in `docs/ARCHITECTURE.md`: single-use refresh tokens, why refreshes are serialised, and why the replacement is written before use. Add to `docs/production-runbook.md` that a charity idle for 90 days is silently disconnected by Atlassian.

---

## Done when

- A charity can connect its Confluence site, and the connection survives an access-token expiry without manual intervention.
- Two concurrent callers of `currentAccessToken` produce exactly one refresh.
- A `state` mismatch on the callback is rejected.
- A user from one organisation cannot read or disconnect another's integration.
- No token, code or client secret appears in any log, response, or error.
- `npm test` passes in `apps/api` with no pre-existing test modified.

## Explicitly not in this phase

- **The Confluence API client** (pages, attachments, content properties). That is Phase 3, and it is genuinely useful without a live site because the REST API is documented and stable.
- **The publish pipeline.** That is the phase that needs sight of the owner's Governance Hub, and it should not be designed blind.
- **Key rotation for the credential vault.** Still deferred; still needs the `generation` column to be treated as authoritative rather than advisory.
