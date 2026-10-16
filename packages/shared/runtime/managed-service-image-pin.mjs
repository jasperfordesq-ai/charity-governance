import {
  constants,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  realpathSync,
} from "node:fs";
import { readBoundedRegularDescriptor } from "./protected-tls-material.mjs";
const refused = () => new Error("Managed service image pin refused");
export function parseManagedServiceImagePin(raw, requireEnabled = false) {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 512)
      throw refused();
    const p = JSON.parse(raw);
    if (
      p.format !== 1 ||
      JSON.stringify({
        format: 1,
        sourceSha: p.sourceSha,
        bindingSha256: p.bindingSha256,
      }) +
        "\n" !==
        raw
    )
      throw refused();
    if (p.sourceSha === null && p.bindingSha256 === null) {
      if (requireEnabled) throw refused();
      return null;
    }
    if (
      typeof p.sourceSha !== "string" ||
      !/^[a-f0-9]{40}$/.test(p.sourceSha) ||
      typeof p.bindingSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(p.bindingSha256)
    )
      throw refused();
    return Object.freeze(p);
  } catch {
    throw refused();
  }
}
export function readManagedServiceImagePin(service, requireEnabled = false) {
  if (!["api", "web"].includes(service)) throw refused();
  if (process.platform !== "linux") {
    if (requireEnabled) throw refused();
    return null;
  }
  const path = "/opt/charitypilot/managed-" + service + "-build.json";
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT" && !requireEnabled) return null;
    throw refused();
  }
  try {
    if (process.getuid() === 0 || realpathSync(path) !== path) throw refused();
    const parent = lstatSync("/opt/charitypilot");
    if (
      !parent.isDirectory() ||
      parent.uid !== 0 ||
      (parent.mode & 0o022) !== 0
    )
      throw refused();
    const fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(fd);
      if (stat.uid !== 0 || (stat.mode & 0o777) !== 0o444) throw refused();
      return parseManagedServiceImagePin(
        readBoundedRegularDescriptor(fd, 512),
        requireEnabled,
      );
    } finally {
      closeSync(fd);
    }
  } catch {
    throw refused();
  }
}
