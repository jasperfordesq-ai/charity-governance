# Cited-page lifecycle observation

Owners can open **Documents → Confluence citations → Observe cited page** for a
saved citation. Supply a separate accessible current page as a control. This is
an explicit read of an existing citation, not a request to delete anything.

`GET /integrations/confluence/references/by-id/:referenceId/observation?controlPageId=...`
requires an Owner web session at ADMIN session level. Admins, Members, connector
clients and reduced-level sessions cannot use it. Responses are not cached.
The server selects the citation and its live linked document within the current
organisation. It takes the provider site/page identity from that saved citation;
callers cannot substitute a target, provider URL or deletion instruction.

## Scope and outcomes

The observer reads the control, the cited page in normal status, and its Trash
status when needed. The content reader refuses writes, more than 256 requests,
or starting a request after 30 seconds. An in-flight HTTP request retains its
existing retry/deadline bounds; this is not an absolute 30-second deadline.
The current connection/site/grant is checked around token resolution and after
observation. The citation identity, cited version/times and live-document scope
are reread before returning a result. Changed or removed records are UNKNOWN.

| Result | Meaning |
| --- | --- |
| VISIBLE | The cited page was returned in normal current status. |
| TRASHED | The page was observed in recoverable Trash. |
| NOT_OBSERVED | These reads did not return the page; restricted access can explain absence. |
| UNKNOWN | The control, connection, identity or consistent read could not be established. |

Scope is always `CITED_PAGE_ONLY`. Citations do not contain an attachment
inventory: attachments, historical versions, unrecorded copies and provider
backups are outside this check. No deletion job, citation change, content write,
disposal authority or permanent/all-copy erasure verification is produced.
Purpose-bound OAuth refresh may still update credential state. The UI clears
old observations on new input/read and refuses mismatched response bindings.

This complements the existing version check, which compares the cited and
current version, and the [recorded erasure-target observation](confluence-erasure-observation.md),
which requires an actual saved deletion instruction. Never create a pending
deletion job merely to inspect a retained source.

## Evidence boundaries and remaining work

Service and route tests cover scoped live-document identity, separate control,
normal/Trash/ambiguous/unknown outcomes, grant and citation changes, role/client/
session refusal, redaction and rejection of destructive transport. The browser
journey uses the actual application and disposable database with a synthetic
Atlassian service; it checks unchanged citation rows and zero deletion jobs.
Exact dated results, including any failed attempts, belong in the private handoff.

These observations are transient. A separate [historical cited-page report](confluence-citation-review.md)
now saves citation identity, an explicit absence of deletion instruction, the
Owner's report and a fresh provider observation. The existing historical
erasure-report workflow remains bound to deletion jobs. Source or fake-provider tests do
not establish current live OAuth acceptance, actual disposal, independent
decision custody or recovery after physical host loss. Administrator Trash/purge
and any real customer rollout retain their separate authority requirements.

The final isolated browser journey passed with actual application/API/PostgreSQL
and the fake provider. It verified the visible-page result, an unavailable control,
clearing stale results after input and citation-list refresh, complete unchanged
citation rows and zero deletion jobs. The panel fit 320/768/1440 widths and passed
light/dark WCAG checks. Focused API checks passed 154/154; connector coverage passed
427 tests with two existing Windows skips. These are local source results only.
