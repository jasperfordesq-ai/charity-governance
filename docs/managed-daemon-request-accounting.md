# Original daemon-request accounting

17 October 2026. Local source implementation for state-changing Docker requests made by the original imported-snapshot helper. This closes an unsafe inference: a currently empty container listing does not prove that a request issued before worker loss cannot finish later.

## Before dispatch

For a managed job, the source helper creates an exclusive header in its existing protected capture directory. It binds the original job and input digest. Before each `run`, state-changing `exec` or `rm`, it writes an exclusive intent containing the sequence, previous intent digest, operation, allowlisted container name/ID and a domain-bound argument digest. It syncs the file and directory before dispatch on Linux. No command body, environment, SQL, credential, snapshot or key is saved.

Existing read-only daemon inspection and the exact restore `pg_isready` probe are outside this mutation catalogue. Unknown future mutation kinds refuse before dispatch. These records are not a claim to account for every possible Docker request or all daemon resources.

## Responses and uncertainty

An original response record links its intent pin and records only status, transport-error/signal booleans and narrowly recognised idempotent removal absence. Removal absence must refer to the exact original target. A missing response, nonzero/transport/signal ambiguity or missing original end remains unresolved. Starting the same journal again is refused. An end marker alone cannot manufacture a missing response.

The helper must finish and read back its original catalogue. The guardian and original caller independently inspect it before acknowledging successful source work. They cannot report the job's resources absent or a successful outcome merely because a post-cancellation listing is empty while mutations remain unresolved. Best-effort cleanup of positively attributed current clients is still distinct from closing unknown requests.

The [original-pin orphan inspector](managed-proof-orphan-inspection.md) also reads these records using the input digest bound by the original service pin. It can show unresolved requests after caller loss. It does not replay, repair, delete or authorise cleanup. Older jobs without a catalogue remain `NOT_RECORDED`, not implicitly complete.

## Scope and proof limits

This is a protected local catalogue with original-context readback. It is not independently immutable custody, protection from a compromised source user, rollback protection, a daemon-side cancellation fence or a replacement-host recovery grant. The Windows internal fixture does not establish Linux directory-sync or kernel containment guarantees. Every inspection denies complete resource inventory, cleanup and execution authority.

Accepted/pending remote work still needs an independently surviving request owner or a proven daemon-side fence before an authorised resolution can close it. Unattached volumes and full storage history remain outside this catalogue. Do not delete the original scope or clear a writer fence on the basis of an end marker or an empty list.

## Verification

Portable tests check intent-before-dispatch ordering, lost/ambiguous responses, exact removal absence, source/input substitution, corrupt/unknown catalogue entries and refusal of unsupported mutation types. The actual contained caller-loss test must show an unresolved recorded mutation even after its accepted client is removed. The launcher fixture also tests a successful worker acknowledgement combined with unresolved request accounting; that combination must fail. Full genuine source SQL/restore/custody success remains a required regression gate. Exact revisions, results and limits are recorded privately.
