# charitypilot-mcp

A read-only MCP server that lets an AI client answer questions about your
charity's governance data — compliance status, deadlines, the board register,
governing acts, evidence document metadata — by calling CharityPilot's
existing `/api/v1` routes as you. It runs on your own machine, as a stdio
subprocess of your AI client. It is not a shared service, it does not listen
for connections, and it cannot change anything in CharityPilot: every tool it
exposes maps to a `GET` route, nothing else.

## Before you start: Tailscale must be connected

CharityPilot is not on the public internet. The connector reaches it over
your tailnet, so if Tailscale isn't up on this machine, there is nothing to
connect to — every command below will fail with a connection error, not an
authentication one. Connect Tailscale first, then continue.

## Install and build

```bash
cd mcp
npm install
npm run build
```

**Do not run `npm install --prefix mcp` from the repository root.** `mcp/` is
a standalone package deliberately kept outside the npm workspace. Run from
the root, `--prefix mcp` makes npm treat the *repository root's* package
(`charitypilot`) as the thing being installed, and it writes a parent link
back into `mcp/package.json` and `mcp/package-lock.json`. That's not a
hypothetical: it has already happened twice and cost two rounds of cleanup.
Always `cd mcp` first, then run plain `npm install` / `npm run build` from
inside that directory.

The build compiles `mcp/src` to `mcp/dist`. The entry point your AI client
needs is `mcp/dist/cli.js`.

## Configuring your AI client

Point your MCP-capable client at the built CLI, run with no subcommand (that
starts the stdio server; `connect` / `status` / `disconnect` are separate,
one-off commands you run yourself from a terminal — see below):

```json
{
  "mcpServers": {
    "charitypilot": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/dist/cli.js"]
    }
  }
}
```

Use an absolute path. If you want every tool call to return the full,
un-redacted personal data (see the gate below), add `--allow-personal-data`
to `args` — but read that section first, because it is not a convenience
switch.

## connect / status / disconnect

These are run by hand, in a terminal, before (and after) you use the
connector from an AI client:

- **`node dist/cli.js connect`** — prompts for your CharityPilot email and
  password in the terminal (the password is never echoed and is never
  written anywhere), signs in against `/api/v1/auth/login`, and stores the
  resulting refresh token in your OS credential store. Prints who you're
  signed in as and which organisation you're connected to, so you can catch
  a wrong-account sign-in immediately.
- **`node dist/cli.js status`** — reports whether a credential is stored and,
  if it's still valid, the account and organisation it resolves to right
  now. Run this before asking a question if you're not sure which charity
  you're connected to.
- **`node dist/cli.js disconnect`** — ends the session on the server (the
  refresh token is revoked via `/api/v1/auth/logout`, so it can't be reused
  even if someone got hold of it) *and* clears the credential from the local
  OS credential store. Both happen; this is not just a local logout.

## Tools

27 tools cover every readable route on the API. Each maps to exactly one
`GET` route, and each result notes that it is data returned for the signed-in
person's charity, not instructions to act on.

The **Gated as** column says how the personal-data gate treats the payload: by a
single model when every record is one kind of thing, by a named shape when the
payload mixes models, or "no records" for payloads that are only counts,
statuses or the Governance Code itself. Every tool is one of the three. A tool
declaring none of them would slip past the gate entirely, which is what happened
to five of them for a while, so a test now refuses it.

| Tool | Route | Inputs | Gated as | Needs |
| --- | --- | --- | --- | --- |
| `compliance_summary` | `/api/v1/compliance/summary` | — | no records | — |
| `compliance_principles` | `/api/v1/compliance/principles` | — | no records | — |
| `compliance_principle` | `/api/v1/compliance/principles/:principleId` | **principleId** (required) | no records | — |
| `compliance_records` | `/api/v1/compliance/records` | — | mixed (`complianceRecords`) | — |
| `compliance_record` | `/api/v1/compliance/records/:standardId` | **standardId** (required) | mixed (`complianceRecords`) | — |
| `compliance_signoff` | `/api/v1/compliance/signoff` | — | mixed (`complianceSignoff`) | — |
| `approval_readiness` | `/api/v1/compliance/approval-readiness` | — | no records | — |
| `organisation` | `/api/v1/organisation` | — | `Organisation` | — |
| `dashboard_overview` | `/api/v1/dashboard` | — | mixed (`dashboard`) | — |
| `deadlines_list` | `/api/v1/deadlines` | page, pageSize | `Deadline` | — |
| `deadlines_history` | `/api/v1/deadlines/history` | page, pageSize | `Deadline` | — |
| `board_register` | `/api/v1/board-members` | page, pageSize | `BoardMember` | — |
| `governing_acts` | `/api/v1/governing-acts` | year, kind, status | `GoverningAct` | Complete plan |
| `governing_acts_voids` | `/api/v1/governing-acts/voids` | — | `GoverningActVoid` | Complete plan |
| `board_submissions` | `/api/v1/governing-acts/board-submissions` | — | mixed (`boardSubmissions`) | Complete plan |
| `registers_summary` | `/api/v1/governance-registers/summary` | — | no records | Complete plan |
| `conflicts_list` | `/api/v1/governance-registers/conflicts` | — | `ConflictRecord` | Complete plan |
| `risks_list` | `/api/v1/governance-registers/risks` | — | `RiskRecord` | Complete plan |
| `complaints_list` | `/api/v1/governance-registers/complaints` | — | `ComplaintRecord` | Complete plan |
| `fundraising_list` | `/api/v1/governance-registers/fundraising` | — | `FundraisingRecord` | Complete plan |
| `annual_report_readiness` | `/api/v1/governance-registers/annual-report` | year | `AnnualReportReadiness` | Complete plan |
| `financial_controls` | `/api/v1/governance-registers/financial-controls` | year | `FinancialControlReview` | Complete plan |
| `members_list` | `/api/v1/members` | includeFormer | `Member` | Complete plan |
| `documents_list` | `/api/v1/documents` | page, pageSize | `Document` | — |
| `document` | `/api/v1/documents/:id` | **id** (required) | `Document` | — |
| `team_list` | `/api/v1/team` | — | mixed (`team`) | — |
| `confluence_status` | `/api/v1/integrations/confluence/status` | — | no records | Owner/admin |

Some routes are deliberately not exposed: raw file downloads and the HTML
exports, the platform operator realm, billing authority, reminder logs carrying
recipients' email addresses, and the two team routes that report on a named
colleague's sessions and suspensions. Each is listed with its reason in
`src/route-coverage.ts`, and a test requires every readable route the API
registers to be either a tool or an entry there — so a route added later forces
the choice rather than being quietly missed.

## The personal-data gate

By default, the connector answers governance questions without sending
personal data to your AI model provider. Concretely, with no flag, on the
tools that currently exist:

- **`board_register`**: trustee names and roles, appointment and term dates,
  and conduct/induction status come back. Dates of birth, home addresses,
  former names, other directorships, and email addresses do not.
- **`governing_acts`**: the act's kind, status, dates, reference and title
  come back. Resolution text, who abstained, and the `conflictRecordId` a
  resolution may carry do not — the whole `resolutions` relation is dropped,
  because the minute book is exactly the kind of free-text record the gate
  exists to keep out of a model's context. (The `conflictRecordId` matters
  for the same reason `ConflictRecord.boardMemberId` is withheld below: it
  is a foreign key that would let a resolution be joined back to a specific
  conflict declaration.)

The gate also classifies three models for which no tool exists yet — kept
gated now so that adding a tool later doesn't ship it unfiltered by accident
(see *Known limitations* below):

- **Member register** (`Member`): would return only counts and dates (when
  someone joined or left, retention deadlines). Member names and addresses
  would not.
- **Conflicts register** (`ConflictRecord`): would return status, dates,
  meeting/review dates and minute references. The matter, its nature, the
  action taken, the decision, the trustee's name, and — deliberately — the
  board-member id itself would not. The id is withheld along with the name
  because it's a foreign key into the board register: anyone holding both
  the (safe) board register and a conflicts register that kept the id could
  join the two and work out exactly who declared which conflict. Redacting
  the name while leaving the id in place wouldn't actually redact anything.
- **Complaints register** (`ComplaintRecord`): would return status, received
  date, and whether/where it was reviewed and minuted by the board. The
  summary, source, action taken and outcome would not.

What's left in every case is the compliance-shaped half of the data: counts,
statuses, dates, minute references, whether something was reviewed and
minuted. That's enough to answer the governance questions this connector
exists for — what's outstanding, what needs board attention, whether
something was properly recorded — without the content of anyone's personal
or sensitive record leaving the building.

Pass `--allow-personal-data` and all of it comes back on the tools that exist
today: dates of birth, home addresses, and full resolution text including
who abstained and any conflict-record link. Doing so isn't a convenience
toggle — it means that data is being sent to whichever AI model provider
your client uses, which is a data-processing decision with its own
lawful-basis and residency questions. That decision belongs to the
organisation's data protection officer, not to whoever happens to be running
the connector that day. Don't pass this flag without checking with them
first.

## What's actually stored on disk

Nothing but a rotating refresh token, held in your OS's credential store
(Keychain on macOS, Credential Manager on Windows, the Secret Service /
libsecret on Linux) under the service name `charitypilot-mcp`. The access
token used for API calls lives in memory only, for the lifetime of the
process, and is never written anywhere. There is no config file, no `.env`,
and no on-disk cache of anything the API returns.

## Read-only, by design

Every tool the connector exposes maps to a `GET` route on the existing API.
There is no tool that writes, uploads, deletes, or downloads a document's
contents (document tools return metadata only). If a question can't be
answered by reading, this connector can't answer it.

## Testing against a local stack

Everything above describes the connector pointed at the VM over Tailscale.
There is also a `local` profile, used only for testing against a stack on
this machine. It accepts a base URL whose host is exactly `localhost`,
`127.0.0.1` or `[::1]` and nothing else, so it can never be aimed at the VM
or at any other host without TLS.

The full matrix runs against a disposable Docker stack that the test runner
owns from boot to teardown:

```bash
cd mcp && npm ci && npm run build && cd ..
npm run test:e2e:mcp
```

It seeds a charity with trustees, a minute, a document and a second charity,
then drives the built connector over stdio and asserts what the gate
withholds, what it releases when opened, and that one charity never sees the
other's records.

For a faster loop against `npm run dev` (API on port 3002), sign in once and
then drive the connector by hand with the MCP Inspector:

```bash
node mcp/dist/cli.js connect --profile local --base-url http://localhost:3002
npx @modelcontextprotocol/inspector node mcp/dist/cli.js serve --profile local --base-url http://localhost:3002
```

Until the connector-specific auth routes land, `FRONTEND_URL` in
`apps/api/.env` must include `http://localhost:3002`, because the API rejects
an unlisted `Origin` on the sign-in route.

To point an AI client at the local stack, give it its own credential file so
it never shares the OS credential store entry used for the VM:

```json
{ "mcpServers": { "charitypilot-local": {
    "command": "node",
    "args": ["C:\platforms\htdocs\charity-governence\mcp\dist\cli.js",
             "serve", "--profile", "local", "--base-url", "http://localhost:3002"],
    "env": { "CHARITYPILOT_CREDENTIAL_FILE": "C:\Users\jaspe\.charitypilot-mcp-local.json" } } } }
```

`CHARITYPILOT_CREDENTIAL_FILE` is accepted only with `--profile local`; set
it anywhere else and the connector refuses to start.

## Known limitations / follow-up

- **The registers are exposed per type, not as one tool.** An earlier version of
  this connector had no tool for the member, conflicts or complaints registers,
  because the mixed-payload route it would have called cannot be filtered by a
  single model. They are now reached through `conflicts_list`, `risks_list`,
  `complaints_list`, `fundraising_list` and `members_list`, each calling its own
  route and gated by its own model, which sidesteps the mixed payload entirely.
- **Pagination is available but not automatic.** The list tools accept `page`
  and `pageSize` and report `hasMore`. Nothing follows the pages for you, so a
  question spanning a long register needs more than one call.
