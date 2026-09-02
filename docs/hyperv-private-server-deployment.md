# CharityPilot on a Hyper-V VM (private Linux server)

Last reviewed: 2026-08-09

How to run the `private-linux-server` profile in a Hyper-V virtual machine on a
Windows workstation, reached privately over Tailscale. This is a **supervised
testing** deployment: see [Known gaps](#known-gaps) before trusting it with real
charity records.

This document complements
[`personal-server-deployment-linux.md`](personal-server-deployment-linux.md),
which remains the authority on the profile itself. This one covers only what is
specific to the Hyper-V + Tailscale arrangement.

---

## Why a VM rather than the Windows profile

The Windows `personal-server` profile requires Docker Desktop on the workstation
itself, and explicitly does not promise unattended boot before a Windows user
signs in. A Hyper-V VM configured with `AutomaticStartAction = Start` boots with
the host, before any interactive logon, and runs Docker Engine natively rather
than through Docker Desktop. It also keeps the charity's data on a dedicated
machine boundary rather than sharing the workstation's Docker daemon.

---

## Topology

```text
Windows host
  └── Hyper-V VM  (Ubuntu 24.04 LTS, auto-starts with host)
        ├── tailscaled ──── Tailscale Serve, tailnet-only HTTPS
        │                     https://charitypilot.<your-tailnet>.ts.net
        │                       └── proxies to 127.0.0.1:8080
        └── Docker Engine
              └── Caddy (binds 127.0.0.1:8080 ONLY)
                    ├── /api/v1/*  → Fastify API
                    └── everything else → Next.js
                          └── PostgreSQL + document volume
```

Nothing listens on the VM's network interface. Caddy binds loopback only; the
sole route in is Tailscale Serve, which is restricted to the tailnet. **Funnel
must stay off** — it would publish the server to the open internet.

---

## Host requirements

- Windows 11 24H2+ with Hyper-V enabled (Pro or Enterprise; Home lacks Hyper-V)
- 8 GB RAM and 4 vCPU free for the guest; 80 GB disk
- A Tailscale account, with the Windows host also joined to the tailnet

The guest requirements are unchanged from the Linux profile: Ubuntu 24.04 LTS,
dedicated non-root operator, Node 22, the exact npm from `packageManager`, local
Docker Engine and Compose.

---

## Provisioning the guest

Any standard Ubuntu 24.04 Server install works. Points worth knowing if you
automate it:

- **Ubuntu's autoinstall always stops for confirmation** unless `autoinstall` is
  on the *kernel command line*. A cloud-init NoCloud seed disk delivers the
  configuration but cannot set a kernel argument, so an otherwise-unattended
  build will sit at `Continue with autoinstall? (yes|no)` forever. Either rebuild
  the ISO with the kernel argument, drive the answer with Hyper-V's synthetic
  keyboard, or answer it once by hand.
- **Ubuntu's LVM layout claims only about half the disk.** Reclaim the rest
  before installing anything:
  ```bash
  sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv && sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
  ```
- **Set `AutomaticCheckpointsEnabled = $false`** on the VM. Client Hyper-V enables
  automatic checkpoints by default, which leaves a server permanently running off
  a differencing disk.

---

## Networking: use a stable name, never an IP

Hyper-V's Default Switch is a NAT `/20` whose DHCP leases **change on every VM
reboot**. Anything referencing a bare IP will break the first time the guest
restarts.

Install mDNS in the guest so it has a stable name on the host network:

```bash
sudo apt-get install -y avahi-daemon libnss-mdns
```

The guest is then reachable as `<hostname>.local` from the Windows host
regardless of its current lease.

---

## Tailscale

Join the guest to the tailnet and publish the loopback port over tailnet-only
HTTPS:

```bash
sudo tailscale up --hostname=charitypilot
sudo tailscale serve --bg --https=443 http://127.0.0.1:8080
sudo tailscale serve status     # confirm "(tailnet only)"
```

> **Do not pass `--accept-dns=false`.** MagicDNS must be enabled or the guest
> cannot resolve its own `.ts.net` name, and the installer's final runtime-health
> attestation — which fetches the configured origin — fails with `fetch failed`.
> That failure lands the install in a phase Linux cannot resume (see below).

Confirm HTTPS certificates are available for the tailnet before installing:

```bash
sudo tailscale cert --cert-file /tmp/t.crt --key-file /tmp/t.key charitypilot.<your-tailnet>.ts.net
```

---

## Installing

Configure Serve **before** installing. The origin is written into protected state
at install time and there is no command to change it afterwards.

```bash
bash scripts/Install-CharityPilot.sh \
  --owner-email you@example.org \
  --owner-name "Your Name" \
  --organisation-name "Your Charity" \
  --origin https://charitypilot.<your-tailnet>.ts.net \
  --port 8080
```

A successful run ends with `runtime-health attestation passed`,
`Origin class: tailscale-private-https`, and protected state phase `ready`.

### Verify the install reached `ready`

```bash
grep -o '"phase"[^,]*' ~/.local/share/charitypilot/personal-server/install-state.json
```

This matters more than it looks. **`restore`, `rollback`, `update`,
`decommission` and auth-recovery rotation all refuse to run unless the phase is
`ready`.** An installation stuck in `initialized-backup-pending` can still take
backups but **cannot restore them**, which is close to worthless.

The Linux installer has no `--resume-failed` wrapper, so a part-completed install
cannot be driven forward, and `decommission` refuses because it too requires
`ready`. Recovery from that state means removing the Compose resources directly,
archiving the protected state, and installing again:

```bash
docker compose --project-name charitypilot-personal-server \
  --env-file ~/.local/share/charitypilot/personal-server/.env.personal-server \
  -f compose.personal-server.yml down -v --remove-orphans
mv ~/.local/share/charitypilot/personal-server ~/.local/share/charitypilot/personal-server.archived
mv ~/.local/state/charitypilot ~/.local/state/charitypilot.archived
```

Archive rather than delete — the recovery key in that tree is the only thing that
can decrypt its recovery sets.

---

## Changing the origin later

`--origin` is fixed at install time, but the origin **can** be rebound during a
replacement-host restore, which preserves the Owner account and all data:

```bash
node scripts/personal-server.mjs bootstrap-restore-plan \
  --recovery-set=<path> \
  --source-origin=<old-origin> \
  --origin=<new-origin> \
  --port=<port> \
  --encryption-key-file=<absolute-path>
```

Run the `-plan` variant first. This is the supported route once real records
exist; a fresh install is only appropriate while the database is still empty.

---

## Scheduled backups

Since the blue-green cutover, the nightly backup is
`scripts/bluegreen-nightly-backup.sh`, not the appliance's
`charitypilot-backup.sh`. See `docs/bluegreen-runbook.md`'s "The nightly cron
(private VM)" section for the install command, the crontab entry it writes,
where backups land on the VM, and the off-host copy command (`scp` via the
Windows host, at least weekly and after any deploy).

---

## Deploying a new commit

Since the blue-green cutover this host deploys like any other Docker host:

```bash
# on the VM, as cpops (never sudo)
cd ~/charity-governance && git pull --ff-only
npm run bluegreen:deploy -- --env-file .bluegreen/private-vm.env --detach
npm run bluegreen:status -- --env-file .bluegreen/private-vm.env
```

`docs/bluegreen-runbook.md` is the reference: phases, failure modes, one-command
`bluegreen:rollback`, and the destructive-migration override's cost. There is
no VM teardown and no installer step. The appliance installer remains this
host's worst-case rebuild path only (provision fresh → run the cutover
sequence in the blue-green runbook against a restored backup).

### History: the appliance era

The sections below describe this host's behaviour **before** the blue-green
cutover, and remain accurate for any host still running the appliance
(`compose.personal-server.yml`, no blue-green engine installed).

### Why improvising a deploy breaks restore

A recovery set records its source identity from the **protected installation
state**, not from the working checkout. That record is written at install time,
and only the sanctioned `update` command advances it.

So `git checkout <newer-commit>` leaves protected state pinned to the install
commit while the source moves ahead. `personal:server:restore` then aborts with:

```text
Retained Git rollback source is dirty or no longer at the recorded revision
```

`assertRetainedSourceIdentity` requires `git status --porcelain=v1
--untracked-files=all` to be **empty** and `HEAD` to equal the commit recorded in
protected state. A deployed checkout satisfies neither.

**The failure is invisible until you need it.** After such a deploy the services
are healthy, the runtime-health attestation passes, HTTPS serves normally, and
backups continue to succeed and verify. Nothing indicates a problem. You discover
it at the worst possible moment — when you attempt a restore during an incident.

Note also that the restore does most of its work *before* reaching this check: it
verifies the set, rehearses it in disposable containers, stops writers, writes a
preservation backup and restarts services. Only then does it refuse. The refusal
is safe — no data is altered — but it is late.

### If it has already happened

Re-pin the checkout to the commit recorded in protected state:

```bash
grep -o '"revision"[^,]*' ~/.local/share/charitypilot/personal-server/install-state.json
cd ~/charity-governance
git reset --hard <that-revision>     # must end on master with a clean tree
```

`personal-server-certify.mjs` requires branch `master`, a clean worktree and the
canonical remote — but **not** that `HEAD` equals `origin/master`. So a checkout
pinned behind `origin/master` still passes attestation, and restore works again.

### Recovery sets cannot carry data across a commit change

Read this before planning any deploy, because the obvious idea does not work.

`validateReplacementRestoreSourceBinding` requires the commit sealed into the
recovery set to equal the **restoring installation's** recorded revision:

```js
(expected.kind === 'clean-git' && application.source.commitSha !== expected.commitSha)
  -> 'Replacement-host recovery source does not match the exact authenticated backup source'
```

A set taken at commit A therefore restores only onto an installation recorded at
commit A. Install at commit B and it is refused. There is no `--adopt-source`
flag; the option surface is origin, port, set, key and confirmation only.

**So replacement-restore moves data to a new *host*, not to new *code*.** It is
disaster recovery. It is not a deploy mechanism, and describing it as one — as
an earlier revision of this document did — sends you down a path that ends in a
refusal after you have already built the replacement machine.

---

## Known gaps

Inherited from the profile, and not fixed by running it in a VM:

- Release readiness is tracked in
  [`personal-server-readiness-scorecard.md`](personal-server-readiness-scorecard.md)
  and is **not** at a level that supports production use
- The Linux profile is provisional: failed-install resume and a release updater
  are open work
- No versioned release exists; a clean `master` clone is a supervised test route
- Update and rollback have not been executed and accepted on this profile

Three gates **have** been demonstrated on this arrangement:

- **Reboot survival.** With `restart=unless-stopped` on the Compose services,
  Docker enabled at boot and the VM set to auto-start, the full stack returns
  healthy after guest and host restarts with no intervention.
- **Guarded restore on the current host.** Tested against real data: a known
  value was altered in the live database, then `personal:server:restore` was run
  against a prior recovery set. The set was verified, rehearsed in disposable
  containers, the current state preserved to a new set, and the altered value
  correctly reverted. `lastRestore` was recorded and the phase returned to
  `ready`. Backups taken by this profile are genuinely restorable.
- **Off-host and replacement-host recovery.** Rehearsed end to end on a
  disposable VM: install, seed with marker records, back up, copy the recovery
  set and key off-host, then **destroy the host completely** — VM, virtual
  disks, SSH key, console password and the on-host recovery key — rebuild a bare
  machine and restore onto it with `Install-CharityPilot.sh
  --restore-recovery-set`. The marker fingerprint returned byte-identical, the
  supplied recovery key was adopted rather than replaced, `restoreOperation`
  cleared, phase reached `ready` and all four services came up healthy.

  Two defects had to be fixed first, and anyone running an older checkout still
  has them: the Linux installer had no replacement-restore mode at all, and
  `bootstrap-restore` asserted its Docker networks were absent immediately after
  `compose run` had created them — so replacement-host restore could not
  complete **on any platform**, Windows included.

  Two rules the rehearsal established, both by failing first:

  1. **Run the whole sequence at one commit.** Restore refuses a recovery set
     whose recorded source differs from the restoring code, and refuses a
     checkout that has moved off the recorded revision. Both guards are correct.
     Do not patch a host mid-restore — rebuild and start again at the new commit.
  2. **Bootstrap and install in separate SSH sessions.** Bootstrap adds the
     operator to the `docker` group, which the session that ran it does not yet
     have. Installing in that same session produces Docker preflight failures
     that look serious and mean nothing.

Keep `recovery-key.hex` off the host, separate from the recovery sets it
protects. Losing it makes every recovery set permanently unrestorable.
