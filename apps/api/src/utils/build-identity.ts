import { createRequire } from "node:module";

/**
 * Which build of the API this is.
 *
 * It exists so the connector can say something useful when it is newer than
 * the API it is talking to. A connector built against a route that has not
 * been deployed yet fails with a 404 and no explanation; knowing both
 * versions turns that into a sentence a person can act on.
 *
 * Told only to a caller holding a verifiable token. A build identifier is not
 * a secret, but it is a free hint to anyone scanning for a version with a
 * known hole, and there is no reason to hand it to them.
 */
export interface BuildIdentity {
  /** The API package's version, as published. */
  version: string | null;
  /** Whatever the deploy stamped, usually a commit. Null when nothing did. */
  revision: string | null;
}

function packageVersion(): string | null {
  try {
    // Resolved relative to this module, which sits two levels below the
    // package root in both `src/utils` and `dist/utils`, so the same
    // specifier works whether this is running compiled or through tsx.
    const read = createRequire(import.meta.url);
    const manifest = read("../../package.json") as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    // A packaging arrangement that moved the manifest is not worth failing a
    // health check over. The connector treats a null as "this build cannot
    // say", which is what it would have assumed before this existed.
    return null;
  }
}

/**
 * Read once. The answer cannot change while the process is running, and a
 * health route is the last place to do filesystem work per request.
 */
const IDENTITY: BuildIdentity = {
  version: packageVersion(),
  revision: process.env.CHARITYPILOT_BUILD_REVISION?.trim() || null,
};

export function buildIdentity(): BuildIdentity {
  return IDENTITY;
}

/**
 * Whether `left` is a later release than `right`, by the three numbers.
 *
 * Deliberately not a semver library: these two versions are released from one
 * repository and only ever differ in those numbers, and the connector's whole
 * dependency budget is two packages.
 *
 * Anything that is not three numbers compares as equal, so an unparseable
 * version produces no warning rather than a wrong one.
 */
export function isNewerRelease(left: string | null, right: string | null): boolean {
  const parse = (value: string | null): [number, number, number] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value ?? "");
    return match
      ? [Number(match[1]), Number(match[2]), Number(match[3])]
      : null;
  };

  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return false;

  for (let index = 0; index < 3; index += 1) {
    if (a[index]! > b[index]!) return true;
    if (a[index]! < b[index]!) return false;
  }
  return false;
}
