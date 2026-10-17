# Original plan and current storage observation

17 October 2026. The protected original-pin orphan inspector now compares the original run plans with live container metadata and reports current daemon volume attachments. It remains read-only and grants no ownership, cleanup, replay or reopening authority.

## Original plans

Validated daemon-request inspection returns the recorded planned container targets. New storage plans use nested version two to retain tmpfs options as well as type, target, read-only state and bind-source digest. Earlier plans remain readable; missing option detail is never reconstructed from today's daemon. The original request header, intent and response versions retain their existing meaning.

## Bounded live observation

On a verified same-boot original host, the existing `managed-proof-orphan.mjs` command also lists this job's current labelled containers and the daemon's volume names. It inspects selected metadata only: no environment values, file contents or volume mountpoints are returned. Bind sources are compared through their original job-bound digests, then omitted from output.

For each currently listed planned container, it compares the approved image reference, mount target/type, read-only state, bind source digest and tmpfs flags/size. Planned-but-absent containers remain `NOT_LISTED_AT_BOUNDARY`; unexpected job containers remain `UNPLANNED_JOB_CONTAINER`. A matching current plan is a correlation, not proof of original ownership or daemon-request settlement.

The observer lists every current volume within its bound and checks its current container attachment IDs. No current attachment is reported as `NO_ATTACHMENTS_OBSERVED`; it does not mean safe to delete. A matching job label is `JOB_LABEL_ONLY_UNVERIFIED`. Other labels, age and names cannot promote a volume into an owned resource. Attachment and resource listings are checked again; changed or substituted metadata refuses the observation.

The bounds are 64 job containers/plans, 128 volume names and 128 attachment IDs per volume, with bounded selected JSON per read. Over-limit or failed reads refuse rather than presenting partial results as complete. The old/different-boot/ambiguous original-cohort path does not automatically attribute the current daemon to the old source.

## Proof limits

This is current metadata under the existing trusted-host assumptions. It is not a transactional daemon snapshot, historical inventory, independent immutable custody, cancellation of pending requests, cleanup lease or provider/host-loss proof. Concurrent or later resource changes remain possible. Complete-resource, historical-volume, pending-request, cleanup, execution and action authority are explicitly false.

The actual caller-loss test must compare a real blocked TLS client's mounts while live, then observe the planned container absent but its original request unresolved after caller death. The other-job control must remain running. Portable tests cover mount/source/options drift, legacy insufficient plans, attached/unattached labels, changed/substituted listings and absence without authority. Exact runs and remaining unattributed resources belong to the private checkpoint.
