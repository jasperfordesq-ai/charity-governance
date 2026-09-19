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

## The personal-data gate

By default, the connector answers governance questions without sending
personal data to your AI model provider. Concretely, with no flag:

- **Board register**: trustee names and roles, appointment and term dates,
  and conduct/induction status come back. Dates of birth, home addresses,
  former names, other directorships, and email addresses do not.
- **Member register**: only counts and dates (when someone joined or left,
  retention deadlines) come back. Member names and addresses do not.
- **Conflicts register**: status, dates, meeting/review dates and minute
  references come back. The matter, its nature, the action taken, the
  decision, the trustee's name, and — deliberately — the board-member id
  itself do not. The id is withheld along with the name because it's a
  foreign key into the board register: anyone holding both the (safe) board
  register and a conflicts register that kept the id could join the two and
  work out exactly who declared which conflict. Redacting the name while
  leaving the id in place wouldn't actually redact anything.
- **Complaints register**: status, received date, and whether/where it was
  reviewed and minuted by the board come back. The summary, source, action
  taken and outcome do not.

What's left in every case is the compliance-shaped half of the data: counts,
statuses, dates, minute references, whether something was reviewed and
minuted. That's enough to answer the governance questions this connector
exists for — what's outstanding, what needs board attention, whether
something was properly recorded — without the content of anyone's personal
or sensitive record leaving the building.

Pass `--allow-personal-data` and all of it comes back: dates of birth, home
addresses, conflict details, complaint summaries, the lot. Doing so isn't a
convenience toggle — it means that data is being sent to whichever AI model
provider your client uses, which is a data-processing decision with its own
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
