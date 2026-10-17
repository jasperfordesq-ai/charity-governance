# Development dependency advisory follow-up

17 October 2026. This follow-up concerns development tooling. The original
repo-wide audit reported six entries; a separate omit-dev audit reported none.
Neither snapshot establishes permanent dependency or production readiness.

## Copier fixed in source and locally verified

[GHSA-jggr-w7fw-pc2j](https://github.com/advisories/GHSA-jggr-w7fw-pc2j)
identifies fast-copy4.1.0 as the patched4.x version for unbounded recursive copy.
The root override now pins4.1.0, replacing4.0.2 in the existing pino-pretty
development dependency path. No runtime dependency, Next version or unrelated
package version changed. Unrelated optional-platform metadata rewritten by npm
was restored before review.

The regression suite resolves the copier **from the actual pino-pretty
consumer**, verifies normal Buffer/Date/nested/circular copies, and exercises
deep input through both copy and copyStrict. The expected result is the patched
MaxDepthExceededError, not uncontrolled call-stack exhaustion. It also verifies
actual pino-pretty formatting and configured field omission without mutating
the original ordinary log object. This does not promise that every caller
handles a deliberately over-depth development log gracefully.

## Braces remains unpatched and OPEN

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
reports no patched braces release as of this review. The registry still lists
3.0.3 as latest. Moving to the available Next lint16.4.0 would retain fast-glob
and the same affected chain, so that unrelated update was not made.

The installed16.2.6 Next plugin's observed fast-glob call is in getRootDirs(),
used by no-html-link-for-pages. It invokes the glob path for an explicit
settings.next.rootDir string/array; without that setting it returns literal cwd.
Our effective lint configuration leaves rootDir unset. The regression suite
checks every current lint-target source file plus next.config.ts, and exercises
the actual installed helper with deeply braced literal cwd and no rootDir.

This is a verified configured exposure boundary, **not an upstream package
patch or a claim that arbitrary fast-glob/braces input is safe**. All five
remaining high-severity audit entries inherit from this one advisory. No lint
rule, audit threshold or advisory report was suppressed. The issue remains in
the remediation ledger for a real upstream fix or removal of the affected
chain while preserving the existing lint coverage.

## Gate and evidence

`npm run test:dependency-advisories` runs the four regressions. The root test
command runs it before the existing Turbo/production/personal-server/local-
Docker test sequence, preserving every previous gate. CI already invokes that
root command; no workflow credential, deployment or hosted policy changed.

Local checks passed: the new regression command, existing lint command and API
TypeScript build. The full audit now reports five high entries and no moderate
entry; omit-dev remains zero in this dated snapshot. Exact CI/release evidence
must still be checked on the resulting commit. Source/local verification does
not prove deployment, actual provider recovery or goal completion.

Continue the managed S3 custody/evidence/parent and already-disabled observation
work, followed by the remaining whole-backend/common capture/independent
authority/full-restore/provider-host-loss gates. Another personal review from
Nikita remains optional under the existing delegated product authority.
