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
    path: '/api/v1/documents/deleted',
    reason: 'Deleted-item review is restricted to human Owner/Admin browser sessions; trashed records must not reappear through connector reads.',
  },
  {
    path: '/api/v1/documents/policy-revisions',
    reason: 'Retention proposals and approval evidence require human review in the policy dashboard.',
  },
  {
    path: '/api/v1/documents/recovery-policies',
    reason: 'Selecting an approved recovery policy is part of the human removal workflow, not a connector capability.',
  },
  {
    path: '/api/v1/documents/purge-authorizations',
    reason: 'Reviewed disposal plans and authority history belong in the browser-only administration workflow.',
    notInGroupIndex: true,
  },
  {
    path: '/api/v1/documents/purge-authorizations/:id/dispositions',
    reason: 'Scoped disposal observations and controlled evidence are reviewed in the browser dashboard, not disclosed through the connector.',
    notInGroupIndex: true,
  },
  {
    path: '/api/v1/auth/second-factor',
    reason: 'Personal account authenticator status belongs in the signed-in human dashboard.',
    notInGroupIndex: true,
  },
  {
    path: '/api/v1/governance-audit/:feed',
    reason: 'Admin-only paged application audit archive contains controlled historical records and belongs in the Governance Audit dashboard.',
  },
  {
    path: '/api/v1/organisation/audit',
    reason: 'Admin-only organisation profile edit history, including actor identifiers, belongs in the Governance Audit dashboard.',
  },
  {
    path: '/api/v1/deadlines/audit',
    reason: 'Admin-only deadline action history belongs in Governance Audit rather than a general connector answer.',
  },
  {
    path: '/api/v1/team/replay-diagnostics',
    reason: 'Restricted security-log correlation data for a human incident review. Request IDs and session-family fingerprints stay in the Owner/Admin dashboard.',
  },
  {
    path: '/api/v1/data-lifecycle/requests',
    reason: 'Admin-only erasure and retention case queue. Its opaque references and assessment state require a controlled human review surface.',
  },
  {
    path: '/api/v1/data-lifecycle/requests/by-reference',
    reason: 'Exact lookup of a controlled case by its archive reference belongs in the Admin dashboard.',
  },
  {
    path: '/api/v1/data-lifecycle/requests/due-targets',
    reason: 'Admin-only response-target queue for controlled data-rights cases; it requires a human to review the correspondence and recorded target before acting.',
  },
  {
    path: '/api/v1/data-lifecycle/audit',
    reason: 'Admin-only recent data-request review history belongs in Governance Audit, not connector disclosure.',
  },
  {
    path: '/api/v1/data-lifecycle/storage-deletions/by-source',
    reason: 'Source-document to deletion-job matching requires controlled human case review, not connector disclosure.',
  },
  {
    path: '/api/v1/data-lifecycle/requests/:id',
    reason: 'One controlled data-lifecycle case; not a general governance fact for connector disclosure.',
  },
  {
    path: '/api/v1/data-lifecycle/requests/:id/events',
    reason: 'Append-only case assessment reasons and evidence references remain in the Admin review surface.',
  },
  {
    path: '/api/v1/data-lifecycle/requests/:id/target-events',
    reason: 'Append-only response-target changes include controlled evidence references and reasons for a specific data-rights case; review them in the Admin dashboard.',
  },
  {
    path: '/api/v1/data-lifecycle/requests/:id/response-events',
    reason: 'Recorded response dates and controlled correspondence references require human review in the restricted data-rights case.',
  },
  {
    path: '/api/v1/data-lifecycle/requests/:id/coverage',
    reason: 'Latest case-specific source-area assessments belong in the restricted Admin review surface, not connector disclosure.',
  },
  {
    path: '/api/v1/data-lifecycle/requests/:id/coverage-events',
    reason: 'Append-only source-area assessment reasons and controlled archive references belong in the restricted Admin case history.',
  },
  {
    path: '/api/v1/data-lifecycle/requests/:id/storage-links',
    reason: 'A case-specific association with storage deletion jobs and their current status requires human evidence review.',
  },
  {
    path: '/api/v1/data-lifecycle/requests/:id/document-links',
    reason: 'A case-specific association with a Vault record and its review reason belongs in the controlled Admin dashboard.',
  },
  {
    path: '/api/v1/governing-acts/audit',
    reason: 'Admin-only Minute Book before/after snapshots can contain names and full resolution text. Review them in the Governance Audit dashboard.',
  },
  {
    path: '/api/v1/compliance/audit',
    reason: 'Admin-only before/after compliance history may contain unrestricted narrative and personal data. Review it in the Governance Audit dashboard.',
  },
  {
    path: '/api/v1/documents/confluence-mirrors',
    reason: 'Admin-only publication metadata includes external page identifiers and target information; the connector exposes only the authorised document record.',
  },
  {
    path: '/api/v1/documents/control-audit',
    reason: 'Admin-only visibility, lifecycle and publication decision history, including free-text reasons. Review it in the Governance Audit dashboard.',
  },
  {
    path: '/api/v1/documents/replacement-candidates/:id',
    reason: 'Admin-only search for a current successor within one document category; it is part of the interactive lifecycle decision, not a general connector read.',
  },
  {
    path: '/api/v1/documents/storage-deletions/history',
    reason: 'Admin-only operational deletion metadata. It belongs in the Governance Audit dashboard rather than a general connector answer.',
  },
  {
    path: '/api/v1/governance-registers/risks/audit',
    reason: 'Admin-only full before/after risk snapshots may contain personal narratives. Review them in the Governance Audit dashboard.',
  },
  {
    path: '/api/v1/governance-registers/complaints/:id/resolution-evidence',
    reason: 'Complaint resolution references and review history require a human administrator in the dashboard.',
  },
  {
    path: '/api/v1/governance-registers/change-audit',
    reason: 'Admin-only register action history belongs in the governed dashboard, not a general connector read.',
  },
  {
    path: '/api/v1/governance-registers/risks/control-verifications',
    reason: 'Admin-only control evidence references and withdrawal reasons require the governed Registers review screen.',
  },
  {
    path: '/api/v1/governance-registers/risks/control-review-attention',
    reason: 'Admin-only review attention can reveal control references and belongs in the governed Registers review screen.',
  },
  {
    path: '/api/v1/governance-registers/risks/:id/control-verifications',
    reason: 'Risk-specific Admin control history may include sensitive evidence references and belongs in the governed Registers review screen.',
  },
  {
    path: '/api/v1/integrations/confluence/references/:documentId',
    reason: 'Admin-only external reference metadata can reveal third-party page targets and is managed in the Vault and Integrations dashboard.',
  },
  {
    path: '/api/v1/integrations/confluence/copy-inventory',
    reason: 'Admin-only inventory joins recorded external page references with current Vault lifecycle and publication decisions for human audience review in Integrations.',
  },
  {
    path: '/api/v1/integrations/confluence/reference-inventory',
    reason: 'Admin-only inventory of charity-managed cited pages and linked Vault records for human evidence and audience review, distinct from CharityPilot-published copies.',
  },
  {
    path: '/api/v1/documents/:id/download',
    reason:
      'Returns the raw bytes of a stored document. No field filter is meaningful against a '
      + 'file, and the contents are exactly what the personal-data gate exists to hold back. '
      + 'Served by the document_download file tool rather than an ordinary read tool: it '
      + 'writes the bytes to a directory the operator named and returns the path, never the '
      + 'contents. It requires both that directory and a full personal-data session.',
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
      + 'entirely unless that directory and a full personal-data session were given.',
  },
  {
    path: '/api/v1/auth/approvals',
    reason:
      'The destructive actions waiting for the signed-in person to approve, for the page in '
      + 'the web application that grants them. The whole approval surface is kept away from '
      + 'tools: an agent that could read and grant its own pending approvals would make the '
      + 'control meaningless. The connector reads the one approval it was handed through its '
      + 'own command, not through a tool. Both browser and connector approval routes require '
      + 'the account to still be Owner or Admin after a role change.',
  },
  {
    path: '/api/v1/auth/connector/approvals/:id',
    reason:
      'Describes one approval so `charitypilot-mcp approve` can show a person what they are '
      + 'about to approve before asking for their password. Driven by that command, never by '
      + 'a tool, and denied after the account loses its Owner/Admin role.',
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
