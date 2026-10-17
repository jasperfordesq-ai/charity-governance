# Protected imported-proof job records

17 October 2026. Local restart observations for the internal managed capture runner. The full delegated recovery goal remains active.

## Original request binding

After the original common candidate request is acknowledged, the parent gives the source callback a frozen context: the full validated binding digest, exact acknowledged request-pin digest and source release SHA. That binding commits installation, epoch, attempt, plan, control revision and capture/window/journal/archive configuration. The callback receives hashes, not a new publication or recovery capability. Tests compare them to the actual returned original request/binding.

Before starting its fixed worker, the runner saves and independently reads back an exclusive protected `proof-job.request.json`. It contains a fresh job UUID, the original context, committed helper SHA, workspace identity digest, snapshot/argument digests, UTC timestamp and REQUESTED_ONLY state. Credentials, raw snapshot IDs, argument values and absolute paths are not stored. The standalone internal proof mode is explicitly labelled and never supplies a fictional common-candidate binding.

The record's source SHA must match the common context. Existing file/parent protection, canonical path checks, descriptor identity, exact size/hash, exclusive creation and flush/readback apply. Linux also flushes the containing directory. Node does not provide the equivalent directory flush here on Windows; the returned flag is false. These tests do not establish persistence after host power failure or independent off-host custody.

## Observation and restart inspection

The live runner can attempt one separate `proof-job.observation.json`, pinned to the exact baseline. Worker exit plus original acknowledgement and observed absence of job containers can record WORKER_EXIT_ACK_OBSERVED. Failure records UNRESOLVED; later container absence does not convert failure into success. A failed or lost result write never permits overwriting, replaying the source or replacing the baseline.

Fresh handles can reopen only a protected direct capture child outside the checkout. They are read-only: no file creation, ACL repair or producer pinning. Inspection requires an independently retained exact baseline pin and expected original scope; it verifies file bytes and workspace identity before returning any observation. A supplied result additionally requires its exact pin and baseline match. An omitted result stays REQUESTED_ONLY even if another file exists. No result is invented or inferred from absence. All returned execution/publication/action permissions remain false.

A separate Node reader process is tested against actual protected files after the original handle closes. Tests also cover missing results, unknown outcomes, duplicate attempts, changed request/version digest, source release mismatch, authority/secret fields and a byte-identical request copied into a substituted directory. The combined native flow reopens job observations after the original dump/report/ciphertext are removed and the snapshot holder disconnects. This does not terminate the main SQL/test process or establish host-loss recovery.

## Remaining gates

The baseline/result pins in the current integration are retained by the calling process. A supported restart service still needs a durable trusted job catalogue bound to the original independent request/control history, exclusive supervisor ownership and process identity, safe orphan/daemon-request reconciliation, and actual Docker cancellation/crash acceptance. Inspection intentionally does not kill a saved PID, clean containers from a recovered local receipt or resume capture. Records alone are not execution authority.

Complete independent provider/root-key/epoch-floor and current preservation/disposal authority, actual source-host-off recovery, replacement secrets/sessions, repeated epochs and guarded application reopening remain required. This component neither creates a supported operator resume command nor completes the multi-organisation product/Confluence scope.
