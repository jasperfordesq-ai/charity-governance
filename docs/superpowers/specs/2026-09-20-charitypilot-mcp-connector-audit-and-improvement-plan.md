# CharityPilot MCP connector: audit and improvement plan

Written 2026-09-20 against `master` at `fa0dd68`, after reading every source file in
`mcp/`, the API code that enforces the connector's limits, the seven specs and plans
under `docs/superpowers/`, the live suite, and the current Model Context Protocol
specification. Nothing was changed. This document is the deliverable; each phase in
Part 2 becomes its own implementation plan once the owner has ruled on the decisions in
Part 3.

**The brief:** the connector should be as good as the connectors the large vendors ship,
for CharityPilot's purposes, and the owner should be able to do everything the platform
does without opening the web application.

## Status, end of 2026-09-20

Phases A to H were worked through in one session after the owner asked for it.
What each added is in `mcp/HANDOVER.md`; the plans are
`2026-09-20-charitypilot-mcp-phase-a-b-defects-and-legibility.md` and
`2026-09-20-charitypilot-mcp-phase-c-surface.md`.

| Phase | State |
| --- | --- |
| A, defects | Built, except the terminal checklist (the owner's to run) and the `document_delete` API fix, which belongs to the other session's Confluence Tier 1 plan |
| B, legibility | Built |
| C, surface gaps | Built, except Confluence setup tools, deliberately deferred |
| D, gate as session posture | Built; the role floor is owner or administrator and wants the DPO's confirmation |
| E, credentials and packaging | Built; publishing to npm and packing the bundle are the owner's to do |
| F, search and workflows | Built: prompts, field selection, the search route and tool, fetch by reference, and resources |
| G, remote transport | **Designed, not built**, in `2026-09-20-charitypilot-mcp-remote-transport-design.md`. Blocked on the hosting move and the DPO review |
| H, API hardening | Built: the stale-write refusal on five routes, idempotency keys, the connector read budget, the three missing routes and the build identifier |

The nine decisions in Part 3 were taken as recommended, except Confluence setup
(deferred) and an operator connector (not started). Each is reversible and
recorded in the commit that made it.

### What is still not built

Everything below is a deliberate choice, not an oversight.

- **The remote transport (Phase G).** Designed only. It is the first time a
  model provider's servers would reach the API directly, so the DPO should see
  the design before it is built, and it is blocked on the hosting move either
  way. The design recommends shipping it read-only first.
- **Confluence setup tools.** Connecting, disconnecting and choosing a publish
  space stay out of the connector. Disconnecting deletes mirrored pages, which
  the owner's 2026-09-19 ruling forbids CharityPilot from doing, and choosing a
  space is a decision made once while looking at a list of spaces.
- **Erasing a Confluence page.** Excluded on the Confluence session’s own
  ruling: it is the last way CharityPilot can destroy a page in a charity’s
  site, and the typed confirmation phrase it demands only means something if a
  person types it.
- **An operator connector.** Not started. The `/owner` realm is a separate
  credential and a separate cookie scope, and a connector that signed in there
  would not be acting as the person running it.
- **Publishing.** `npm publish` and `mcpb pack` are the owner’s to run, as is
  the terminal checklist for `approve`.
- **The deploy.** None of this is on the VM. Everything here is committed and
  unpushed, by the owner’s decision while a second session shares the checkout.

### Ranking, and when to revisit it

Search is a case-insensitive substring match rather than Postgres full text.
At a charity’s size that is immediate and it finds partial words, which is
what somebody typing expects. The trade is that results are ordered by kind
and recency rather than by relevance. Revisit it when a single charity’s
minute book passes a few thousand resolutions.

## Summary

The connector's security posture is already better than most vendor connectors. The
parts that matter most are enforced by the API rather than the client: an access level
pinned to the session by database triggers, per-action approval bound to a digest of the
exact request and typed at a terminal, an append-only record of every connector write,
a credential bound to the host that issued it, and coverage tests that force every API
route to be either a tool or a written-down exclusion. The live suite and its canaries
are the kind of evidence most connectors never produce. None of that should change.

Where it falls short of the vendor connectors is everything an agent needs in order to
use it well, and everything a person needs in order to install and trust it:

- **It does not tell the agent who it is.** There is no identity tool, no server
  instructions, no tool annotations, no structured output. Every vendor connector has
  the first two; the last two are what lets a client decide when to ask before acting.
- **Refusals are opaque.** A validation failure loses its field details and a conflict
  becomes "CharityPilot returned 409", so the agent cannot correct itself.
- **The person approving a removal types their password before seeing what they are
  approving**, and the summary never names the record.
- **A fifth of the web application is unreachable**: team management, billing status,
  the compliance report export, reminder history, session review and the Confluence
  setup routes are all excluded by policy, although the API already gates every
  destructive team route behind the same level check and approval the connector relies
  on elsewhere.
- **The personal-data gate is a command-line flag** in the client's configuration file,
  which the connector's own threat model treats as attacker-writable when it comes to
  the base URL.
- **It is one credential, one host, installed by cloning and building.** Vendor
  connectors are one click, and increasingly remote.

Two defects should be fixed before the connector is used against real data at
administrator level: the approve flow (D2, D3) and the `status` report (D1). One
policy conflict must be resolved before `document_delete` is used against a charity with
Confluence connected (D5).

### Scorecard

Judged against the GitHub, Atlassian, Notion, Vercel and Azure connectors as they
present themselves in their documentation and in the tool listings available to this
session. "Vendor norm" is what most of them do, not what all of them do.

| Dimension | CharityPilot today | Vendor norm | Verdict |
| --- | --- | --- | --- |
| Least privilege | Session-level READ/WRITE/ADMIN, DB-pinned, chosen at password time | Read-only switch, OAuth scopes | Ahead |
| Destructive-action gating | Per-action approval, digest-bound, single-use, terminal password | Quote-then-confirm tool, client permission prompt | Ahead on strength, behind on ergonomics |
| Audit trail | Append-only row for every connector write, refusals included | Provider-side audit logs | Ahead |
| Credential handling | OS keychain, origin-bound, rotation, cross-channel refusal | OAuth tokens in memory or keychain | Level |
| Tenant isolation | Proven live in both directions | Assumed from provider | Ahead |
| Route coverage discipline | Every route is a tool or a written exclusion, tested | None | Ahead |
| Identity/context tool | None | `whoami`, `atlassianUserInfo`, `get_user_context` | Behind |
| Server instructions | None | Nearly all | Behind |
| Tool annotations | None | GitHub and others set `readOnlyHint`/`destructiveHint` | Behind |
| Structured output | Text block of JSON | `structuredContent` with `outputSchema` increasingly | Behind |
| Actionable errors | Status code only, except five codes | Field-level details, retry guidance | Behind |
| Search | None (API has no search) | `search` is universal; `search`+`fetch` is the connector contract for deep-research clients | Behind |
| Response slimming | None | `fields`, `responseFields`, `view` presets | Behind |
| Toolsets / grouping | 63 tools always listed | GitHub toolsets, Atlassian discover-then-execute | Behind |
| Prompts / resources | None | Sparse, but present where workflows are multi-step | Behind |
| Breadth of surface | Records: complete. Team, billing, export, integrations: excluded | Everything the account may do | Behind |
| Install | Clone, `npm install`, build, edit JSON by hand | One click, `npx`, `.mcpb` bundle, remote URL | Behind |
| Transport | stdio only | Remote Streamable HTTP + OAuth, with stdio as fallback | Behind, and blocked by hosting |
| Multiple environments | One keychain slot | Per-profile credentials | Behind |
| Documentation | Excellent README and handover | Adequate | Ahead |
| Test evidence | 214 unit, 53 live, 9 canaries, CI runs both | Unit tests | Ahead |

## Part 1: Audit findings

### 1.1 What is right and must be kept

- **All limits live in the API.** `authGuard` refuses unsafe methods on a READ session
  for every route without per-route wiring. `requireSessionLevel('ADMIN')` and
  `requireActionApproval()` sit on the destructive routes, and a source test catches a
  destructive route added without them. The connector's own checks are convenience.
- **The approval design.** Family-bound, digest-bound, single-use, five-minute expiry,
  minted unapproved so only the password route can approve it, every failure reported
  identically. Refusing a time window was the right call and the reasoning is recorded.
- **The credential design.** Origin-bound keychain entry, refresh rotation with family
  quarantine on replay, and a `disconnect` that revokes server-side and only then clears.
  A wrong host is printed before the password is typed.
- **The coverage tests.** `route-coverage.ts` and `mutating-route-coverage.ts` are the
  single best idea in the package: a route added to the API forces a decision.
- **The field policy.** An allowlist that fails closed, a schema-drift test against the
  Prisma schema with a hardcoded list of models that must stay gated, and shapes for the
  five mixed payloads. The rule that a write of a withheld field is refused per call,
  derived from the same allowlist, is exactly right.
- **Hand-written validation with two runtime dependencies.** Correct for code that runs
  beside the operator's credential. Nothing below asks for a third dependency; the SDK
  already carries `zod`, so even a future move to `McpServer.registerTool` adds none.
- **No generic call-any-endpoint tool and no response cache.** Both exclusions stand.
- **The live suite iterating the advertised tool list**, and the canaries. The testing
  memory's rule applies to everything proposed here: a green suite proves nothing until
  the canary has gone red.

### 1.2 Defects

Ordered by consequence. Each names the file so the fix can be scoped.

**D1. `status` reports the flag, not the level the session holds.**
`mcp/src/cli.ts:125` prints `config.accessLevel`, which defaults to `write` when the
flag is omitted. Connect with `--access-level read`, run `status` without the flag, and
it says WRITE. The README promises the opposite ("asks the API what the level actually
is"). Fix: call `GET /api/v1/auth/connector/session` and print what it returns, falling
back to "unknown (API predates this route)". The same applies to the personal-data line,
which today prints the flag.

**D2. `approve` asks for the password before showing what is being approved.**
`mcp/src/cli.ts:89-101` prints the target and the identifier, prompts for the password,
and prints the server's summary only after success. The Phase 3 plan (Task 7) specified
"prints the server's summary before prompting". The person is therefore typing their
password to approve something they have to take the agent's word for. Fix needs an API
read: `GET /api/v1/auth/connector/approvals/:id` under `authGuard`, returning the
summary, route, resource identifier and expiry for an approval belonging to the caller,
and nothing for one that does not. `approve` fetches it, prints it, then prompts.

**D3. The approval summary never names the record.**
`summarise()` in `apps/api/src/middleware/action-approval.ts` builds the text from the
route pattern alone: "Permanently delete: board members (DELETE)". Which board member is
not stated, and the row does not store the resource identifier although the activity
log does. Fix: store `resourceId`; extend `summarise` with a per-route lookup that names
the record from the database at mint time ("Permanently delete board member 'Aoife
Chairperson' (appointed 2021-03-02)"), falling back to the identifier. The lookup must
read only allowlisted display fields, because this text is shown to a person who may
not have opened the personal-data gate; a trustee's name is safe, a member's is not.

**D4. Refusals are opaque to the agent.**
`ApiClient.#refusalMessage` in `mcp/src/client.ts` quotes the server's `error` text for
five codes and reduces everything else to "CharityPilot returned NNN." The consequences:

- A `VALIDATION_ERROR` arrives without its `details[]`, so the agent does not learn
  which field was wrong. The MCP specification's 2025-11-25 guidance is explicit that
  validation errors should be returned so the model can correct itself.
- A 409 (`DEADLINE_UPDATE_CONFLICT`, `ORGANISATION_UPDATE_CONFLICT`,
  `CONCURRENCY_CONFLICT`, `GENERATED_DEADLINE_IMMUTABLE`, `DEADLINE_SUPERSEDED`, …)
  gives no hint that the answer is "re-read the record and retry".
- A 403 does not distinguish a role refusal (`FORBIDDEN`) from a plan refusal
  (`PLAN_FEATURE_UNAVAILABLE`) from a session-level refusal.
- A 404 does not distinguish "no such record" from "this API predates the route".
- A 429 from the shared address limiter drops the `retry-after` header.

The caution behind the allowlist is sound: server text written for another audience
may carry detail that should not reach a model. The fix is a wider allowlist of codes
whose `error` text is known to be safe, plus forwarding of `details[].field` and
`details[].message` for validation errors, plus a connector-written guidance line per
code family ("The record changed since you read it. Read it again and retry with the
new updatedAt."). Part 2, Phase B, also gives errors a structured form.

**D5. `document_delete` advertises behaviour the owner has ruled out.**
The tool description in `mcp/src/write-tools.ts` says "Where the charity mirrors
documents to Confluence, the mirrored page is removed too." The owner's written ruling
to the DPO (2026-09-19) is that an ordinary deletion removes CharityPilot's record and
reference only, and destroying the Confluence source needs an explicit erasure
workflow. The API has not yet been changed: `DocumentService.enqueueConfluenceErasure`
(`apps/api/src/services/document.service.ts:1013`) still enqueues a `confluence`
erasure row from the ordinary delete path when a publication names a page. Until that
API change lands, an agent calling `document_delete` on a published document, with the
owner's approval, deletes and purges the Confluence page. This is an API change that is
already ruled and owed; the connector's part is to stop describing the behaviour and, as
a belt-and-braces measure until the API is fixed, to refuse `document_delete` for a
document whose metadata shows a Confluence publication.

**D6. The README's Windows configuration snippets are not valid JSON.**
`mcp/README.md`, "Testing against a local stack": the paths
`C:\platforms\htdocs\charity-governence\mcp\dist\cli.js` and
`C:\Users\jaspe\.charitypilot-mcp-local.json` are written with single backslashes inside
JSON strings. `\p`, `\h`, `\c`, `\d`, `\U` and `\.` are invalid escapes; a client that
parses the snippet will refuse the file. They need doubling or forward slashes. The
handover also still says "changes records through 17 more" where the README table shows
34 write tools.

**D7. The personal-data gate is a command-line flag in the client's configuration.**
The connector's threat model already treats the MCP client configuration file and the
environment as attacker-writable: that is why the credential is bound to the origin, so a
redirected `--base-url` cannot receive a live token. The same file carries
`--allow-personal-data`. A coding agent with write access to `.mcp.json` or
`claude_desktop_config.json`, or any process running as the operator, opens the gate
without a password. The spec recorded the MEMBER-role case as a DPO flag; this is the
stronger form of the same problem, and it is the one control in the design whose
authority is not fixed at password time. Part 2, Phase D, moves it onto the session.

**D8. One credential slot per machine.**
`credentials.ts` uses a fixed service and account name, so the keychain holds one
refresh token. Connecting to the VM and to a future production host, or to two
charities, means disconnecting in between. The full-access spec's Phase 2 connector
section planned `refresh-token:<profile>` accounts and named profiles with pinned
origins (`local|e2e|vm|prod`); only `local` was built. The local file store exists
precisely because the harness would otherwise clobber the owner's one real entry.

**D9. `approve` has never been typed at a real terminal, and Windows terminals differ.**
The handover says so for the raw-mode prompt. `approve` additionally refuses unless
`stdin.isTTY` is true, and under Git Bash's mintty on Windows that is often false for a
Node process, so the one command that only a person can run may refuse the person.
Needs verification in Windows Terminal, PowerShell, Git Bash and macOS Terminal, with
an accented password, before anyone depends on it.

**D10. The advertised level is pinned on the first answer, including a failed one.**
`startServer` in `mcp/src/server.ts` resolves the posture once; if the API was
unreachable at that moment it caches `config.accessLevel` for the life of the process
and never asks again. A transient outage on the first call therefore advertises the
wrong tool list until the client restarts the connector. Fix: cache only a successful
answer; retry a `null`.

**D11. `document_download` has no retry on an expired access token.**
`ApiClient.download` builds its own request and does not share `#send`'s one-shot 401
retry. Fifteen minutes after the last call, a download fails with "CharityPilot returned
401." rather than refreshing. Every other verb refreshes silently.

**D12. Voiding a minute re-mints the approval if the reason is reworded.**
`governing_act_void` carries `reason` in the body, so it is part of the digest. After
the person approves, the agent must repeat the identical reason string or the digest
changes and a fresh approval is minted. Correct, but a trap; the refusal text should say
"call again with exactly the same arguments plus `approvalId`", and the connector
should echo the arguments it will need.

**D13. No `--help`, no `--version`.** `parseArgs` throws "Unknown option: --help".

**D14. Several update tools cannot detect a stale read.**
`board_member_update`, `conflict_update`, `risk_update`, `complaint_update` and
`fundraising_update` carry no `expectedUpdatedAt` because their API routes accept none.
An agent working from a record read an hour ago overwrites whatever changed in between.
An API gap the connector exposes; see Phase H.

### 1.3 What the web application can do that the connector cannot

Every page under `apps/web/src/app/(dashboard)` was compared with the tool list. The
records pages (dashboard, compliance, board, minute book, registers, deadlines,
documents, organisation) are fully covered. The gaps:

| Page | Capability | API route | Connector | Notes |
| --- | --- | --- | --- | --- |
| Team | Invite a colleague | `POST /team/invites` | Excluded | The token is hashed at rest. With email delivery the API sends the link and returns a message; on a deployment using manual link delivery (the personal server) the route returns `manualInviteUrl`, which is a credential to join the charity |
| Team | Reissue an invite link | `POST /team/invites/:id/link` | Excluded | Manual-link deployments only; returns the credential |
| Team | Revoke an invite | `DELETE /team/invites/:id` | Excluded | API already requires ADMIN + approval |
| Team | Change a role | `PATCH /team/members/:id/role` | Excluded | API already requires ADMIN + approval |
| Team | Suspend / reactivate / remove | `POST /team/members/:id/{suspend,reactivate,remove}` | Excluded | Suspend and remove already require ADMIN + approval |
| Team | See a colleague's sessions | `GET /team/members/:id/sessions` | Excluded | Device labels and times; gate-able (labels withheld when closed) |
| Team | Revoke sessions | `POST /team/members/:id/sessions/…/revoke…` | Excluded | API already requires ADMIN + approval |
| Team | Security audit | `GET /team/security-audit` | Excluded | Names and operator reasons; gate-able |
| Team | Transfer ownership | `POST /team/ownership/transfer` | Excluded | Signs the caller out; keep excluded |
| Billing | See plan and status | `GET /billing/status` | Excluded | Read-only; the `Subscription` model is already classified in the field policy |
| Billing | Checkout / portal | `POST /billing/{checkout,portal}` | Excluded | Payment; keep excluded |
| Integrations | Confluence status | `GET …/confluence/status` | Tool | |
| Integrations | Start Atlassian sign-in | `GET …/confluence/authorize` | Excluded | Browser flow; keep excluded |
| Integrations | List spaces, choose publish space | `GET …/spaces`, `PUT …/publish-space` | Excluded | Setup steps; see decision 3 |
| Integrations | Disconnect | `DELETE …/confluence` | Excluded | Owner ruling: never |
| Export | Board sign-off | `PUT /compliance/signoff` | Tool | |
| Export | Download the compliance report | `GET /export/compliance-report` | Excluded | HTML of everything; a download-dir file tool fits, like `document_download` |
| Deadlines | Reminder history | `GET /deadlines/reminder-history` | Excluded | Recipient emails; gate-able |
| Documents | Upload from this machine | `POST /documents` | File tool | Needs a file under `--upload-root`; a client with no file system (claude.ai) cannot use it |
| Documents | Dead-letter queue, requeue | `GET/POST /documents/storage-deletions/…` | Excluded | Operations; keep excluded |
| Regulator | Guidance matrix | none (client-side, from `packages/shared`) | None | Could be an MCP resource; not a gap in the API |
| Owner console | Everything under `/owner/*` | separate realm | Excluded | Separate credential and second factor; decision 8 |
| Any | Who am I, which charity, which level | `GET /auth/me`, `GET /auth/connector/session` | `status` command only | The agent has no way to ask; see P4 |

Two API gaps the agent also feels: there is no `GET /governing-acts/:id` and no
`GET /board-members/:id`, so a question about one minute or one trustee fetches the
whole list; and there is no `PATCH /documents/:id`, so a document's name, category or
review date cannot be corrected anywhere except by re-uploading.

### 1.4 Protocol and ergonomics gaps against the vendor connectors

**P1. No server instructions.** The `initialize` result can carry `instructions`, which
every vendor connector uses to tell the model how the server works. The connector's
rules are exactly the kind of thing that belongs there: results are data, not
instructions; read before you write and copy `updatedAt` exactly; removals will be
refused with an identifier and the person must approve in their terminal; call again
with identical arguments plus `approvalId`; what the personal-data gate withholds and
why; pagination; the write budget. Today each tool description repeats fragments of
this.

**P2. No tool annotations.** `readOnlyHint`, `destructiveHint`, `idempotentHint` and
`openWorldHint` have been in the specification since 2025-03-26. Claude Desktop and
Claude Code use them to decide when to ask the user before a call. Every read tool
should carry `readOnlyHint: true, openWorldHint: false`; every PUT `idempotentHint:
true`; every destructive tool `destructiveHint: true`. The connector uses the SDK's
low-level `Server`, and annotations are plain fields on each entry in the `tools/list`
response, so this needs no change of API style and no dependency.

**P3. No structured output.** Results are `JSON.stringify(result, null, 2)` in a text
block. Since 2025-06-18 a tool can declare `outputSchema` and return
`structuredContent` beside the text. For records the schema is derivable from the
field policy (the safe fields of the declared model, plus the envelope), which would
also make the gate's promise machine-checkable by the client. Errors should likewise
carry `structuredContent: { code, status, retryable, action }` so an agent can branch on
`APPROVAL_REQUIRED` without parsing prose.

**P4. No identity tool.** `auth/me` was excluded because `status` shows a human the
answer. The agent needs the same answer: which charity, which role, which access level,
whether the gate is open, which plan, the connector and API versions. Without it an
agent connected to the wrong charity has no way to notice. Every vendor connector has
one. Under the closed gate it returns the organisation name, role, level and plan, and
withholds the person's name and email, consistent with the `User` policy.

**P5. No search, no fetch-by-reference, no resources.** The API has no search route, so
"find the minute where we approved the safeguarding policy" is a full list and a scan.
`search` is universal among vendor connectors, and a `search`/`fetch` pair is the
contract deep-research clients expect. MCP resources (`charitypilot://document/{id}`)
would let a client attach a document's metadata to a conversation without a tool call.

**P6. No prompts.** MCP prompts are reusable, parameterised recipes the client offers
the user. The multi-step things the web application walks a person through are exactly
this: prepare for a board meeting, record a meeting and its resolutions, check annual
return readiness, run a governance health check. They cost nothing at runtime and they
encode the order of operations an agent otherwise has to infer.

**P7. Sixty-three tools, always.** Every client loads every tool description into
context on every conversation. GitHub solved this with toolsets (`--toolsets
repos,issues`) and Atlassian with discover-then-execute. A `--toolsets` flag
(`compliance, minute-book, registers, board, deadlines, documents, team, admin`) with a
sensible default, plus shorter descriptions once the shared rules move into
`instructions`, halves the context cost without hiding anything.

**P8. No response slimming.** `governing_acts` with the gate open returns every
resolution's full text for every minute. Atlassian's `responseFields` and GitHub's
`fields` exist for this. A `fields` argument on list tools, validated against the
model's safe fields, is cheap.

**P9. stdio only.** The vendor connectors are remote: a URL, OAuth in the browser, no
install, usable from claude.ai on the web and on a phone. The connector requires Node,
a clone, a build and Tailscale on every machine. Remote transport is the largest single
gap and also the one that cannot be closed yet: claude.ai's servers cannot reach a
Tailscale-only host, and the DPO's order of work puts the hosting move first. It also
changes how approval works, because there is no terminal beside a phone. Phase G
designs for it without building it.

**P10. Install is manual.** No npm publication (`npx charitypilot-mcp`), no `.mcpb`
bundle for one-click install in Claude Desktop with `user_config` for the access level
and directories, no `claude mcp add` one-liner in the README.

**P11. No idempotency key on creates.** A network failure after the API commits a
`POST` and before the connector reads the response leaves the agent unsure, and a retry
creates a duplicate. Vendor APIs accept an `Idempotency-Key`; the activity log already
has a natural place to store one.

**P12. No diagnostics.** Nothing is written to stderr except a fatal error. The
specification (2025-11-25) says a stdio server may log freely to stderr, and the
revision the specification site now serves as latest (dated 2026-07-28) deprecates the
protocol-level logging feature in favour of exactly that. A `--verbose` flag writing
redacted request lines to stderr is the right shape.

**P13. Protocol version drift.** The installed SDK is 1.30.0, speaking 2025-11-25. The
2026-07-28 revision removes the initialize handshake and the session header, replaces
server-initiated elicitation with multi-round-trip results, and adds `server/discover`.
None of that needs action now: annotations, structured output, instructions, resources
and prompts are stable across all of these revisions, and the SDK will carry the
transport changes. What does need action is `"^1.0.0"` in `mcp/package.json`, which the
spec said would be an exact pin and is not.

## Part 2: Improvement plan

Eight phases. A, B and E touch only the connector and need no deploy. C, D, F, G and H
change the API and therefore ride the blue-green deploy, which is the owner's decision.
Each phase gets its own plan under `docs/superpowers/plans/` once approved, written in
the repo's task-and-step form, with a canary for every test. Effort is a rough
engineering estimate for one agent with review, not a commitment.

### Phase A: fix the defects (connector, plus one small API read)

Goal: nothing in Part 1.2 is true any more, except D7, D8 and D14, which have their own
phases.

- **D1** `status` reports the level and posture the API returns.
- **D2, D3** `GET /api/v1/auth/connector/approvals/:id` (own approvals only, same
  opaque refusal otherwise); `AuthActionApproval.resourceId`; per-route display-name
  lookup in `summarise` reading allowlisted fields only; `approve` prints the summary
  before the password prompt and refuses if the fetch fails. Live assertion: the summary
  printed names the seeded trustee; canary: blank the lookup and watch it go red.
- **D4** Wider quotable-code allowlist; `details[]` forwarded for `VALIDATION_ERROR`;
  a guidance line per code family; `retry-after` surfaced on 429. Unit test per family;
  canary: drop a code from the allowlist.
- **D5** Remove the Confluence sentence from `document_delete`; refuse the call when the
  document's metadata shows a Confluence publication until the API change lands, with a
  message saying why. Separately, the API change the owner already ruled on
  (`enqueueConfluenceErasure` off the ordinary delete path) is owed regardless of the
  connector and should be scheduled first.
- **D6** README JSON fixed; handover count fixed.
- **D10** Cache only a successful posture.
- **D11** `download` shares the 401 retry.
- **D12** Refusal text says "identical arguments plus `approvalId`".
- **D13** `--help`, `--version`.
- **D9** A checklist, run by the owner, on each terminal they use; results recorded in
  the handover. If mintty fails the TTY check, document Windows Terminal as the
  supported terminal rather than weakening the check.
- **P13** Pin the SDK exactly.

Effort: two days. No decision needed, except that D5's API half depends on the owner
scheduling it.

### Phase B: make the connector legible to the agent (connector only)

Goal: an agent that has never seen CharityPilot can use the connector correctly from the
tool list alone, and a client can tell which calls need a human's nod.

- **P1** `instructions` on `initialize`, drafted from the README's rules and the
  DATA_NOTE, and the per-tool descriptions shortened to what is specific to each tool.
- **P2** Annotations on every tool, derived from the definition: `readOnlyHint` from
  the absence of `method`, `destructiveHint` from `destructive`, `idempotentHint` for
  PUT and for reads, `openWorldHint: false` throughout. A test asserts the derivation
  for every tool; canary: mark a delete non-destructive.
- **P3** `outputSchema` generated from the field policy for model-gated tools and
  written by hand for the five shapes; `structuredContent` beside the text; errors as
  `{ isError: true, structuredContent: { code, status, retryable, action } }`. The live
  suite asserts structured content matches the text for every advertised tool.
- **P4** `session_info` tool: organisation name and identifier, role, access level,
  gate state, plan, connector version, API build if the health route exposes it to an
  authenticated caller, and the remaining write budget if the API reports it. Names and
  emails follow the `User` policy. Also fold `auth/me` out of the exclusion list.
- **P7** `--toolsets` with groups named in the tool definitions; default is every
  group; `--toolsets read-only` as an alias for the read half. The coverage tests are
  unchanged because grouping does not remove a tool from `TOOLS`.
- **P12** `--verbose` stderr diagnostics through `redactSecrets`.

Effort: two to three days. No decision needed.

### Phase C: close the surface gaps (connector and API; decisions 1 to 4)

Goal: the owner can do from the connector everything they can do on the Team, Billing,
Export, Deadlines and Integrations pages that does not involve a browser redirect or a
payment.

- **Team**, all at ADMIN level: `team_invite_create` (returns identifier, role and
  expiry, never the link; where the API answers with `manualInviteUrl` because the
  deployment delivers invites by hand, the connector writes it to `--download-dir` with
  owner-only permissions and returns the path, the same "path not bytes" rule as
  `document_download`, so a join credential never enters the model's context; without
  a download directory the tool is refused on such a deployment), `team_invite_revoke`,
  `team_role_set`, `team_member_suspend`, `team_member_reactivate`,
  `team_member_remove`, `team_sessions_list` (gated: labels withheld when closed),
  `team_session_revoke`, `team_sessions_revoke_all`, `security_audit` (gated). The API
  already wraps every destructive one of these in `requireSessionLevel('ADMIN')` and
  `requireActionApproval()`; `reactivate` and `invites` should gain the level check for
  consistency. Ownership transfer stays excluded. Invite-link reissue stays excluded in
  this phase; if the download-directory rule above proves workable for creation, reissue
  can follow it later under approval.
- **`billing_status`** read tool, gated as `Subscription`. Checkout and portal stay out.
- **`report_export`** file tool under `--download-dir`, same containment and same
  "path not bytes" rule as `document_download`, with the year as an argument. With the
  gate closed the file is still written, because a person will read it, but the tool
  returns only the path.
- **`deadlines_reminder_history`** gated: recipient address withheld when closed.
- **`document_upload_text`**: content in the argument, `text/plain` or `text/csv` only,
  capped well under the API's 10 MB, so a client with no file system can still file a
  note or a register export. Same activity row as any upload.
- **Confluence setup** (`confluence_spaces`, `confluence_publish_space_set`) only if
  decision 3 says yes; both at ADMIN, the setter under approval because it decides
  where a charity's documents are mirrored.
- **Approval from the web application** (decision 4): a page listing the signed-in
  person's pending approvals, granting one after re-entering the password. The same
  `AuthActionApproval` row, the same digest, the same single use; only the terminal is
  replaced. The original objection (a web session should not train people to type
  passwords at prompts) was about ordinary deletes in a web session; this is a deliberate
  re-authentication on a dedicated page, the pattern GitHub's "sudo mode" uses. A trustee
  with Claude Desktop and no terminal cannot approve anything today; this is how they
  would. The terminal path stays.

Effort: three to four days plus the deploy.

### Phase D: the personal-data gate becomes session posture (API and connector; decision 5)

Goal: opening the gate costs a password, is refused by the API for roles the DPO has
not cleared, is visible to the owner on the Team page, and cannot be done by editing a
file.

- `AuthSession.dataScope` (`WITHHELD | FULL`), default `WITHHELD` for connector
  sessions and `FULL` for web sessions (which is what they are today), immutable, pinned
  per family by the existing trigger pattern, copied in `rotateSessionTokens`. The
  session-posture memory's trap applies: copy it in rotation and pin it in the trigger or
  it silently reverts.
- `POST /auth/connector/login` accepts `dataScope`; the API refuses `FULL` for any role
  below the floor the DPO sets (recommendation: OWNER and ADMIN). Returned by
  `GET /auth/connector/session`.
- The connector reads the scope from the API and applies the field policy accordingly.
  `--allow-personal-data` becomes `connect --data-scope full`, printed before the
  password like the access level. The `serve` flag is honoured only on the local profile
  or when the API predates the column, and `status` says which.
- Team page badge shows the scope beside the level.
- Later, optionally: the API applies the same allowlist itself for `WITHHELD` connector
  sessions, which would make the gate hold even against a modified connector. Not
  proposed now, because it duplicates the policy in two codebases; recorded as the next
  step if the DPO wants the guarantee to be server-side.

Effort: two to three days plus the deploy. DPO consultation on the role floor.

### Phase E: environments, credentials and packaging (connector only)

Goal: one machine can hold a credential per environment; installing is one step.

- Keychain account keyed by origin (`refresh-token:<origin>`), with the plain-string
  and single-slot entries still honoured on read so nobody is logged out by upgrading.
- Named profiles with pinned origins as the spec planned (`local`, `vm`, and `prod`
  registered when the hosting move happens), `connect --profile vm`, `status` listing
  every stored credential and its host.
- Publish to npm as `charitypilot-mcp` so the client configuration is
  `npx -y charitypilot-mcp serve`, and a `claude mcp add` one-liner in the README.
- An `.mcpb` bundle for Claude Desktop with `user_config` for access level, upload root
  and download directory, built in CI from the same `dist/`.
- Headless Linux without a Secret Service: refuse with instructions rather than fall
  back silently; the file store stays local-profile only.
- The D9 terminal checklist, repeated after packaging, because a bundled runtime may
  differ from the operator's Node.

Effort: two to three days; the npm and bundle publication steps are the owner's to
perform.

### Phase F: search, resources and prompts (API and connector)

Goal: the agent can find a record by what it is about, and the client can offer the
platform's workflows as recipes.

- `GET /api/v1/search?q=&types=` in the API: tenant-scoped, over trustees, minutes and
  resolutions, the four registers, documents, deadlines and Governance Code standards,
  returning typed hits with identifiers and the matched field, paginated. Postgres full
  text is sufficient at this scale. Free-text matches are returned only on fields the
  field policy classifies safe unless the session's data scope is `FULL`, so a search
  cannot leak what a read would withhold.
- `search` tool over it, gated by a new `search` shape that applies each hit's model
  allowlist; a `fetch` tool taking a `charitypilot://<model>/<id>` reference so the
  connector meets the search/fetch contract deep-research clients expect.
- MCP resources: `charitypilot://document/{id}` (metadata), `charitypilot://standard/{code}`
  (the Code itself, reference data), `charitypilot://regulator-guidance` (the matrix in
  `packages/shared`).
- MCP prompts: `prepare_board_meeting`, `record_board_meeting` (create the act, then its
  resolutions, then link documents, in that order, with `updatedAt` handling spelled
  out), `annual_return_readiness`, `governance_health_check`, `onboard_trustee`.
- `fields` argument on list tools (P8), validated against the model's safe fields.

Effort: four to five days plus the deploy.

### Phase G: remote transport (API; decisions 6 and 7; after the hosting move)

Goal: connect from claude.ai on the web and on a phone, with no install, once the
platform is reachable from the public internet.

- Streamable HTTP endpoint served by the API process, using the SDK's transport and
  its OAuth 2.1 authorization-server router, with the API as the authorization server
  and Client ID Metadata Documents for registration (the 2025-11-25 recommendation).
  The consent screen chooses access level and data scope, so a remote session is minted
  with the same posture columns as a stdio one and the rest of the API does not know the
  difference.
- Protected-resource metadata at `.well-known`, and the connector's non-browser guard
  left exactly as it is for the stdio routes.
- Approval through the web page from Phase C, because a remote client has no terminal.
- stdio stays; the two transports share every tool definition.
- Build on the SDK's stable protocol version at the time, not the 2026-07-28 draft
  semantics, and let the SDK carry the transport changes.

This is blocked on Nikita's step 4 (hosting) and on a public origin, and it is the one
phase where the DPO should see the design before it is built, because it is the first
time a model provider's servers talk to the API directly.

Effort: one to two weeks.

### Phase H: API hardening the connector exposes (API)

- `Idempotency-Key` accepted on `POST` from connector sessions, stored on the activity
  row, replayed response for a repeat within the window.
- Connector reads get their own budget by identifying the session before the shared
  limiter runs (key on a hash of the bearer token, which is available before the
  session row is), closing the known limitation the write budget left open.
- `expectedUpdatedAt` on the five update routes that lack it (D14), and the connector
  requires it once the API accepts it.
- `GET /governing-acts/:id`, `GET /board-members/:id`, `PATCH /documents/:id`.
- The health route exposes the build identifier to an authenticated caller so
  `session_info` can warn when the connector is newer than the API.

Effort: three to four days plus the deploy.

### Suggested order

A → B → (deploy) → C and D together → E → F → H → G when hosting allows. A and B are
connector-only and can start now; C and D are the first that need the VM deployed with
the current build, which is already owed for the connector to sign in there at all.

## Part 3: Decisions needed

The engineering calls above are made; these are the owner's, with the DPO where marked.
Each phase names the decisions it depends on.

1. **Team management through the connector.** Recommendation: yes, at ADMIN level, with
   the approval the API already requires. Ownership transfer and invite-link reissue
   stay out.
2. **Billing status as a read tool.** Recommendation: yes. Checkout and portal stay out.
3. **Confluence spaces and publish-space through the connector.** Recommendation: defer.
   The DPO asked to agree the publishing model before more of it is built, and choosing
   the publish space is part of that model.
4. **Approval from the web application** as an alternative to the terminal.
   Recommendation: yes, because it is the only way a trustee without a terminal can
   approve anything, and because Phase G needs it.
5. **The personal-data gate as session posture**, and the role floor for `FULL`.
   Recommendation: yes; floor at OWNER and ADMIN. DPO.
6. **Remote transport**: build after the hosting move, with the DPO reviewing the design
   first. Recommendation: yes, in that order.
7. **The `document_delete` and Confluence conflict.** The API change is ruled and owed.
   Until it lands, should the connector refuse `document_delete` on published documents
   (recommended), or leave the tool as it is with the description corrected?
8. **An operator connector for the owner console.** Out of scope for this connector: a
   separate credential realm with a second factor and cross-tenant reach. If wanted, it
   is its own design, probably `charitypilot-mcp connect --realm operator` with the TOTP
   at connect time and approval on every write. Not recommended before the charity
   connector is deployed and in daily use.
9. **Publication**: npm package name and whether the `.mcpb` bundle is published or
   handed to trustees directly.

## Part 4: How each phase is proved

The method in the testing memory applies without exception: `node:test` from `dist/`,
mutation on a scratchpad copy, and a canary for every new guard with the canary form
stated. Additions specific to this plan:

- The live suite's hardcoded tool list grows with every phase; the moment of adding a
  name is the moment to ask whether the tool should exist.
- Every new tool gets a gate assertion in both states, and every new gated field gets
  a sentinel in the seed.
- Phase B's annotations and structured content are asserted for every advertised tool
  by iterating the list, never by name.
- Phase C's team tools are proved the way the register tools were: refused at WRITE,
  428 at ADMIN, approved once, refused the second time, activity row for each.
- Phase D's data scope is proved the way the access level was: a MEMBER refused `FULL`
  by the API, not by the connector; a rotation that drops the column fails the insert.
- Phase G is not green until a real claude.ai client has connected, chosen a level,
  been refused a removal, approved it on the web page, and seen the change.

## Appendix A: route inventory

Every `/api/v1` route the API registers, and the connector's position. "Tool" names the
tool; "excluded" points at the reason file; "proposed" names the phase.

| Method and route | Today | Proposed |
| --- | --- | --- |
| GET compliance/summary, principles, principles/:id, records, records/:id, signoff, approval-readiness | Tools | |
| PUT compliance/records/:standardId, signoff | Tools | |
| GET, PATCH organisation | Tools | |
| GET dashboard | Tool | |
| GET deadlines, deadlines/history | Tools | |
| GET deadlines/reminder-history | Excluded | C: gated tool |
| POST, PATCH, DELETE deadlines | Tools | |
| GET, POST board-members; PATCH, DELETE board-members/:id | Tools | H: GET by id |
| GET governing-acts, voids, board-submissions; POST, PATCH; POST :id/void; POST :id/resolutions; PATCH resolutions/:id; PATCH documents/:id/approval | Tools | H: GET by id |
| GET governance-registers/* (7); POST, PATCH, DELETE conflicts, risks, complaints, fundraising; PUT annual-report, financial-controls | Tools | |
| GET, POST members; PATCH members/:id | Tools | |
| GET documents, documents/:id; POST documents; DELETE documents/:id; POST :id/standards; DELETE :id/standards/:standardId | Tools | H: PATCH documents/:id |
| GET documents/:id/download | File tool | |
| GET documents/storage-deletions/dead-letter; POST …/:id/requeue | Excluded | Stays |
| GET team | Tool | |
| POST team/invites; DELETE team/invites/:id | Excluded | C |
| POST team/invites/:id/link | Excluded | Stays |
| PATCH team/members/:id/role; POST suspend, reactivate, remove | Excluded | C |
| GET team/members/:id/sessions; POST …/revoke, revoke-all | Excluded | C, gated |
| GET team/security-audit | Excluded | C, gated |
| POST team/ownership/transfer | Excluded | Stays |
| POST team/accept-invite | Excluded | Stays |
| GET billing/status | Excluded | C |
| POST billing/checkout, create-checkout, portal, create-portal | Excluded | Stays |
| GET integrations/confluence/status | Tool | |
| GET integrations/confluence/spaces; PUT publish-space | Excluded | Decision 3 |
| GET integrations/confluence/authorize; GET, POST callback; DELETE confluence | Excluded | Stays |
| GET export/compliance-record, compliance-report | Excluded | C: file tool |
| GET auth/me | Excluded | B: `session_info` |
| POST auth/* (browser realm, 8 routes) | Excluded | Stays |
| POST auth/connector/login, refresh, logout, approve; GET session | CLI commands | A: GET approvals/:id |
| GET health/* | Excluded | H: build id to authenticated callers |
| /owner/* (13 routes) | Excluded | Decision 8 |
| GET risks (404 signpost) | Excluded | Stays |

## Appendix B: sources read

`mcp/src/*.ts` and `mcp/src/tests/*.ts`; `mcp/README.md`; `mcp/HANDOVER.md`;
`mcp/ask-platform.mjs`; `apps/api/src/routes/auth/connector.ts`;
`apps/api/src/middleware/{auth,roles,plan,session-level,action-approval}.ts`;
`apps/api/src/plugins/{client-activity-log,connector-write-budget}.ts`;
`apps/api/src/utils/{action-digest,non-browser-client,errors}.ts`;
`apps/api/src/routes/**/index.ts` route registrations; `apps/api/prisma/schema.prisma`
(AuthSession, AuthActionApproval, ClientActivityEvent);
`e2e/tests/mcp/connector-live.spec.ts`; `scripts/mcp-live-canary.mjs`;
`.github/workflows/{ci,e2e}.yml`; the specs and plans dated 2026-09-19 under
`docs/superpowers/`; the MCP specification changelogs for 2025-11-25 and the revision
the site serves as latest (2026-07-28); the GitHub MCP server README; the MCP Bundles
README; and the installed `@modelcontextprotocol/sdk` 1.30.0.
