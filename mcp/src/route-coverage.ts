/**
 * Readable API routes the connector deliberately does not expose, each with
 * the reason it is left out.
 *
 * This exists so that "the connector cannot answer that" is always a decision
 * somebody made and wrote down, rather than a route nobody noticed. The test
 * beside it requires every GET route the API registers to be either a tool or
 * an entry here, so a route added later forces the choice to be made again.
 */
export interface ExcludedRoute {
  path: string;
  reason: string;
  /**
   * True when the route is not registered in its group's `index.ts` — either it
   * lives in a sibling file, or it is registered only under some deployment
   * profiles. The coverage test cannot discover these, so it does not treat
   * them as stale when they go unmatched.
   */
  notInGroupIndex?: boolean;
}

export const EXCLUDED_ROUTES: readonly ExcludedRoute[] = [
  {
    path: '/api/v1/documents/:id/download',
    reason:
      'Returns the raw bytes of a stored document. No field filter is meaningful against a '
      + 'file, and the contents are exactly what the personal-data gate exists to hold back. '
      + 'Served by the document_download file tool rather than an ordinary read tool: it '
      + 'writes the bytes to a directory the operator named and returns the path, never the '
      + 'contents. It is absent entirely unless that directory was given.',
  },
  {
    path: '/api/v1/export/compliance-record',
    reason:
      'Returns HTML, not JSON, and is the widest payload in the API: the whole organisation '
      + 'profile, every standard and record, and on the Complete plan all six registers '
      + 'including the trustee named against each conflict.',
  },
  {
    path: '/api/v1/export/compliance-report',
    reason:
      'The same handler and the same payload as the compliance-record export. Served by the '
      + 'report_export file tool rather than an ordinary read tool: it writes the report to a '
      + 'directory the operator named and returns the path, never the HTML. It is absent '
      + 'entirely unless that directory was given.',
  },
  {
    path: '/api/v1/auth/approvals',
    reason:
      'The destructive actions waiting for the signed-in person to approve, for the page in '
      + 'the web application that grants them. The whole approval surface is kept away from '
      + 'tools: an agent that could read and grant its own pending approvals would make the '
      + 'control meaningless. The connector reads the one approval it was handed through its '
      + 'own command, not through a tool.',
  },
  {
    path: '/api/v1/auth/connector/approvals/:id',
    reason:
      'Describes one approval so `charitypilot-mcp approve` can show a person what they are '
      + 'about to approve before asking for their password. Driven by that command, never by '
      + 'a tool.',
    notInGroupIndex: true,
  },
  {
    path: '/api/v1/auth/me',
    reason:
      'Identifies the signed-in person. Served by the session_info tool, which returns the '
      + 'charity, role and level always and the person\'s name and email only when the '
      + 'personal-data gate is open, rather than by a tool of its own.',
  },
  {
    path: '/api/v1/documents/storage-deletions/dead-letter',
    reason:
      'An operational failure queue whose error text is raw provider output and can embed '
      + 'storage paths, which encode original filenames.',
  },
  {
    path: '/api/v1/integrations/confluence/authorize',
    reason:
      'Returns a URL carrying a signed OAuth state. It is a capability that begins granting '
      + 'an external site access, not data about the charity.',
  },
  {
    path: '/api/v1/integrations/confluence/callback',
    reason: 'A retired endpoint that always answers 410. It carries no payload.',
  },
  {
    path: '/api/v1/integrations/confluence/spaces',
    reason:
      'Live Atlassian data rather than charity governance data, and it needs a connected '
      + 'integration to answer at all.',
  },
  {
    path: '/api/v1/health',
    reason: 'A liveness probe. It answers nothing about the charity and advertises the deployment.',
  },
  {
    path: '/api/v1/health/readiness',
    reason:
      'Requires an internal operations key and reports infrastructure posture, including '
      + 'which providers are configured and the build commit.',
  },
  {
    path: '/api/v1/health/e2e-database-identity',
    reason:
      'A test-harness probe reporting database role and privilege flags. It exists to stop a '
      + 'destructive reset running against the wrong database.',
  },
  {
    path: '/api/v1/risks',
    reason:
      'A signpost that always answers 404, pointing at the registers route. The risk register '
      + 'is exposed as risks_list.',
    notInGroupIndex: true,
  },
  {
    path: '/api/v1/owner/auth/me',
    reason:
      'The browser console’s own identity route, reached with a cookie. The operator '
      + 'connector asks /api/v1/owner/auth/connector/session instead, which reports the '
      + 'session posture the cookie route knows nothing about, and is what session_info '
      + 'calls in the operator realm.',
    notInGroupIndex: true,
  },
];
