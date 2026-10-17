# Storage plans before proof-container dispatch

17 October 2026. New managed request catalogues use a version-two header and intents. Before writing the header, the original helper reads the exact digest-pinned PostgreSQL image's declared volume targets through the guarded local daemon. It refuses any declaration other than the reviewed `/var/lib/postgresql/data` target.

Every new `run` intent includes a storage plan before dispatch. It requires the approved image and an explicit approved tmpfs for PGDATA. Only the existing proof/backup/CA bind targets are supported. Backup and CA binds must be read-only. Named volumes, inherited volumes, duplicate targets, uncovered declarations, unreviewed images and unsupported storage syntax refuse before the container starts. Bind sources are recorded as job-bound digests, never raw host paths.

This prevents new helper runs from silently accepting the image's default anonymous PGDATA volume. It is a plan and input-validation control, not proof of the daemon's full historical resource state. Request response accounting remains mandatory; image coverage alone does not settle a request lost during caller failure.

The helper, guardian and original caller require declared-image-volume coverage as well as successful request responses before acknowledging successful source work. The read-only orphan inspector reports coverage separately from pending requests. Earlier version-one catalogues remain readable but acquire no invented storage plan or coverage claim. Local records do not become independent immutable custody or a cleanup grant.

Portable tests cover valid tmpfs/binds, source-path redaction, missing/duplicate coverage, named/inherited volumes, writable backup mounts, unreviewed images, unexpected image metadata and legacy catalogue inspection. The actual source/caller-loss/SQL cohorts must exercise the new plans and live pinned-image metadata. Exact results belong to the private checkpoint.

Complete attached/unattached volume accounting, current original resource ownership, independently surviving requests, daemon-side resolution and source-host-loss recovery remain separate gates. Existing unattributed volumes must not be deleted using this control or an age/name heuristic.
