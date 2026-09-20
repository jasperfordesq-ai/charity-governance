# Prompt: finish the CharityPilot connector now that the server is deployed

Paste everything below the line into a fresh session in this repository.

---

The CharityPilot private server is deployed and current. The MCP connector in
`mcp/` is built, audited and pushed, and all eight phases of
`docs/superpowers/specs/2026-09-20-charitypilot-mcp-connector-audit-and-improvement-plan.md`
are complete except the remote transport. Read that audit before proposing
anything; its "What is still not built" section says what was left and why.

The owner has ruled on decision 8: they want to control the whole platform
without the UI, including the platform operator realm. That is the work.

## Do these in this order

### 1. Verify the deployment before building anything on top of it

The connector has never run against this build. Verify before assuming.

- `cd mcp && npm run build`, then
  `node dist/cli.js connect --profile vm` and `node dist/cli.js status`.
- Call `session_info` and read the `api` block. It reports the API's version
  and warns when the connector is newer than the API. If it warns, the deploy
  is behind and everything below is premature.
- Confirm `confluence_status` no longer 404s. On the previous deployment it
  did, because that build predated the integrations routes.
- Confirm the thirteen migrations dated `20260920*` are applied. The ones the
  connector depends on are `20260920090000_add_auth_session_data_scope` (the
  personal-data gate lives on the session, so a missing column means the gate
  silently falls back to a command-line flag) and
  `20260920110000_add_connector_idempotency_record` (a missing table makes
  every keyed create fail).
- Run one destructive action end to end: create a risk record, ask to delete
  it, confirm the refusal, approve at a terminal, confirm the deletion. Until
  today that path was broken in a way no unit test could see, so it is worth
  proving once against real data.

Report what you found before moving on. If any of it is wrong, stop and say so.

### 2. Fix the deploy gate's escape hatch

`scripts/bluegreen/migration-gate.mjs` blocks
`20260920010000_approval_binds_to_session_family` for renaming a column. The
rename is safe: it renames a column on `AuthActionApproval`, a table created by
`20260920000000` in the same pending batch, so the colour still serving traffic
has never seen that table. Somebody therefore had to deploy with
`--allow-destructive`, and a gate whose only exit is the override teaches
everyone to reach for the override. That file's own header says so.

Give it a proof-carrying exemption: a `DROP COLUMN`, `RENAME COLUMN`,
`RENAME TO` or `SET NOT NULL` on a table created by an earlier migration in the
same pending batch is expand/contract-safe. The gate already receives the whole
pending batch in `gateMigrations`, so the evidence is in hand. Pin it in both
directions in `migration-gate.test.mjs`: the exemption must apply to a
same-batch table and must not apply to a table that already existed.

### 3. Build the operator connector

This is the substantial piece. **Use the brainstorming skill first** — it is
architectural, not bounded, and the shape below is a sketch rather than a
design.

What exists today:

- Five capability routes: `GET /owner/tenants`, `GET /owner/tenants/:id`,
  `POST /owner/tenants`, `PATCH /owner/tenants/:id/configuration`,
  `POST /owner/tenants/:id/lifecycle`. Plus `GET /owner/tenants/:id/history`.
- A separate credential realm: `PlatformOperator`, `PlatformOperatorSession`,
  a TOTP second factor with recovery codes, and `requirePlatformOperator`.
- The tenant summary an operator can read is name, registration numbers,
  lifecycle status, created date, plan, subscription status and a user count.
  No governance records, no personal data. Keep it that way.

Three things make this harder than it looks, and all three must be in the
design:

1. **The operator login sets cookies and returns no tokens in the body.** The
   connector cannot use cookies; the whole connector auth design is body
   tokens with no cookie, and `non-browser-client.ts` refuses anything carrying
   browser evidence. This needs connector-shaped operator auth routes, exactly
   as the charity connector needed `/api/v1/auth/connector/*`. The TOTP code is
   typed at connect, not at serve.
2. **`PlatformOperatorSession` carries no posture.** The charity `AuthSession`
   has `clientKind`, `accessLevel`, `dataScope` and a family pinned by database
   triggers. The operator session has none of that. Decide whether to add the
   same columns or to keep operator sessions deliberately simpler, and say why.
3. **`AuthActionApproval.organisationId` is NOT NULL with a foreign key to
   `Organisation`.** An operator action has no organisation, so the existing
   approval machinery cannot be reused unchanged. Either generalise the table
   or give the operator realm its own. Whichever you choose, every operator
   write gets an approval: closing a charity is the most destructive action in
   the product and it reaches across tenants, so a mistake is not contained the
   way a charity connector's is.

Suggested surface, to be argued rather than assumed:
`charitypilot-mcp connect --realm operator`, a separate keychain entry, tools
`tenant_list`, `tenant_get`, `tenant_history`, `tenant_create`,
`tenant_configure`, `tenant_lifecycle`, and a hard refusal to read any
charity's governance records through this realm.

### 4. The small ones

- **Publishing.** `mcp/package.json` is marked `private: true`. Everything else
  a publish needs is in place and `packaging.test.ts` asserts what the tarball
  would contain. Removing that line and running `npm publish` is the owner's,
  because it claims a public name.
- **`mcpb pack`.** Must run on the platform the bundle is for: it embeds
  `@napi-rs/keyring`, a native module.
- **The terminal checklist in `mcp/HANDOVER.md`.** `approve` refuses unless
  standard input is a terminal, and under Git Bash on Windows that is often
  false. It has never been typed at a real keyboard. This needs a person.

### Still blocked, do not start

- **The remote transport.** The design is
  `docs/superpowers/specs/2026-09-20-charitypilot-mcp-remote-transport-design.md`.
  This deployment does not unblock it: the server is on a Tailscale address, so
  a model provider's servers cannot reach it. It needs a publicly reachable
  host and a data protection review, in that order.
- **Confluence setup tools.** Deferred until the publishing model is agreed
  with the data protection officer.

## How this repository expects work to be proved

Read `mcp/HANDOVER.md` and the memory note
`fastify-guards-must-return-the-reply` before writing any guard. Then:

- Every new guard gets a mutation canary. `scripts/api-guard-canary.mjs` runs
  unit-level ones in seconds; `scripts/mcp-live-canary.mjs` runs live ones
  against a real stack. A green test proves nothing until it has been shown to
  go red. Thirty-one canaries exist; add to them.
- Tests run from `dist/`, with `node:test`. There is no Vitest.
- Two coverage tests refuse to let a route go unnoticed: every readable and
  every mutating route must be a tool or carry a written reason for not being
  one. Adding owner routes will trip both. That is the guard working.
- `npm run test:e2e:mcp` drives the built connector over stdio against a
  disposable Docker stack. A new table must be listed in
  `e2e/helpers/database-safety.cjs` or the reset refuses to prove itself and no
  live test runs at all.
- Never write a file containing a backslash through a bash heredoc. It strips
  them, tests stay green, and `git` calling a source file binary is the only
  signal. Use the Write or Edit tools.
- Work on `master`. No worktrees, no feature branches.
- Another session may be working in this checkout. Stage explicit paths, never
  `git add -A`, and check before every commit that you are not carrying
  somebody else's work.
