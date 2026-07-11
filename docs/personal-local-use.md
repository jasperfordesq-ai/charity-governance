# Personal Local Use Readiness

This checklist is for one-person, local-computer use of CharityPilot for a
single charity workspace. It is not production launch approval, does not require
Stripe, Supabase, Resend, DNS, TLS, public hosting, or final legal signoff, and
does not prove the platform is legal advice.

This document covers the source-mounted development stack only. If several
directors need a faster compiled installation that remains hosted on a Windows
computer and is reached through private HTTPS, use the separate
[Personal Server Deployment on Windows](personal-server-deployment.md) guide.
That profile has a different Compose file, origin model, account lifecycle and
operator commands.

Use this gate before entering records you care about:

```bash
npm run personal:ready
```

The command proves:

- the local Docker stack boots API, web, and PostgreSQL on loopback ports only;
- the seeded local owner can sign in;
- seeded starter documents can be downloaded from local filesystem storage;
- a temporary document can be uploaded, downloaded, and deleted;
- the local PostgreSQL database can be backed up and restored into a disposable
  verification database;
- local document storage can be copied into `.charitypilot-backups/documents`;
- core personal-use pages render in light and dark mode for the seeded owner;
- billing remains safe when Stripe is not configured.

It may remove ignored Next.js build/cache directories under `apps/web` before
booting the local stack. Those are generated artifacts, not charity records.

The browser pass is intentionally a local personal-use smoke, not a full route
inventory. Use the responsive and accessibility suites when you need exhaustive
page/theme coverage.

The command intentionally does not run the full Playwright suite. The managed
E2E runner starts a separate standalone stack with a fresh UUID-bound database,
dedicated loopback ports, tmpfs database/document storage, and a baked
production web build served from the read-only runner image, with no host mount
or persistent volume. Database, API, and web remain internal-only;
each has a unique reserved `.invalid` alias, and one minimal secretless TCP
gateway uses only those absolute internal names while publishing the three
loopback ports from a separate project-scoped edge bridge. Before startup the
runner validates one private immutable Compose snapshot, the exact topology,
health/tmpfs bounds, and migration DSN, and pins all Docker work to a proven
local daemon. After startup and before any browser reset it attests the exact
fresh image IDs and live container isolation. For broader browser QA, run:

```bash
npm run test:e2e
```

The old boolean reset flag is retired and never authorises reset. Do not
hand-craft a test DSN or point direct Playwright at ports `3002`, `3003`, or
`5434`; the managed runner rejects ambient/personal targets and keeps personal
records isolated from browser-test data. A cleanup or residue failure makes the
E2E run red and retains recovery inputs instead of silently declaring success.

## Daily Personal-Use Routine

This routine starts `compose.local.yml`, including development watchers and
source bind mounts. It is a local development/personal confidence path, not the
compiled `compose.personal-server.yml` runtime. Do not use its loopback URL as a
remote director-access method and do not expose its ports through a router.

1. Start CharityPilot:
   ```bash
   docker compose -f compose.yml -f compose.local.yml up
   ```
2. Open <http://localhost:3003>.
3. Sign in with `admin@charitypilot.local`.
4. Before and after important governance work, run:
   ```bash
   npm run personal:ready -- --no-browser
   ```
   This refreshes smoke, database restore proof, and document-storage backup
   without running the browser page sweep.
5. Keep `.charitypilot-backups/` backed up outside this repo, for example to an
   encrypted external disk or private cloud backup.

`npm run personal:ready` does not prove the personal-server profile is healthy,
does not verify Tailscale or Cloudflare access, and does not replace that
profile's database-and-document recovery procedure. Conversely, a working
personal server does not make the destructive broader E2E suites safe to run
against personal records.

## Remaining Human Responsibilities

- Keep the computer itself protected with disk encryption, OS login protection,
  and normal malware/update hygiene.
- Do not expose ports `3002`, `3003`, or `5434` to the public internet.
- Review any governance/legal wording against your charity's circumstances.
- Keep independent copies of key final exports and board-approved documents.
- Do not treat the local app as a substitute for professional legal,
  governance, tax, employment, safeguarding, or data-protection advice.
