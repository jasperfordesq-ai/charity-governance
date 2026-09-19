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
      + 'Downloads are a later phase, behind an explicit directory the operator names.',
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
    reason: 'The same handler and the same payload as the compliance-record export.',
  },
  {
    path: '/api/v1/auth/me',
    reason:
      'Identifies the signed-in person. The connector already reports that through its own '
      + 'status command, where a human reads it, rather than handing it to a model.',
  },
  {
    path: '/api/v1/billing/status',
    reason:
      'Billing authority rather than governance: it reports whether a checkout or a billing '
      + 'portal may be opened, which is the first half of spending money.',
  },
  {
    path: '/api/v1/team/security-audit',
    reason:
      'Every row names a person and carries an operator-written reason for suspending or '
      + 'removing them. Exposing it is a deliberate decision, not a default.',
  },
  {
    path: '/api/v1/team/members/:id/sessions',
    reason:
      'Device labels and sign-in times for a named colleague. Useful for security review in '
      + 'the app, surveillance-shaped in the hands of a model.',
  },
  {
    path: '/api/v1/deadlines/reminder-history',
    reason:
      'Carries the email address each reminder was sent to, plus delivery and error text. '
      + 'The deadlines themselves are available without it.',
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
      'The platform operator realm, which is a separate credential and not a tenant login. It '
      + 'is reached with a different token and is out of scope for a charity-facing connector.',
    notInGroupIndex: true,
  },
  {
    path: '/api/v1/owner/tenants',
    reason:
      'Lists every charity on the platform. These are the only deliberately unscoped reads in '
      + 'the codebase, and a connector that can reach them is no longer single-tenant.',
    notInGroupIndex: true,
  },
  {
    path: '/api/v1/owner/tenants/:id',
    reason: 'One charity from the cross-tenant listing, with the same reasoning.',
    notInGroupIndex: true,
  },
];
