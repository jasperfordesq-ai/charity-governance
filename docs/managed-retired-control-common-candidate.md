# Retired-control common recovery candidates

## Scope and versioning

Explicit plan format 12 now uses common candidate binding format 5. Formats 9/10
and candidate formats 2/3/4 retain their meaning; plan 11 remains refused for
capture and current discovery. No route or tenant enables this internal policy
automatically.

The new original request binds the retirement configuration, public comparison
descriptor digest, and original intent, canary-baseline and retirement-report
pins. The complete binding is carried through source-job context and archive
request/report/root custody. Legacy requests cannot silently acquire this claim.

## Execution

Original conditional candidate acknowledgement precedes fresh canary probes and
source work. Before and after joined read-role snapshot capture, the coordinator
rereads the original retirement records and current key-absence metadata, then
checks retired-key GET refusal bracketed by the configured JWT positive control.
It uses the preserved pre-retirement baseline; it never reruns baseline reads
with the retired key. Scope, SQL role, JWT signing-key identity, chronology,
metadata state and exact pins must agree. Head changes or failed comparisons
prevent archive publication. Unknown request/report/root ACKs remain unresolved;
saved observations cannot reconstruct acknowledgement or permit replay.

## Cold discovery

ManagedSavedRetirementCustody reads three fixed original objects from the known
independent storage configuration and bound plan/closed head. It checks exact
versions, KMS/checksums, canonical records, preimage/configuration digests and
public evidence without an old capture JWT, retired secret or provider token.
Current catalogue discovery rereads these records around enumeration. Direct
root verification also rereads them before and after archive verification;
an embedded report copy cannot replace missing or changed originals.
Historical bound-record reads do not establish that their revision is current.

## Evidence limits

Local regression tests use real signatures and SDK serialization with modelled
provider/storage/source/archive transports. Fresh full native canonical SQL,
separate kernel/process loss and cold-reader execution for this new format remain
to be run; earlier format-4 proofs do not establish format-5 execution. Actual
provider propagation, signing-key currency, project SQL identity, unfiltered
visibility, remaining privileged writers/issuers, independent IAM/current tenant
authority and physical-host-loss reopening remain open. All admission, global
writer exclusion and action-authority claims remain false.
