function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * The cursor from `_links.next`, or `undefined` when this is the last page.
 *
 * Confluence sends `next` as a path with a query string. Only the `cursor`
 * parameter is taken from it: re-issuing the URL wholesale would let an
 * upstream response choose the path this client requests next, which is not a
 * decision a response body gets to make.
 */
function cursorFromNextUrl(next: string, invalidResponse: (what: string) => Error): string {
  try {
    // The base is a placeholder; only the query is read from the result.
    const cursors = new URL(next, 'https://confluence.invalid').searchParams.getAll('cursor');
    if (cursors.length === 1 && cursors[0]!.length > 0) return cursors[0]!;
  } catch {
    // The caller will reject this as an incomplete inventory.
  }
  throw invalidResponse('attachment pagination cursor');
}

export function readConfluenceInventoryCursor(body: unknown, linkHeader: string | undefined, invalidResponse: (what: string) => Error): string | undefined {
  const bodyNext = asObject(asObject(body)?._links)?.next;
  if (bodyNext !== undefined && bodyNext !== null && (typeof bodyNext !== 'string' || bodyNext.length === 0)) {
    throw invalidResponse('attachment pagination link');
  }
  const bodyCursor = typeof bodyNext === 'string' ? cursorFromNextUrl(bodyNext, invalidResponse) : undefined;

  const linkMatches = linkHeader === undefined
    ? []
    : Array.from(linkHeader.matchAll(/<([^>]+)>\s*;\s*rel\s*=\s*(?:"next"|next)(?=\s*[,;]|\s*$)/gi));
  if (linkMatches.length > 1 || (linkMatches.length === 0 && /\brel\s*=\s*"?next\b/i.test(linkHeader ?? ''))) {
    throw invalidResponse('unambiguous attachment pagination header');
  }
  const headerCursor = linkMatches[0]?.[1] === undefined
    ? undefined
    : cursorFromNextUrl(linkMatches[0][1], invalidResponse);
  if (bodyCursor !== undefined && headerCursor !== undefined && bodyCursor !== headerCursor) {
    throw invalidResponse('matching attachment pagination cursors');
  }
  return bodyCursor ?? headerCursor;
}
