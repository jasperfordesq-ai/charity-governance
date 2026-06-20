# Session summary — architecture map + E2E suite

**Branch:** `docs/architecture-and-e2e` (off `7fcd404`). **Not** merged to master,
**not** pushed — left on the branch for review.

This session produced the project's missing architecture/dependency map and an
end-to-end test suite. It was a build-and-document task: no production code was
changed, and the release gate (`npm run lint`, `npx turbo test`) was kept green at
every commit.

## Commits (review in order)

| Commit | What |
| --- | --- |
| `e6fa2c9` | **Phase 1 — Architecture & dependency map.** `docs/ARCHITECTURE.md` + 10 grounded references under `docs/architecture/`. |
| `af2d7e4` | **Phase 2 — E2E suite.** Standalone `e2e/` Playwright project + CI workflow. |
| `ac3d4bb` | **Phase 3 — Dependency inventory.** `docs/DEPENDENCIES.md` + `overrides` rationale. |

```bash
git checkout docs/architecture-and-e2e
git log --oneline 7fcd404..HEAD
git diff 7fcd404..HEAD --stat
```

## Phase 1 — Architecture & dependency map

Entry point: **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** (component diagram +
two-gate model + index). Ten focused references in `docs/architecture/`:

1. System overview · 2. Module & dependency graph (12 route groups → 16 services →
22 Prisma models) · 3. Data model · 4. Request lifecycle & auth/session ·
5. Billing · 6. Document storage · 7. Reminder scheduler · 8. Governance domain ·
9. Frontend · 10. Config & two-gate model.

- Every non-trivial claim carries a `file:line` citation. **All 638 code citations
  and 69 inter-doc links were validated mechanically** (file exists, line in range,
  link resolves) and each section was independently fact-checked.
- Diagrams are GitHub-renderable Mermaid (flowchart / sequence / state / ER).
- A pointer was added to `README.md`.

**How to review:** open `docs/ARCHITECTURE.md` on GitHub (the branch) and confirm the
diagrams render and a few citations land where claimed.

## Phase 2 — End-to-end test suite

Standalone Playwright project in **`e2e/`** (see [`e2e/README.md`](e2e/README.md)),
deliberately **not** a root workspace so Playwright never enters the API/web
production installs or images. Drives a real Chromium browser against the local
Docker stack with **no external providers**.

Specs (each independent), **all passing** (verified, incl. `--repeat-each` stress):

- `auth.spec.ts` — register → email-verify → log in → dashboard (+ invalid token)
- `compliance.spec.ts` — record a standard → board sign-off
- `documents.spec.ts` — upload → download (byte-verified)
- `deadlines-team.spec.ts` — create/complete a deadline; invite → accept → join
- `billing.spec.ts` — tier + trial + Complete-plan gating (Stripe test mode)

Determinism: single worker, DB reset in `global-setup` (governance reference data
preserved), unique data per test, one rate-limit-safe shared owner. One-time tokens
are injected via the DB because email is a local no-op and verify/invite tokens are
stored sha256-hashed. Helpers are hardened against the Next.js dev hydration race.

**How to run:**

```bash
docker compose -f compose.yml -f compose.local.yml up   # stack must be up
npm run test:e2e:install                                # once: deps + Chromium
npm run test:e2e
```

CI: **`.github/workflows/e2e.yml`** boots the stack, runs the suite, uploads the
HTML report. It's a **separate** workflow from the main gate so it never blocks
lint/test/build.

## Phase 3 — Dependencies

**[`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md)** — production deps per workspace
with purpose, and the rationale (grounded in git history) behind each `overrides`
security pin (`form-data`, `fast-uri`, `qs`, `ws`, `postcss`).

## Findings

No real defects were found while documenting (the code gate was already verified),
so **no `docs/FINDINGS.md` was created** — that file is intentionally absent.

## Needs Jasper's decision

1. **Stale theme branches — recommend deleting both.** `fix/theme-body-dark-surface`
   and `fix/theme-dark-light-polish` are **0 commits ahead of `origin/master`** with
   an **empty diff** — their changes are already fully merged into master (PR #1 /
   commit `4a9c41f`). They carry nothing new. I did not delete them (that's an
   outward action); suggested cleanup once you agree:
   ```bash
   git push origin --delete fix/theme-body-dark-surface fix/theme-dark-light-polish
   ```
2. **Merge / PR for this branch.** Left unpushed per the brief — open a PR for
   `docs/architecture-and-e2e` when you're ready to review.
3. **E2E CI trigger.** `e2e.yml` runs on `workflow_dispatch` and on PRs touching
   `apps/**`, `packages/**`, `compose*`, or `e2e/**`. Narrow/broaden as you prefer;
   it's heavier than the core gate, hence kept separate.

## Notes

- The local Docker stack is currently **running** from this session
  (`charitypilot-api-local`, `-db`, `-web-local`). Stop it with
  `docker compose -f compose.yml -f compose.local.yml down` (add `-v` to drop volumes).
- `apps/web/next-env.d.ts` shows as modified in the working tree — a Next dev-server
  regeneration artifact, intentionally **not** committed. `git checkout -- apps/web/next-env.d.ts` to discard.
- The E2E reset truncates the seeded local-admin workspace; restarting the `api`
  container re-seeds it (it runs `prisma migrate deploy && db:seed` on boot).
