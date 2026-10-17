# Original service inspection after caller loss

17 October 2026. The original service acknowledgement now includes a version-two identity: the current kernel boot ID and exact original cgroup path, together with its existing job, source SHA, invocation, UID, main PID/start and input digest. The local immutable service record and original remote service custody both bind these fields before work is released. Service wrapper/request/observation namespaces remain unchanged; identity versioning is explicit. Older version-one identities remain readable and are never filled in from today's host.

## Operator workflow

Retain the independently held original request/service byte pins and expected source scope. Prepare a private JSON object containing `parentDirectory`, `workspaceRoot`, `requestPin`, `expectedScope`, and the original `servicePin`; include `observationPin` only if independently retained. Invoke:

```sh
node scripts/managed-proof-orphan.mjs < private-original-pins.json
```

The inspector opens the protected workspace read-only, verifies the original bytes and scope, then observes the saved service. It accepts no execution, cleanup, PID, unit override or replay switches. Do not manufacture pins by trusting unverified current files. Retain the output privately; it contains operational identifiers.

Legacy identities return `LEGACY_BINDING_UNVERIFIABLE` without querying the current manager. A different boot returns `DIFFERENT_BOOT` before querying the saved unit or cgroup. For the same boot/UID, the invocation/start and original cgroup must match. A replaced unit returns `UNIT_IDENTITY_CHANGED`; changed observations across the read return `OBSERVATION_CHANGED`. Missing units are distinguished from matching loaded units. A missing unit alone does not establish an empty group.

## Recursive process observation

The inspector and original contained launcher's emptiness gate use `cgroup.events`' recursive populated flag. A parent group's `cgroup.procs` can be empty while a descendant still contains processes. The kernel documents that [the populated notification includes descendants](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#un-populated-notification). Paths are constrained to the original non-root user's exact service hierarchy; traversal, aliases and malformed event data refuse.

An empty/absent recursive group is an observation on the same boot. It grants no cleanup or replay authority. Docker resources and pending requests live outside that cgroup; this inspector explicitly denies complete resource accounting and does not invoke daemon reconciliation. It does not stop/reset a unit, signal a saved PID, delete a socket/workspace or modify a writer fence. Run the separate [read-only residue inspection](managed-proof-residue-inspection.md) for bounded daemon observations, preserving both tools' limitations.

## Verification and remaining work

Portable tests cover legacy/different boots, unit reuse, changed observations, malformed scopes, recursive population parsing and denial of all action authority. Local and remote custody readers validate both identity versions without turning an old version into a current one. The actual contained caller-loss cohort must prove a fresh process and the operator command can read original version-two pins after SIGKILL while the old other-job control survives. Exact runs belong to the private checkpoint.

This is the read-only restart-inspection portion of orphan handling. Original accepted/pending daemon-request custody, complete storage accounting, an explicitly authorised resolution flow, independent provider custody and physical source-host recovery remain open. No recovered acknowledgement, tenant approval or reviewer sign-off is implied.
