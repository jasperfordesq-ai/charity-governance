import {
  closeSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DEFAULT_LOCK_PATH = join(
  tmpdir(),
  "charitypilot-production-cutover.lock",
);
const lockBrand = Symbol("charitypilot-production-cutover-lock");

export function acquireProductionCutoverLock({
  lockPath = DEFAULT_LOCK_PATH,
  pid = process.pid,
  now = () => new Date(),
  token = randomUUID(),
} = {}) {
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
    created = true;
    writeFileSync(
      descriptor,
      JSON.stringify({ pid, acquiredAt: now().toISOString(), token }),
      { encoding: "utf8" },
    );
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The original acquisition error remains authoritative.
      }
    }
    if (created) rmSync(lockPath, { force: true });
    if (error?.code === "EEXIST") {
      let owner = "another deploy or rollback process";
      try {
        const existing = JSON.parse(readFileSync(lockPath, "utf8"));
        if (Number.isSafeInteger(existing?.pid))
          owner = `process ${existing.pid}`;
      } catch {
        // A malformed or unreadable lock remains a fail-closed contention signal.
      }
      throw new Error(
        `production cutover lock is already held by ${owner}; do not delete it until the operator has proved no deploy or rollback is running`,
      );
    }
    throw new Error(
      "could not acquire the production cutover lock before deployment",
    );
  }

  return { [lockBrand]: true, lockPath, token };
}

export function assertProductionCutoverLock(lock) {
  if (!lock || lock[lockBrand] !== true) {
    throw new Error("a valid production cutover lock is required");
  }

  let persisted;
  try {
    persisted = JSON.parse(readFileSync(lock.lockPath, "utf8"));
  } catch {
    throw new Error(
      "production cutover lock disappeared or became unreadable while the cutover was running",
    );
  }
  if (persisted?.token !== lock.token) {
    throw new Error(
      "production cutover lock ownership changed while the cutover was running",
    );
  }
}

export function releaseProductionCutoverLock(lock) {
  assertProductionCutoverLock(lock);
  rmSync(lock.lockPath, { force: true });
}
