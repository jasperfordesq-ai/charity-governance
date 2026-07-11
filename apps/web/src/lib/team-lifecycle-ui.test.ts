import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Concern: security-governance UI wiring. The API and shared schemas prove the
// authorization and request contracts independently; these source checks ensure the
// Team page keeps every high-risk control connected to that contract.

const WEB = process.cwd();
const team = (file: string) =>
  readFileSync(join(WEB, 'src', 'app', '(dashboard)', 'team', file), 'utf8');

test('team lifecycle mutations send an immutable reason and optimistic membership version', () => {
  const page = team('page.tsx');
  const helpers = team('team-page-helpers.ts');

  assert.match(helpers, /kind: 'suspend' \| 'reactivate' \| 'remove' \| 'transfer'/);
  assert.match(
    page,
    /api\.post\(`\/team\/members\/\$\{governanceAction\.member\.id\}\/\$\{governanceAction\.kind\}`/,
  );
  assert.match(page, /expectedMembershipVersion: governanceAction\.member\.membershipVersion/);
  assert.match(page, /reason: normalizeTeamGovernanceReason\(governanceReason\)/);

  assert.match(page, /api\.patch\(`\/team\/members\/\$\{governanceAction\.member\.id\}\/role`/);
  assert.match(page, /role: governanceAction\.nextRole/);
});

test('ownership transfer is version-guarded, explicitly confirmed, and ends the owner session', () => {
  const page = team('page.tsx');
  const helpers = team('team-page-helpers.ts');

  assert.match(page, /api\.post\('\/team\/ownership\/transfer'/);
  assert.match(page, /expectedCurrentOwnerVersion: currentOwner\.membershipVersion/);
  assert.match(page, /expectedTargetVersion: governanceAction\.member\.membershipVersion/);
  assert.match(page, /confirmation: governanceConfirmation/);
  assert.match(page, /expectedConfirmation=.*'TRANSFER OWNERSHIP'/);
  assert.match(page, /redirectAfterServerRevocation\(\)/);
  assert.match(helpers, /window\.location\.replace\('\/login'\)/);
  assert.doesNotMatch(page, /await logout\(\)/);
});

test('session inventory and revocation controls cover one family, all families, and self-revocation', () => {
  const sessionsWorkflow = team('use-team-sessions.ts');
  const modal = team('team-sessions-modal.tsx');

  assert.match(sessionsWorkflow, /api\.get<TeamSessionResponse\[\]>\(`\/team\/members\/\$\{member\.id\}\/sessions`/);
  assert.match(
    sessionsWorkflow,
    /api\.post<\{ revokedCurrentSession: boolean \}>\(`\/team\/members\/\$\{sessionsMember\.id\}\/sessions\/\$\{familyId\}\/revoke`/,
  );
  assert.match(sessionsWorkflow, /api\.post\(`\/team\/members\/\$\{sessionsMember\.id\}\/sessions\/revoke-all`/);
  assert.match(sessionsWorkflow, /if \(data\.revokedCurrentSession\)/);
  assert.match(sessionsWorkflow, /if \(sessionsMember\.id === currentUserId\)/);
  assert.match(sessionsWorkflow, /requestId !== sessionsRequestId\.current/);
  assert.match(modal, /Current session/);
  assert.match(modal, /Revoke all active sessions/);
  assert.match(modal, /session\.displaySuffix/);
  assert.match(modal, /formatDateTime/);
  assert.match(modal, /aria-label=\{`Revoke session/);

  // Internal identifiers may route a revocation but are never rendered as device secrets.
  assert.doesNotMatch(modal, /\{session\.latestSessionId\}/);
  assert.doesNotMatch(modal, />\s*\{session\.familyId\}/);
  assert.doesNotMatch(modal, /refreshToken|accessToken/);
});

test('administrators receive the immutable audit view while ordinary members do not', () => {
  const page = team('page.tsx');
  const panel = team('team-security-audit-panel.tsx');

  assert.match(page, /api\.get<SecurityAuditEventResponse\[\]>\('\/team\/security-audit'\)/);
  assert.match(page, /effectiveRole === UserRole\.OWNER \|\| effectiveRole === UserRole\.ADMIN/);
  assert.match(page, /<TeamSecurityAuditPanel/);
  assert.match(panel, /Immutable evidence/);
  assert.match(panel, /Affected: \{event\.subjectLabel\}/);
  assert.doesNotMatch(panel, /events\.slice/);
  assert.match(panel, /Security audit could not be loaded/);
  assert.match(panel, /onPress=\{onRetry\}/);
});

test('governance reason controls use the shared normalized multiline contract with field errors', () => {
  for (const file of ['team-reason-modal.tsx', 'team-sessions-modal.tsx']) {
    const source = team(file);
    assert.match(source, /teamGovernanceReasonSchema\.safeParse\(reason\)/);
    assert.match(source, /isInvalid=/);
    assert.match(source, /errorMessage=/);
    assert.match(source, /line breaks are allowed/);
    assert.match(source, /maxLength=\{500\}/);
  }
});

test('team refreshes are monotonic, failures clear stale rows, and conflicts force reconciliation', () => {
  const page = team('page.tsx');
  const sessionsWorkflow = team('use-team-sessions.ts');

  assert.match(page, /const requestId = \+\+teamRequestId\.current/);
  assert.match(page, /requestId !== teamRequestId\.current/);
  assert.match(page, /setTeam\(null\)/);
  assert.match(page, /setTeamUnavailable\(true\)/);
  assert.match(page, /managementDisabled=\{managementDisabled\}/);
  assert.match(page, /apiErrorCode\(err\) === 'MEMBERSHIP_VERSION_CONFLICT'/);
  assert.match(page, /const refreshed = await fetchTeam\(\)/);
  assert.match(page, /setGovernanceAction\(null\)/);
  assert.match(sessionsWorkflow, /setSessionsMember\(null\)/);
  assert.match(page, /resolveCanonicalTeamRole\(user\?\.id, team\?\.members\)/);
  assert.match(page, /const permissionUser = user && effectiveRole/);
  assert.doesNotMatch(page, /canInviteMembers\(user\?\.role\)/);
});

test('administrative metadata and repeated actions are role-minimized and accessibly named', () => {
  const page = team('page.tsx');
  const members = team('team-members-panel.tsx');
  const invites = team('team-invites-panel.tsx');
  const sessions = team('team-sessions-modal.tsx');

  assert.match(page, /\{canInvite \? <TeamInvitesPanel/);
  assert.match(members, /member\.activeSessionCount !== undefined/);
  assert.match(members, /aria-label=\{`Manage sessions for/);
  assert.match(members, /aria-label=\{`Suspend/);
  assert.match(members, /aria-label=\{`Remove/);
  assert.match(members, /aria-label=\{`Transfer ownership to/);
  assert.match(invites, /aria-label=\{`Revoke invitation for/);
  assert.match(sessions, /aria-label=\{`Revoke all active sessions for/);
});

test('a failed session inventory never masquerades as an empty history', () => {
  const sessionsWorkflow = team('use-team-sessions.ts');
  const modal = team('team-sessions-modal.tsx');
  assert.match(sessionsWorkflow, /setSessions\(\[\]\);\s*setSessionError/);
  assert.match(modal, /\{error \? null : loading \?/);
  assert.match(modal, /isDisabled=\{accessDisabled \|\| Boolean\(error\) \|\| !validReason/);
});

test('the Team route stays within the platform page-size quality gate', () => {
  const page = team('page.tsx');
  assert.ok(page.split(/\r?\n/).length <= 449, 'Team page must stay at or below 449 lines');
  assert.match(page, /useTeamSessions\(\{/);
});

test('open privileged modals invalidate stale canonical authority and disable during refresh', () => {
  const page = team('page.tsx');
  const sessionsWorkflow = team('use-team-sessions.ts');
  const reasonModal = team('team-reason-modal.tsx');
  const sessionsModal = team('team-sessions-modal.tsx');

  assert.match(page, /governanceActorRole === effectiveRole/);
  assert.match(page, /isCurrentGovernanceActionAuthorized\(/);
  assert.match(page, /if \(!governanceAction \|\| governanceAccessValid\) return;[\s\S]*setGovernanceAction\(null\)/);
  assert.match(page, /if \(!governanceAction \|\| loading \|\| !governanceAccessValid\)/);
  assert.match(page, /accessDisabled=\{loading \|\| !governanceAccessValid\}/);

  assert.match(sessionsWorkflow, /actorRole === sessionActorRole/);
  assert.match(sessionsWorkflow, /isCurrentSessionTargetAuthorized\(/);
  assert.match(sessionsWorkflow, /if \(!sessionsMember \|\| sessionAccessValid\) return;[\s\S]*invalidateSessions\(\)/);
  assert.match(sessionsWorkflow, /const sessionAccessDisabled = accessRefreshing \|\| !sessionAccessValid/);
  assert.match(reasonModal, /isDisabled=\{!valid \|\| saving \|\| accessDisabled\}/);
  assert.match(sessionsModal, /isDisabled=\{accessDisabled \|\| Boolean\(error\)/);
});

test('role guidance describes Member access as read-only', () => {
  const display = team('team-display.ts');
  const guidance = team('team-role-guidance-panel.tsx');

  assert.match(display, /Can view governance records, deadlines, registers, and available documents, but cannot change them/);
  assert.doesNotMatch(display, /Member'[\s\S]{0,160}maintain compliance records/);
  assert.match(guidance, /Members have read-only access/);
});
