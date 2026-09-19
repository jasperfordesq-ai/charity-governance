import crypto from "node:crypto";

/**
 * A fingerprint of one request, used to bind an approval to the action it
 * approves.
 *
 * The digest covers the session, the method, the path and the body. Change any
 * of them and the approval no longer matches, so approving the deletion of one
 * record cannot be spent deleting another, and an approval granted for one
 * connector session is useless to a second one running beside it.
 *
 * The body is canonicalised first. Two requests that differ only in the order
 * their fields were serialised are the same request, and a digest that said
 * otherwise would make the flow fail at random depending on how a client's JSON
 * library happened to order its keys.
 */
export interface ActionRequest {
  sessionId: string;
  method: string;
  path: string;
  body: unknown;
}

/**
 * Canonical JSON: object keys sorted, arrays left in order.
 *
 * Array order is meaningful — a list of trustees in a different order is a
 * different list — so only objects are reordered.
 */
export function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    // An explicit undefined and an absent key are the same thing in JSON, and
    // treating them differently would make the digest depend on how the body
    // was built rather than on what it says.
    if (source[key] === undefined) continue;
    out[key] = canonicalise(source[key]);
  }
  return out;
}

/** The path without its query string, which is not part of the action. */
function pathOf(path: string): string {
  return path.split("?")[0] ?? path;
}

export function digestAction(request: ActionRequest): string {
  // An absent body and an empty body are the same request. A client sending
  // `{}` and one sending nothing at all are asking for the same thing.
  const body =
    request.body === undefined || request.body === null ? {} : request.body;

  const material = JSON.stringify([
    request.sessionId,
    request.method.toUpperCase(),
    pathOf(request.path),
    canonicalise(body),
  ]);

  return crypto.createHash("sha256").update(material).digest("hex");
}
