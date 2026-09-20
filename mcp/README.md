# charitypilot-mcp

An MCP server that lets an AI client answer questions about your charity's
governance data, and change it, by calling CharityPilot's existing `/api/v1`
routes as you. It runs on your own machine, as a stdio subprocess of your AI
client. It is not a shared service and it does not listen for connections.

**It has no powers of its own.** Everything it can do, you can do in the web
application, and every limit is enforced by the API rather than by the
connector. What the connector adds is that you choose, when you sign in, how
much of your own authority this particular session carries — and that anything
which cannot be undone stops and asks you, in your own terminal, before it
happens.

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

Claude Code takes the same thing as one line:

```bash
claude mcp add charitypilot -- node /absolute/path/to/mcp/dist/cli.js serve --profile vm
```

Use an absolute path. If you want every tool call to return the full,
un-redacted personal data (see the gate below), add `--allow-personal-data`
to `args` — but read that section first, because it is not a convenience
switch.

### Why there is no `npx charitypilot-mcp` yet

The package is marked private, so `npm publish` refuses. That is deliberate:
publishing claims a public name and commits somebody to maintaining it, which
is the owner's decision rather than an engineering one. Everything else a
publish needs is in place, and a test asserts it, so removing that one line is
the only step left. The tarball carries the build, the bundle manifest and this
file, and nothing else.

## Installing it as a bundle in Claude Desktop

Editing a JSON file by hand is the old way. The package carries an MCP bundle
manifest, so it can be built into a single `.mcpb` file that Claude Desktop
installs in one step and that asks, in its own dialog, for the two folders the
document tools need:

```bash
cd mcp && npm ci && npm run build
npx @anthropic-ai/mcpb pack
```

That writes `charitypilot.mcpb` beside the package. Open it with Claude Desktop
to install. Leave either folder question blank and that tool is not offered at
all, exactly as leaving the flag off does.

The bundle passes the two folders as `CHARITYPILOT_UPLOAD_ROOT` and
`CHARITYPILOT_DOWNLOAD_DIR`, which the connector reads when the matching flag
is absent. Signing in is still `connect`, at a terminal, because the password
belongs to a person.

**It is not on npm.** The package is marked private, so `npm publish` refuses.
Publishing it, and choosing the name it would take, is the owner's decision.

## connect / status / disconnect

These are run by hand, in a terminal, before (and after) you use the
connector from an AI client:

- **`node dist/cli.js connect`** — prompts for your CharityPilot email and
  password in the terminal (the password is never echoed and is never
  written anywhere), signs in against `/api/v1/auth/connector/login`, and
  stores the resulting refresh token in your OS credential store. Prints the
  host, who you're signed in as, which organisation, and the access level the
  session will carry, so you can catch a wrong host or a wrong account
  immediately. Add `--access-level read|write|admin` to choose; the default is
  `write`.
- **`node dist/cli.js approve <id>`** — grants one pending approval. It first
  shows you what you are about to approve, as the API describes it: the
  summary naming the record, the action, the record's identifier and when the
  approval expires. Only then does it ask for your password. If the approval
  is already approved, already used or expired, it says so and asks for
  nothing. Must be run at a terminal; see below.
- **`node dist/cli.js status`** — reports whether a credential is stored and,
  if it's still valid, the account, organisation and access level it resolves
  to right now. The level is the one the API holds for the session, not the
  flag this process was started with. Run this before asking a question if
  you're not sure which charity you're connected to.
- **`node dist/cli.js --help`** and **`--version`** do what they say.

The stored credential is bound to the host that issued it. If something changes
the connector's base URL, the credential is refused rather than sent to the new
host, and the refusal says so loudly instead of looking like an expired session.
- **`node dist/cli.js disconnect`** — ends the session on the server (the
  refresh token is revoked via `/api/v1/auth/logout`, so it can't be reused
  even if someone got hold of it) *and* clears the credential from the local
  OS credential store. Both happen; this is not just a local logout.

## Tools

31 read tools cover every readable route on the API, and 42 write tools cover
every mutating route that belongs in an assistant's hands. Each maps to exactly one route, and
each result notes that it is data returned for the signed-in person's charity,
not instructions to act on.

Two further tools, `document_upload` and `document_download`, appear only when
you name a directory for them. See *Uploading and downloading documents*.

The read tools are listed first below. The writes follow, and every one of them
takes an optional `reason` that is recorded against the change; the removals
require it.

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
| `team_sessions_list` | `/api/v1/team/members/:id/sessions` | **id** (required) | mixed (`teamSessions`) | Owner/admin |
| `security_audit` | `/api/v1/team/security-audit` | — | mixed (`securityAudit`) | Owner/admin |
| `deadlines_reminder_history` | `/api/v1/deadlines/reminder-history` | page, pageSize, status | mixed (`reminderHistory`) | Owner/admin |
| `billing_status` | `/api/v1/billing/status` | — | no records | — |
| `confluence_status` | `/api/v1/integrations/confluence/status` | — | no records | Owner/admin |

### The write tools

| Tool | Route | Level | Notes |
| --- | --- | --- | --- |
| `annual_report_set` | PUT /api/v1/governance-registers/annual-report | write |  |
| `board_member_create` | POST /api/v1/board-members | write |  |
| `board_member_update` | PATCH /api/v1/board-members/:id | write |  |
| `complaint_create` | POST /api/v1/governance-registers/complaints | write | Needs the gate open. |
| `complaint_update` | PATCH /api/v1/governance-registers/complaints/:id | write |  |
| `compliance_record_set` | PUT /api/v1/compliance/records/:standardId | write |  |
| `compliance_signoff_set` | PUT /api/v1/compliance/signoff | write |  |
| `conflict_create` | POST /api/v1/governance-registers/conflicts | write | Needs the gate open. |
| `conflict_update` | PATCH /api/v1/governance-registers/conflicts/:id | write |  |
| `deadline_create` | POST /api/v1/deadlines | write |  |
| `deadline_update` | PATCH /api/v1/deadlines/:id | write |  |
| `document_approval_set` | PATCH /api/v1/governing-acts/documents/:documentId/approval | write |  |
| `document_link_standard` | POST /api/v1/documents/:id/standards | write |  |
| `financial_controls_set` | PUT /api/v1/governance-registers/financial-controls | write |  |
| `fundraising_create` | POST /api/v1/governance-registers/fundraising | write |  |
| `fundraising_update` | PATCH /api/v1/governance-registers/fundraising/:id | write |  |
| `governing_act_create` | POST /api/v1/governing-acts | write |  |
| `governing_act_update` | PATCH /api/v1/governing-acts/:id | write |  |
| `member_create` | POST /api/v1/members | write | Needs the gate open. |
| `member_update` | PATCH /api/v1/members/:id | write |  |
| `organisation_update` | PATCH /api/v1/organisation | write |  |
| `resolution_create` | POST /api/v1/governing-acts/:id/resolutions | write | Needs the gate open. |
| `resolution_update` | PATCH /api/v1/governing-acts/resolutions/:id | write |  |
| `risk_create` | POST /api/v1/governance-registers/risks | write | Needs the gate open. |
| `risk_update` | PATCH /api/v1/governance-registers/risks/:id | write |  |
| `board_member_delete` | DELETE /api/v1/board-members/:id | admin | Needs your approval. |
| `complaint_delete` | DELETE /api/v1/governance-registers/complaints/:id | admin | Needs your approval. |
| `conflict_delete` | DELETE /api/v1/governance-registers/conflicts/:id | admin | Needs your approval. |
| `deadline_delete` | DELETE /api/v1/deadlines/:id | admin | Needs your approval. |
| `document_delete` | DELETE /api/v1/documents/:id | admin | Needs your approval. |
| `document_unlink_standard` | DELETE /api/v1/documents/:id/standards/:standardId | admin | Needs your approval. |
| `fundraising_delete` | DELETE /api/v1/governance-registers/fundraising/:id | admin | Needs your approval. |
| `governing_act_void` | POST /api/v1/governing-acts/:id/void | admin | Needs your approval. Needs the gate open. |
| `risk_delete` | DELETE /api/v1/governance-registers/risks/:id | admin | Needs your approval. |
| `team_invite_create` | POST /api/v1/team/invites | write | Needs the gate open. The one-time link is never returned. |
| `team_member_reactivate` | POST /api/v1/team/members/:id/reactivate | write | |
| `team_invite_revoke` | DELETE /api/v1/team/invites/:id | admin | Needs your approval. |
| `team_role_set` | PATCH /api/v1/team/members/:id/role | admin | Needs your approval. |
| `team_member_suspend` | POST /api/v1/team/members/:id/suspend | admin | Needs your approval. |
| `team_member_remove` | POST /api/v1/team/members/:id/remove | admin | Needs your approval. |
| `team_session_revoke` | POST /api/v1/team/members/:id/sessions/:familyId/revoke | admin | Needs your approval. |
| `team_sessions_revoke_all` | POST /api/v1/team/members/:id/sessions/revoke-all | admin | Needs your approval. |

Every field each write tool accepts is declared. A field it does not declare is
refused rather than passed on, so a model cannot reach a column the connector
never meant to expose by guessing its name. An omitted optional field is left
out rather than sent as null, so a patch cannot blank a column it was never
asked to change.

The record a write returns goes through the same gate a read would. A write is
not a way around the policy.

**"Needs the gate open"** means the API requires a field that the personal-data
gate withholds when reading that record. A conflict of interest that names
nobody and describes no matter is not a conflict record, so it cannot be created
with the gate closed. The rule is judged per call, not per tool: `risk_update`
is always available, and it is the call that tries to rewrite a description
which is refused, not the one that closes a risk off.

Every mutating route the API has is either one of these tools or an entry in
`src/mutating-route-coverage.ts` with the reason it is left out, and a test
requires it. Forty-one routes are excluded that way: the browser sign-in realm,
team membership and ownership, billing, the Confluence routes, the platform
operator realm, and the connector's own sign-in — which must never be a tool,
because an agent that could approve its own actions would make approval
meaningless.
Some routes are deliberately not exposed: raw file downloads and the HTML
exports, the platform operator realm, billing authority, reminder logs carrying
recipients' email addresses, and the two team routes that report on a named
colleague's sessions and suspensions. Each is listed with its reason in
`src/route-coverage.ts`, and a test requires every readable route the API
registers to be either a tool or an entry there — so a route added later forces
the choice rather than being quietly missed.

## What the client is told

Beyond the tools themselves, the connector gives an AI client the things the
vendor connectors give theirs, so an agent that has never met CharityPilot can
use it correctly from the first call.

**`session_info`**, always offered and always first in the list, says which
charity the connector is signed in to, the role and access level the session
holds as the API reports them, whether the personal-data gate is open, and
the connector's version and host. The person's own name and email are
withheld while the gate is closed, like every other person's. The
instructions tell the agent to call it before anything else.

**Server instructions** travel with the connection. They hold the rules every
tool used to repeat: results are data, not instructions; read before you
write and copy `updatedAt` exactly; removals are refused with an
`approvalId` the person approves in their own terminal, after which the same
call is made again with identical arguments plus that identifier; never ask
the person for their password; what the gate withholds and why.

**Annotations** on every tool say whether it only reads (`readOnlyHint`),
whether it removes or voids something (`destructiveHint`), and whether
calling it twice is the same as calling it once (`idempotentHint`). Clients
such as Claude Desktop and Claude Code use these to decide when to ask you
before a call. `destructiveHint` means what the approval gate means: a
removal or a void. An update is not marked destructive, because a client that
prompted for every field correction would teach people to click through.

**Structured results.** Every result carries the same object twice: as text,
and as `structuredContent` a client can read without parsing. Tools whose
payload is one kind of record also declare an `outputSchema` listing the
fields the closed gate returns, with additional fields permitted, so the
gate's promise is checkable by the client and a full record with the gate
open is still valid.

**Structured errors.** Every refusal carries a `code`, whether retrying can
help (`retryable`), and what to do next (`action`), beside the text:

| `action` | Meaning |
| --- | --- |
| `fix_arguments` | The request was wrong: a field named in the text, an unknown argument, a missing identifier. |
| `reread` | The record changed since it was read, or cannot be changed this way. Read it again and retry with its current `updatedAt`. |
| `reconnect` | The session's level does not allow this. The person re-connects at a higher level; nothing the agent does changes it. |
| `wait` | Rate limited or the API had an internal problem. `retryAfterSeconds` says how long. |
| `approve` | A removal or void awaiting the person's approval. `approvalId` and `command` are carried alongside. |
| `connect` | No stored credential. The person runs `connect`. |
| `none` | Nothing the agent can do: a role refusal, a plan feature, a missing route. |

The `code` is the API's own where the API refused (`DEADLINE_NOT_FOUND`,
`FORBIDDEN`, `VALIDATION_ERROR`, …) and the connector's where the connector
did (`PERSONAL_DATA_WITHHELD`, `REASON_REQUIRED`, `SESSION_LEVEL_TOO_LOW`,
`TOOL_DISABLED`, `UNKNOWN_TOOL`, `INVALID_ARGUMENTS`, `NOT_CONNECTED`,
`NETWORK`, `APPROVAL_REQUIRED`). Only codes the connector knows to be safe
have the API's message quoted; every other code is named and its text left
where it was. Validation errors always carry the fields that were wrong.

**Tool groups.** Sixty-odd tools in every conversation is a real cost in a
client's context. `--toolsets a,b` offers only the named groups, which follow
the API's own route prefixes:

| Group | Tools |
| --- | --- |
| `compliance` | The Governance Code principles, records, summary, sign-off and approval readiness |
| `organisation` | The charity's profile and the dashboard |
| `deadlines` | The deadline calendar |
| `board` | The board register |
| `minute-book` | Governing acts, resolutions, voids, board submissions |
| `registers` | Conflicts, risks, complaints, fundraising, annual report, financial controls, members |
| `documents` | Evidence documents, including upload and download when enabled |
| `team` | Who has access |
| `integrations` | Confluence status |

`session_info` is offered whatever the groups. A tool outside the enabled
groups is refused if called with `TOOL_DISABLED`, naming the group it is in.
`--toolsets all` is the default.

**`--verbose`** writes one line per tool call to stderr, naming the tool, the
outcome and the time taken, with secrets redacted and arguments never
logged. stdout stays the protocol stream.

**Prompts.** A charity's work is sequenced, and an agent infers some of that
order and gets the rest wrong. Five prompts carry it, and your client offers
them to you by name:

| Prompt | What it does |
| --- | --- |
| `governance_health_check` | Reads the whole picture and ranks what is overdue, what is about to be, and what is merely untidy |
| `prepare_board_meeting` | Builds an agenda from what the records say is outstanding |
| `record_board_meeting` | Writes a held meeting into the minute book in the order the records expect |
| `annual_return_readiness` | Says whether you can file, and what is missing |
| `fix_a_wrong_deadline` | Works out whether a deadline is really overdue or generated from a wrong date, and fixes the cause |

**Fewer fields.** A list tool takes `fields` to return only the columns you
want, which keeps a long register short. The choices offered are the fields the
gate would release anyway, so asking for one cannot reach a withheld one, and
the pagination figures always come back.

## The personal-data gate

By default, the connector answers governance questions without sending
personal data to your AI model provider.

**The gate belongs to the session, not to this process.** You choose it when
you sign in, with `connect --data-scope withheld|full`, and the API records it
on the session beside the access level. It cannot be changed afterwards: a
session is narrowed at sign-in or not at all. Until this change it was a flag
on the `serve` command, read from your AI client's configuration file — a file
this connector otherwise treats as something an attacker may write, which is
why a stored credential refuses to be sent to any host but the one that issued
it. Editing that file can no longer decide whether a trustee's home address
reaches a model.

Asking for `full` is refused unless your account is an owner or an
administrator. That refusal happens after your password is checked, so it
cannot be used to find out who holds which role.

Concretely, with the scope withheld, on the tools that currently exist:

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

Connect with `--data-scope full` and all of it comes back: dates of birth, home
addresses, and full resolution text including who abstained and any
conflict-record link. Doing so isn't a convenience toggle — it means that data
is being sent to whichever AI model provider your client uses, which is a
data-processing decision with its own lawful-basis and residency questions.
That decision belongs to the organisation's data protection officer, not to
whoever happens to be running the connector that day. Don't ask for it without
checking with them first.

`--allow-personal-data` is the old spelling. At `connect` it still means
`--data-scope full`, so an existing command keeps meaning what it meant. On
`serve` it now decides nothing, unless the API is a build too old to hold a
scope at all, in which case the connector falls back to it and `status` says
so.

## The gate applies to writes too

The gate is usually described as what the connector withholds on the way out.
It applies on the way in as well: a call that would write a field the gate
withholds when reading that record is refused unless the gate is open.

The reason is different from the read case. Nothing is disclosed to the model
by a write — the model composed the text. What the rule prevents is an agent
populating a charity's records with personal data about named people, which is
a question of who authored a record and on what basis, and is the data
protection officer's to answer rather than the connector's.

The judgement is per call. Closing a risk off, or correcting its minute
reference, touches nothing the gate withholds and always works. Rewriting its
description is refused, and the refusal names the fields it objected to so the
rest of the record can still be changed.

## Administering the platform: `--realm operator`

Everything above is the **charity realm**: you sign in as a person who belongs
to one charity, and the connector reads and changes that charity's records.

`--realm operator` is the other credential this platform has. You sign in as a
**platform operator** — the account behind `/owner`, which is a different login
page, a different password, a different cookie and a different signing secret
from the charity application. A charity `OWNER` is the owner *of that charity*;
it is not this, and there is no path from one to the other.

```bash
charitypilot-mcp connect --realm operator --profile vm \
  --email you@example.org --code 123456 --access-level admin
```

**It can do everything the owner console does:**

| Tool | What it does |
| --- | --- |
| `tenant_list` | Every charity on the platform, with status, plan and a user count |
| `tenant_get` | One charity's summary, including the `lifecycleVersion` |
| `tenant_history` | What operators have done to a charity, and the reasons given |
| `tenant_configuration` | Its plan and document storage provider |
| `tenant_create` | Provision a new charity and its first owner |
| `tenant_configure` | Change a charity's plan or storage provider |
| `tenant_lifecycle` | Suspend, reactivate or **close** a charity |

**And it cannot read inside any charity.** Not one governance record, not one
person. The tenant summary is a name, two registration numbers, a lifecycle
status, a plan and a **count** of user accounts — never the accounts. Every
charity tool is absent from the listing and still refused if called by name,
with a message saying which realm reads it.

That is not a gap. CharityPilot is a processor and each charity controls its
own trustee, conflict and staff data, so an operator reading it on their own
authority is not something the product should make easy — and a platform whose
operator can read any customer's register at will does not pass an enterprise
data-protection review. To read one charity, connect to it in the charity realm
as somebody who belongs to it.

Three consequences worth knowing before you use it:

- **An authenticator is required.** Enrol at `/owner/security` first. A
  credential an AI client holds, which can close a charity, does not rest on a
  password alone — so `connect` refuses outright until one is enrolled.
- **Every change is approved by a person**, not only the destructive ones, and
  the command carries the realm: `charitypilot-mcp approve <id> --realm operator`.
- **`--access-level` still applies**, and `tenant_lifecycle` needs `admin`.
  Connect an agent at `read` if it only needs to look, which is most of the time.

There is deliberately no `--data-scope` here, and passing one is an error
rather than a no-op: there is no personal data in this realm to scope.

## Connecting to more than one CharityPilot

Each host keeps its own credential, under its own entry in the OS credential
store, so one machine can be connected to the VM and to a local test stack at
the same time without either evicting the other. Each **realm** keeps its own
entry too, so the same machine can hold a charity credential and a platform
operator credential for the same host without either standing in for the other. `connect`, `status` and
`disconnect` all act on whichever host `--base-url` names.

A credential is still bound to the host that issued it: if something changes
the base URL, the stored token is refused rather than sent to the new host,
and the refusal says so plainly instead of looking like an expired session.

`status` lists the hosts this machine holds a credential for whenever there is
more than one, and marks the one the command is acting on. It reports presence
only; no token is ever printed.

### Profiles pin which host a command may reach

```
--profile default   Any https host. For a deployment this connector does not know about.
--profile local     A stack on this machine only. The one profile that allows plain http.
--profile vm        The private server on its Tailscale address.
--profile prod      The hosted service at api.charitypilot.ie.
```

A profile is a pin, not a shortcut. The connector already refuses to send a
stored credential to a host other than the one that issued it, because the AI
client's configuration file naming that host is treated as something an
attacker may write. A profile applies the same reasoning one step earlier, to
the sign-in itself: with `--profile prod`, no edit to that file can point the
password prompt somewhere else. The check is on the parsed origin, so a host
like `api.charitypilot.ie.evil.example` is refused rather than matched.

`default` pins nothing, because a charity running its own deployment has an
origin nobody here can know. It still requires https.

## What's actually stored on disk

Nothing but a rotating refresh token, held in your OS's credential store
(Keychain on macOS, Credential Manager on Windows, the Secret Service /
libsecret on Linux) under the service name `charitypilot-mcp`. The access
token used for API calls lives in memory only, for the lifetime of the
process, and is never written anywhere. There is no config file, no `.env`,
and no on-disk cache of anything the API returns.

## Access levels

You pick one when you sign in, with `--access-level`, and it is recorded on the
session by the API. It can only ever narrow what your account could already do:
a read-level session belonging to an owner is still refused every change, and an
administrator-level session belonging to a member is still refused everything a
member may not do.

| Level | What the session may do |
| --- | --- |
| `read` | Read only. Every unsafe request is refused by the API with `SESSION_READ_ONLY`. |
| `write` | Reads, plus the ordinary changes: adding and editing records. |
| `admin` | Everything, including removals — each of which still needs your approval. |

The default is `write` everywhere except the local test profile. The connector
only offers the tools the level allows, and asks the API what the level actually
is rather than trusting the flag it was started with.

The data scope is chosen the same way and at the same moment, with
`--data-scope`, and is likewise the session's rather than this process's. A
session therefore carries three things decided by whoever typed the password:
which client it belongs to, how much it may do, and how much it may see.

## Approving something that cannot be undone

Removals need more than an administrator-level session. When one is attempted,
the API refuses it and hands back a summary and an identifier:

```
Permanently delete risk "Flood damage to the hall"

CharityPilot will not do this until you approve it yourself. In your own
terminal, run:

    charitypilot-mcp approve apr_01H...

You will be shown what you are approving there and asked for your password.
Then call this tool again with exactly the same arguments plus
approvalId: apr_01H... The approval expires at ... and covers only this one
action.
```

The summary names the record, built by the API from the route it matched and
the record it found, never from anything the agent sent. In the terminal,
`approve` shows the same summary, the action and the record's identifier
before it asks for anything, so you are checking the agent's account of what
it is about to do against the server's.

`approve` refuses to run unless standard input is a terminal, and refuses a
piped password even on the local profile. That is the whole point: an agent can
start a process and write to its input, but it cannot type at a terminal. The
approval is bound to a digest of that exact request, is single-use, and expires
in five minutes, so it cannot be spent on a different record however the agent
is persuaded in between.

A time-limited elevation was considered first and rejected: a window elevates
the agent, not you. For its duration every instruction the agent is holding —
including any it read out of a document or a web page — would carry the raised
authority.

## Uploading and downloading documents

Both are off unless you name a directory for them, and neither tool is even
offered until you do:

```bash
node dist/cli.js serve --upload-root ~/charity-docs --download-dir ~/charity-downloads
```

Nothing outside that directory can be read, however the path is spelled. Links
pointing out of it are refused, and dotted directories such as `.git` are never
traversed — an upload root inside a project directory must not become a way to
read the credentials in its configuration.

A download writes the file and reports the path. It never returns the contents:
the personal-data gate can filter a record, but a PDF of board minutes is either
handed over whole or not at all, so keeping the bytes out of the model's context
is the control that remains.

## Everything a change does is recorded

Every unsafe request a connector session makes leaves a row in
`ClientActivityEvent`: the route, the identifier, the status code, the access
level, and the reason you gave. Refused attempts are recorded too, because an
agent that tried to delete something and was stopped is the row most worth
reading. The rows cannot be edited or deleted afterwards, by anyone.

Connector sessions also have their own budget for changes — thirty a minute, per
session — so an agent in a retry loop cannot spend the allowance your browser
shares and lock you out of your own web session.

You can see connector sessions on the Team page, badged with the level they
hold, and revoke any of them from there.

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

No `FRONTEND_URL` entry is needed for the connector any more. It signs in
through `/api/v1/auth/connector/*`, which refuses any request carrying an
origin rather than requiring an allow-listed one.

To point an AI client at the local stack, give it its own credential file so
it never shares the OS credential store entry used for the VM:

```json
{ "mcpServers": { "charitypilot-local": {
    "command": "node",
    "args": ["C:/platforms/htdocs/charity-governence/mcp/dist/cli.js",
             "serve", "--profile", "local", "--base-url", "http://localhost:3002"],
    "env": { "CHARITYPILOT_CREDENTIAL_FILE": "C:/Users/jaspe/.charitypilot-mcp-local.json" } } } }
```

Windows paths in JSON use forward slashes or doubled backslashes; a single
backslash is an invalid escape and the client refuses the file.

`CHARITYPILOT_CREDENTIAL_FILE` is accepted only with `--profile local`; set
it anywhere else and the connector refuses to start.

## Finding things, and reading what you found

`search` looks across trustees, the minute book and its resolutions, the four
registers, documents, deadlines and the Governance Code. Each hit names the
kind of record, the field that matched, the text around the match, and a
reference like `charitypilot://governing-act/abc123`.

`fetch` reads the record behind one of those references. It is a router: it
turns the reference into the ordinary tool call for that kind of record, so
the access level, the toolsets and the personal-data gate apply exactly as
they would if you had called that tool yourself.

Both are offered whatever `--toolsets` you asked for. Narrowing to one area is
only workable if an agent can still find the identifier the narrowed tools
take.

Two resources can be attached for a whole conversation rather than fetched per
question: `charitypilot://governance-code`, the six principles and standards
with this charity's status against each, and `charitypilot://regulator-guidance`,
what each standard asks for under Irish law. Any record is readable as a
resource too, by the same reference search hands out.

## Retrying a create

Every create the connector sends carries an `Idempotency-Key`. If the
connection drops before the answer arrives, it asks once more with the same
key, and CharityPilot either carries it out or replies with the result of the
attempt it already saw. One dropped connection can no longer turn one board
meeting into two.

An upload is the exception, twice over: it carries no key, and a multipart body
already consumed cannot be sent again. A failed upload is reported rather than
retried.

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
- **A read loop no longer locks you out of your browser.** Reads and changes
  are each counted against the session rather than the address, so an agent
  running on your machine cannot spend the allowance your browser needs on the
  same machine. Changes have the smaller budget of the two.
- **Team membership, ownership transfer, billing and most Confluence routes
  have no tool**, deliberately, and each says why in
  `src/mutating-route-coverage.ts`. Confluence disconnection and page erasure
  will not be exposed at all: both destroy pages in the charity's own site,
  and the owner has ruled that must be a deliberate human act.
- **Search is ordered by kind and recency, not by relevance.** It matches
  substrings rather than words, which finds partial words but cannot rank. At
  a charity's size that is the better trade; revisit it if a minute book grows
  past a few thousand resolutions.
- **Search answers differently under the two scopes.** A session that
  withholds personal data does not search the free-text columns at all, not
  even to count a match: being told a record mentions a name is being told the
  name is in it. The answer says which kinds were looked in, so a narrow
  answer is not mistaken for an empty one.
