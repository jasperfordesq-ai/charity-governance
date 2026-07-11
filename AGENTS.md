# CharityPilot Agent Notes

This workspace belongs to the CharityPilot / charity governance platform project.

Canonical GitHub repository:

https://github.com/jasperfordesq-ai/charity-governance

Agents working in this directory should treat that GitHub repository as the source-control home for this project.

## Active Continuation Goal

Before starting production-completion work, read:

- [CharityPilot Agent Continuation Handoff](docs/agent-continuation-handoff.md)
- [Full-Platform Remediation Audit](docs/platform-remediation-audit-2026-07-10.md)

Before changing the private, single-charity Windows deployment profile, also
read:

- [Personal Server Deployment on Windows](docs/personal-server-deployment.md)
- [Personal Local Use Readiness](docs/personal-local-use.md)

That handoff records what has been achieved in the long-running product/production launch session, what remains blocked by real production providers or human review, and how to continue without dropping scope.

The remediation audit is the authoritative human-maintained issue ledger for the
2026-07-10 full-platform audit. Do not treat passing local tests or the generated
platform audit as closure while any item in that ledger remains unresolved.

The compiled `personal-server` profile is a separate operating mode for one
charity. Its front-door web server is Caddy; Caddy routes `/api/v1/*` to the
Fastify API and every other request to the compiled Next.js Node server. Only
Caddy may publish a host port, and that port must remain loopback-only. Routine
start must never migrate or seed. Do not weaken the strict public-production
profile, remove organisation scoping, or treat private-profile verification as
public-launch evidence.
