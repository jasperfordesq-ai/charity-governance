# CharityPilot MCP Connector Design

## Purpose

CharityPilot's governance data is only reachable by opening the web app and
navigating to it. The owner and the DPO (Nikita Serkevich) both want to ask
questions of it directly — "what is outstanding before the next board review",
"which standards have no evidence", "when is the annual return due" — without
learning where each screen lives.

This design adds **`apps/mcp`**: a stdio MCP server that each person runs on
their own machine, which answers those questions by calling the existing
`/api/v1` routes as that person.

The owner's constraint, stated verbatim: *"as long as it doesn't pose any
security risks or expose personal data to anyone unauthorised"* and *"I don't
want any bad actors getting their hands on this MCP connector."* That constraint
drives every decision below, and where usefulness and safety conflict this
design resolves toward safety by default while leaving the useful path one
explicit flag away.

**Scope note:** this is not on the order of work Nikita agreed on 2026-09-18
(access → Atlassian setup → architecture review → move off the home VM →
Confluence integration). It is additive and must not displace steps 1–4. It is
being built now at the owner's explicit direction.

## Decisions Already Made (with the owner)

Three questions were put to the owner during brainstorming; these are the answers.

- **Data scope: everything the signed-in user can already see.** Not a
  compliance-only subset. The connector inherits the caller's exact API
  permissions, including `requireAdmin` gates — it can never exceed what that
  person sees in the browser, and never less.
- **Credentials: sign in once; keep only the rotating refresh token in the OS
  credential store.** No token in a file, `.env`, or the repo. The access token
  lives in memory only.
- **Deployment: locally on each person's machine.** Not a shared server on the
  VM. The connector is a client, never a listener.
- **Personal and sensitive fields are gated off by default**
  (`--allow-personal-data`), decided after the risk was raised in design review.
  This covers the board register, the member register, the conflicts register and
  the complaints register. See *The personal-data gate* below.
- **Read-only.** No writes, no file downloads, no arbitrary-request escape hatch.

## Architecture

A new npm workspace `apps/mcp` (workspaces are already `packages/*` and
`apps/*`), ESM, matching the repo's existing TypeScript + `tsc` + `node --test`
conventions.

```
Each person's machine                        The Hyper-V VM
┌────────────────────────────┐              ┌──────────────────┐
│ AI client                  │              │ CharityPilot API │
│   └─ charitypilot-mcp      │── HTTPS ────▶│   /api/v1/*      │
│        (stdio subprocess)  │  (Tailscale) │   (unchanged)    │
└────────────────────────────┘              └──────────────────┘
        │
        └─ OS credential store: refresh token only
```

**Nothing changes on the VM.** No new service, no listening port, no migration,
no deploy, no schema change. The machine holding the charity records gains zero
new attack surface. This is the single most important property of the design and
the reason the local-stdio shape was chosen over a shared server.

### Why not a server on the VM

A shared MCP server would be installed once instead of per-machine, but it would
add a listening service to the host holding real governance records, require its
own authentication layer distinct from the API's, and blur attribution unless
every call carried the caller's identity anyway. The convenience does not pay for
that. Rejected.

## Components

Each unit is separately testable and depends only on the one below it.

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `credentials.ts` | Read/write/clear the refresh token in the OS store | `@napi-rs/keyring` |
| `session.ts` | Hold the in-memory access token; refresh when expired; surface reconnect-needed | `credentials.ts` |
| `client.ts` | Build authenticated requests to `/api/v1`; map HTTP failures to typed errors | `session.ts` |
| `redact.ts` | Strip tokens from anything about to be logged; strip gated personal fields from responses | — |
| `tools/*.ts` | One thin wrapper per route: build request, validate response shape, return | `client.ts`, `redact.ts` |
| `server.ts` | Register tools, serve MCP over stdio | `tools/*` |
| `cli.ts` | `connect`, `disconnect`, `status` | `session.ts`, `credentials.ts` |

No business logic lives in the connector. The API remains the single source of
truth for what a caller may see; the connector only carries the question and the
answer. A tool that needed logic of its own would be a signal the API is missing
an endpoint, and the endpoint should be added there instead.

## Tools

All read-only, each mapping to a route that already exists:

`compliance_summary`, `compliance_principles`, `compliance_records`,
`approval_readiness`, `compliance_history`, `deadlines_list`,
`dashboard_overview`, `board_register`, `governance_registers`,
`governing_acts`, `documents_list` (metadata only — never file contents).

Tool descriptions state plainly that their output is charity data, not
instructions. Nothing a tool returns is ever treated as a directive by the
connector itself.

## Credential flow

```
charitypilot-mcp connect
  1. prompt for password in the terminal (never echoed, never stored)
  2. POST /api/v1/auth/login
  3. discard the password from memory immediately
  4. refresh token → OS credential store
  5. access token  → memory only (≤1h; JWT_EXPIRY is capped at 1h in production)

per call
  access token valid   → use it
  access token expired → rotate via refresh (rotateSessionTokens) → store new pair
  refresh rejected     → clear the keychain entry, return "reconnect required"

charitypilot-mcp disconnect
  → revokeSessionToken server-side, then clear the keychain entry
```

The password is handled only by the person who owns it, typed into their own
terminal, exchanged once, and never written to disk or logs.

## Security properties

These are the claims this design makes, each traceable to a mechanism:

1. **Cannot exceed browser permissions.** Every call passes the same
   `requireRole` checks in `apps/api/src/middleware/roles.ts`. No privileged path
   exists in the connector.
2. **No secret at rest outside the OS credential store.** No `.env`, no config
   file, nothing in the repo.
3. **Bounded theft window.** A stolen access token expires within the hour. A
   stolen refresh token is single-use; reuse is detectable by
   `rotateSessionTokens`.
4. **Kill switch.** `revokeSessionToken` ends a session server-side immediately,
   without rotating `JWT_SECRET` or disturbing anyone else.
5. **TLS verification cannot be disabled.** No flag, no environment variable, no
   escape hatch — deliberately, because that is the usual route by which such
   tools quietly become insecure.
6. **Tokens never appear in logs.** Enforced by `redact.ts` and asserted by test.
7. **No new network surface.** The connector accepts no connections.

## The personal-data gate

**Whatever a tool returns is sent to an AI model.** Answering a broad question
about the board register or the conflicts register would transmit trustee dates
of birth, home addresses, declared conflicts and complaint summaries to a model
provider — a new processing activity, with a lawful basis and residency
implications that belong to the DPO, not to a tool default.

Four models carry data in the category the agreed architecture keeps in
CharityPilot "where per-record permissions are finer than page restrictions",
including the "sensitive complaints" called out by name:

| Model | Withheld with the gate off | Still returned |
| --- | --- | --- |
| `BoardMember` | `dateOfBirth`, `residentialAddress`, `formerNames`, `otherDirectorships`, `email` | `name`, `role`, appointment/term dates, conduct and induction status |
| `Member` | `address` | `name`, `dateEntered`, `dateCeased`, `retentionDeleteAt` |
| `ConflictRecord` | `trusteeName`, `matter`, `nature`, `actionTaken`, `decision` | `id`, `status`, `dateDeclared`, `meetingDate`, `nextReviewDate`, `minuteReference` |
| `ComplaintRecord` | `summary`, `source`, `actionTaken`, `outcome` | `id`, `status`, `receivedDate`, `reviewedByBoard`, `boardMinuteReference` |

What survives is deliberately the compliance-shaped half: how many conflicts are
open, whether each was reviewed and minuted, whether complaints reached the
board, whether trustee terms have expired. Those are the governance questions
worth asking, and none of them requires the content.

`--allow-personal-data` returns every withheld field. Default off.

### Allowlist, not denylist

The filter is an **allowlist**: for these four models only the named safe fields
pass, and anything else is dropped. A denylist would leak a newly added sensitive
column by default — which is exactly how this kind of gate fails six months
later. With an allowlist, a new column is withheld until someone deliberately
adds it, and the schema-drift test below makes that a decision rather than an
oversight.

Filtering happens at the response boundary in one place, not per tool, so a new
tool cannot forget it.

## Error handling

Failures map to MCP error responses carrying no internals — no stack traces, no
tokens, no connection strings:

| Condition | Response |
| --- | --- |
| No stored credential | "Not connected. Run `charitypilot-mcp connect`." |
| Refresh rejected | "Session ended. Run `charitypilot-mcp connect`." |
| DNS/connection failure | "Cannot reach CharityPilot — check Tailscale is connected." |
| TLS failure | Surfaced plainly; never retried with verification relaxed. |
| 403 from the API | Passed through as authorisation denied, unmodified. |
| 5xx from the API | Status and message passed through; body not echoed. |

## Testing

Following the repo convention — `tsc -p tsconfig.json` then
`node --test dist/tests/*.test.js`. No Vitest. Built test-first.

Coverage:

- token refresh, rotation, and the reconnect path on a rejected refresh
- keychain read / write / clear, including absent-entry handling
- redaction: assert no token value appears in any emitted log line
- the personal-data gate: for each of the four models, assert every withheld
  field is absent with the flag off and present with it on — across every tool
  that can reach them, not just the obvious one
- **schema drift**: a test that reads the Prisma models and fails if any field
  on those four models is neither in the allowlist nor in the withheld list.
  Adding a column to `BoardMember` or `ComplaintRecord` then breaks the build
  until someone classifies it, rather than silently exposing it
- each tool's request shape against a stubbed API
- error mapping: assert no stack trace or token reaches an MCP error response

No test makes a live call to the VM.

## Deliberately excluded

- **Writes.** Compliance records carry audit history; an AI client writing them
  is a question worth answering separately, not on day one.
- **Document downloads.** Metadata only.
- **Response caching to disk.** Would create an unencrypted copy of governance
  data outside the VM.
- **A generic "call any endpoint" tool.** It would void every scope guarantee
  above in one call.

## Open questions

None. The three design questions were resolved with the owner during
brainstorming, and the personal-data gate was agreed in design review.
