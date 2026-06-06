# Release Gate Hardening Design

## Purpose

CharityPilot is close to code-level production readiness, but the release gate is not yet trustworthy. The first production-readiness slice will make the repository's release checks deterministic, clear, and aligned with the current branch and generated-file hygiene. This slice improves the path to production without claiming that external launch requirements such as hosting, secrets, monitoring, backups, penetration testing, and deployed browser QA are complete.

## Current Evidence

The current checkout is `C:\platforms\htdocs\CharityPilot` on `master`, tracking `origin/master` for `https://github.com/jasperfordesq-ai/charity-governance.git`.

Verified passing gates:

- `npm run lint`
- `npm run test`
- `npm run build -w @charitypilot/shared`
- `npm run build -w @charitypilot/api`
- `npm run build -w @charitypilot/web`
- `npm run db:generate -w @charitypilot/api`
- `npx prisma validate` from `apps/api`

Verified release-gate gaps:

- `npm audit --omit=dev --audit-level=moderate` fails on transitive `fast-uri`, `qs`, and `ws` advisories.
- `npm run check:production -- --env-file=.env.production` cannot pass because no production environment file is present locally.
- The custom `--env-file` argument name can be confused with Node's own `--env-file` behavior when the named file is missing.
- `.github/workflows/ci.yml` runs on pushes to `main`, but this repository currently uses `master`.
- `apps/web/tsconfig.tsbuildinfo` is tracked build output.
- The production checklist marks the dependency audit as complete even though the current audit fails.

## Approved Scope

This slice will:

- Resolve the current moderate-or-higher production dependency audit failures.
- Rename the production preflight script's custom file argument to a project-specific flag such as `--production-env-file`.
- Make the production preflight script report a clear missing-file error instead of relying on Node's option parsing behavior.
- Update the production runbook to use the new preflight flag.
- Align CI push triggers with the current `master` branch, while preserving pull request checks.
- Add TypeScript build-info files to `.gitignore`.
- Remove the tracked `apps/web/tsconfig.tsbuildinfo` generated artifact from git.
- Update the production checklist so release-check statuses reflect verified evidence after this slice.

This slice will not:

- Create or commit real production secrets.
- Provision Supabase, hosting, DNS, TLS, backups, monitoring, or alerting.
- Complete external penetration testing.
- Complete deployed browser QA.
- Replace the Next.js canary dependency unless that becomes necessary to resolve the current audit failures.

## Architecture

The release gate has three small responsibilities:

- Dependency safety is enforced by `package-lock.json` and the existing `npm audit --omit=dev --audit-level=moderate` gate.
- Environment readiness is enforced by `scripts/check-production.mjs`, which validates an explicit production environment file plus process environment fallback values.
- CI and documentation define the commands and branch behavior that make those gates repeatable for humans and GitHub Actions.

The implementation will keep these responsibilities separate. It will not fold deployment provisioning into local checks, and it will not require secrets to exist in the repository.

## Data Flow

The production preflight script will read a file path from `--production-env-file=<path>`, defaulting to `.env.production`. If the file is missing, it will emit a clear error and exit with code `1`. If the file exists, it will parse key-value lines, merge file values with `process.env` fallback values, and validate required production variables for presence, placeholder values, URL shape, HTTPS requirements, and minimum secret length.

The audit gate will continue to use npm's lockfile resolution. Any transitive vulnerability fix will be expressed through dependency updates or root-level overrides that are visible in `package.json` and `package-lock.json`.

## Error Handling

The preflight script will distinguish missing files from invalid configuration. Missing file errors will name the exact path that was requested. Invalid configuration errors will keep the existing grouped list of missing, placeholder, localhost, non-HTTPS, or malformed values.

CI failures should remain direct command failures. The GitHub Actions workflow will not suppress audit, lint, test, build, or Prisma validation errors.

## Testing

The implementation must verify:

- `npm run check:production -- --production-env-file=.env.example` fails with the expected placeholder and localhost issues.
- `npm run check:production -- --production-env-file=.env.production` fails clearly when `.env.production` is absent.
- `npm audit --omit=dev --audit-level=moderate` passes.
- `npm run lint` passes.
- `npm run test` passes.
- Build commands pass for any package affected by dependency or configuration changes.

Because this slice changes release gates and dependency resolution, verification must include both local command output and a final git status check.

## Production Readiness Impact

After this slice, CharityPilot still will not be fully production ready because external launch requirements remain. The repository release gate will, however, be more truthful: CI will target the current branch, audit status will match reality, generated artifacts will not pollute source control, and preflight failures will be clear enough for a production operator to act on.
