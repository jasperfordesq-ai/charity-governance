import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireProductionCutoverLock,
  assertProductionCutoverLock,
  releaseProductionCutoverLock,
} from "./production-cutover-lock.mjs";

test("production cutover lock is exclusive, reentrant only by handle, and reusable after release", () => {
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-cutover-lock-test-"),
  );
  const lockPath = join(tempDir, "cutover.lock");
  try {
    const lock = acquireProductionCutoverLock({
      lockPath,
      pid: 4242,
      now: () => new Date("2026-07-10T20:00:00.000Z"),
    });
    assert.doesNotThrow(() => assertProductionCutoverLock(lock));
    assert.throws(
      () => acquireProductionCutoverLock({ lockPath, pid: 4343 }),
      /production cutover lock is already held by process 4242/,
    );
    assert.throws(
      () => assertProductionCutoverLock({ lockPath }),
      /valid production cutover lock/,
    );
    releaseProductionCutoverLock(lock);

    const nextLock = acquireProductionCutoverLock({ lockPath, pid: 4343 });
    releaseProductionCutoverLock(nextLock);

    const changedLock = acquireProductionCutoverLock({
      lockPath,
      pid: 4444,
      token: "owned-token",
    });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 4555, token: "replacement-token" }),
    );
    assert.throws(
      () => assertProductionCutoverLock(changedLock),
      /production cutover lock ownership changed while the cutover was running/,
    );
    assert.throws(
      () => releaseProductionCutoverLock(changedLock),
      /production cutover lock ownership changed while the cutover was running/,
    );

    rmSync(lockPath, { force: true });
    assert.throws(
      () => assertProductionCutoverLock(changedLock),
      /production cutover lock disappeared or became unreadable while the cutover was running/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
