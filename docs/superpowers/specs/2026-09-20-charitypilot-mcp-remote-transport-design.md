# CharityPilot MCP connector: remote transport design

Written 2026-09-20 as Phase G of the connector audit
(`2026-09-20-charitypilot-mcp-connector-audit-and-improvement-plan.md`).

**This is a design, not a build.** Nothing in it has been written. Two things
have to happen first, and neither is an engineering decision: the platform has
to be reachable from the public internet, which is step 4 of the DPO's agreed
order of work, and the DPO has to see this design, because it is the first time
a model provider's servers would talk to the API directly rather than through
software running on the owner's own machine.

## What it buys, and what it costs

Today the connector is a program each person installs and runs. It needs Node,
a clone of the repository, a build, and Tailscale connected. It works from
Claude Desktop and Claude Code on that machine and nowhere else.

A remote connector is a URL. A trustee opens claude.ai on a phone, adds the
connector, signs in through a browser consent screen, and asks the charity a
question. There is nothing to install and nothing to keep up to date. That is
how every vendor connector this one was benchmarked against is heading, and it
is the largest single gap remaining.

The cost is that the API becomes directly reachable by a model provider's
infrastructure, with a token that provider holds. Three properties that
currently hold by construction stop holding by construction:

- **The credential lives on a machine the charity controls.** Today it is in
  the owner's OS keychain. Remotely it is held by the provider.
- **The connector is the only client.** Today the non-browser guard means only
  software identifying itself as the connector reaches those routes. A remote
  transport is reached by a browser-adjacent client by design.
- **Approval needs a terminal.** An agent cannot type at one. On a phone there
  is no terminal at all.

The first two are traded deliberately for reach. The third is already solved:
the approvals page built in Phase C grants the same rows, with the same digest
and the same single use, after re-entering the password.

## The shape

One new endpoint on the existing API, and no second service.

**Transport.** `POST /mcp` speaking Streamable HTTP, served by the SDK's
transport inside the Fastify process. The stdio server stays exactly as it is:
both call the same tool definitions, the same field policy and the same client.
A tool must not know which transport it is answering.

**Authorization.** OAuth 2.1 with the API as its own authorization server,
which is what the specification expects of a remote MCP server:

- Protected-resource metadata at `/.well-known/oauth-protected-resource`, and
  authorization-server metadata at `/.well-known/oauth-authorization-server`.
- Authorization code with PKCE. No implicit grant, no password grant.
- **Client ID Metadata Documents** rather than Dynamic Client Registration.
  The 2025-11-25 revision recommends it and the current revision deprecates
  dynamic registration; it also means the API never stores a client secret for
  a client it has never met.
- The consent screen is a CharityPilot page, signed in as the person, and it is
  where the session posture is chosen: access level (read, write, admin) and
  data scope (withheld, full), exactly as `connect --access-level` and
  `--data-scope` choose them today. The same role floor applies to the scope.
- Tokens are the session's. A remote session is an `AuthSession` row with
  `clientKind` = a new `MCP_REMOTE`, so everything already keyed on the posture
  keeps working: the read-only refusal, the level gate, the approval
  requirement, the write budget and the activity log.

**Why a third clientKind rather than reusing MCP_CONNECTOR.** The two differ in
where the credential lives and who may reach them, and the activity log and the
Team page should say which. A row that cannot tell them apart cannot answer
"was that from the laptop in the office or from a phone".

## What must not change

- **The non-browser guard stays on `/api/v1/auth/connector/*`.** Those routes
  return tokens in the body and set no cookie; that is only safe because no web
  page can reach them. The remote transport does not need them: it has OAuth.
- **The field policy is unchanged.** A remote session carries a data scope like
  any other, and the same allowlist filters the same payloads.
- **Per-action approval is unchanged.** A remote session asking for a removal
  gets 428 and an approval identifier, and the person grants it on the
  approvals page. The digest still binds it to the one request.
- **No new tool.** The remote surface is the same tools, or it is a second
  surface to keep honest, and it will not be kept honest.

## What is genuinely new, and therefore needs deciding

| Question | Why it cannot be answered by engineering alone |
|---|---|
| Does the charity accept a model provider holding a live credential to its records? | It is the same question as the personal-data gate, one level up. The DPO should answer it. |
| How long may a remote session live, and does it expire on inactivity? | A laptop in a locked house is not a provider's token store. |
| Does a remote session get the full access levels, or only read? | Read-only remote is a smaller step that still delivers most of the value: asking the charity questions from a phone. |
| Which origins may complete the consent flow? | Needs the production hostname, which does not exist yet. |
| Is the data scope offered at all remotely? | Releasing a trustee's home address to a provider-held session is a different decision from releasing it to the owner's own laptop. |

**Recommendation.** Ship it read-only first, with the data scope fixed at
withheld. That is one narrow, reviewable change that gives a trustee the whole
question-answering surface from a phone, and it defers every hard question
about provider-held write credentials until there is experience of the easy
case.

## Order of work, once unblocked

1. The hosting move (the DPO's step 4). Nothing here starts before it.
2. This design reviewed by the DPO, with the five questions answered.
3. `MCP_REMOTE` on the posture columns, and the Team page showing it.
4. The metadata endpoints and the consent screen, with the posture choice.
5. The Streamable HTTP endpoint, sharing the tool definitions.
6. A live suite that drives it the way `connector-live.spec.ts` drives stdio:
   the gate in both states, tenant isolation both ways, a refused removal
   approved on the page, and the activity log naming a remote session.
7. Only then, if the owner wants it, writes from a remote session.

## What would be wrong to do instead

- **Weakening the non-browser guard so a page can reach the connector routes.**
  It would undo the property that lets those routes hand back tokens at all.
- **A second server process.** Two deployments of the same tools drift, and the
  one nobody runs locally is the one that breaks.
- **Bearer tokens minted by hand for remote use.** The whole point of the OAuth
  flow is that the person sees what they are granting and can revoke it from
  the Team page.
- **Building it before the hosting move.** It cannot be tested end to end
  against a host that does not exist, and an untested authorization server is
  worse than none.
