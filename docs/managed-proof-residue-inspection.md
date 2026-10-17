# Read-only proof residue inspection

17 October 2026. This replaces global age-based proof-container deletion. Starting a restore proof no longer scans for and deletes another operation's old labelled containers. Normal per-invocation cleanup and the original supervised exact-job guardian remain separate.

## Operator command

From the canonical source checkout on the supported local Docker host:

```powershell
node scripts/postgres-backup.mjs inspect-proof-residue
node scripts/postgres-backup.mjs inspect-proof-residue --job-id=<original-job-uuid>
```

The same commands run in a Linux shell. They use the helper's verified local Docker endpoint. No remote-daemon override, cleanup/replay switch, database credential or login is needed. The optional job ID filters labels; it does not prove ownership. Keep retained reports private because IDs and storage names are operational metadata.

The command performs two bounded listings around inspection of at most 64 labelled containers. A changed identifier set, duplicate/truncated identifier, substituted scope, failed read or unsupported mount refuses the report. It returns only allowlisted IDs, recognised names, validated job/timestamp labels, running state, descriptive age and attached storage names/counts. It excludes environment values and host bind paths. Unknown label metadata remains unverified rather than being promoted into authority.

## Meaning and limits

An old timestamp suggests investigation. It does not establish that the owning process ended or authorise deletion, even if a container is stopped. The command performs no stop, removal, pruning, SQL, restore or replay. Missing labels do not grant cleanup permission either.

Matching identifier sets are a bounded observation, not a transactional daemon snapshot. A pending daemon request can create resources after a listing. Unattached volumes, host directories/socket files, kernel cohorts and requests that have not yet created containers are not accounted for. Every report explicitly denies complete resource accounting, cleanup, execution and action authority. An empty result must not reopen a writer fence or admit recovered history.

For unresolved work, retain the original request/service/outcome pins and original source scope. A future supported orphan-resolution flow must bind the original manager cohort, account for accepted and pending daemon work and storage, and establish current authority before any mutation. This inspection command is a component of that flow; saved labels, age and numeric PIDs are never a replacement.

## Verification

Portable tests cover old running containers, legacy/malformed labels, storage redaction, changed listings, scope substitution, limits, empty listings and refusal of mutation switches. The real contained caller-loss cohort uses a separately owned control with a two-hour-old creation label. It must remain running through source work and caller death; read-only inspection must observe it before and after. Exact revision/run results and unresolved resource observations belong to the dated private checkpoint.

Docker's primary references describe [label filtering](https://docs.docker.com/reference/cli/docker/container/ls/) and [formatted inspection](https://docs.docker.com/reference/cli/docker/inspect/). Treating those observations as non-authoritative is CharityPilot's engineering decision, not a Docker ownership guarantee.
