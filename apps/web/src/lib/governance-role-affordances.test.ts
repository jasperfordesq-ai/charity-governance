import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dashboard = (...parts: string[]) =>
  readFileSync(join(process.cwd(), 'src', 'app', '(dashboard)', ...parts), 'utf8')
    .replace(/\r\n/g, '\n');

test('Board hides member mutations and reconciles a stale role without leaving the route', () => {
  const page = dashboard('board', 'page.tsx');
  const workflow = dashboard('board', 'use-board-workflow.ts');
  const list = dashboard('board', 'board-member-list-panel.tsx');
  const modal = dashboard('board', 'board-member-modal.tsx');

  assert.match(workflow, /canManageGovernance\(user\?\.role\)/);
  assert.match(workflow, /if \(!canManage\) return;/);
  assert.match(workflow, /isApiForbiddenError\(error\)/);
  assert.match(workflow, /setGovernanceAccessRevoked\(true\)/);
  assert.match(workflow, /memberModal\.onClose\(\)/);
  assert.match(workflow, /await refreshUser\(\)/);
  assert.doesNotMatch(workflow, /router\.(?:push|replace)/);

  assert.match(page, /actions=\{canManage \? \(/);
  assert.match(page, /canManage=\{canManage\}/);
  assert.match(page, /accessDisabled=\{!canManage\}/);
  assert.match(list, /\{canManage \? <div className="flex flex-wrap gap-2">/);
  assert.match(list, /\{canManage \? <div className="flex items-center gap-2">/);
  assert.match(modal, /submitDisabled=\{Boolean\(formDisabledReason\) \|\| saving \|\| accessDisabled\}/);
});

test('Documents keep authenticated downloads while hiding and guarding every member mutation', () => {
  const page = dashboard('documents', 'page.tsx');
  const workflow = dashboard('documents', 'use-documents-workflow.ts');
  const list = dashboard('documents', 'document-list-panel.tsx');

  assert.match(workflow, /canManageGovernance\(user\?\.role\)/);
  assert.match(workflow, /isApiForbiddenError\(error\)/);
  assert.match(workflow, /setGovernanceAccessRevoked\(true\)/);
  assert.match(workflow, /uploadModal\.onClose\(\)/);
  assert.match(workflow, /deleteModal\.onClose\(\)/);
  assert.match(workflow, /linkModal\.onClose\(\)/);
  assert.match(workflow, /await refreshUser\(\)/);
  assert.doesNotMatch(workflow, /router\.(?:push|replace)/);

  for (const handler of ['handleUpload', 'handleDelete', 'handleLinkStandard', 'handleUnlinkStandard']) {
    const start = workflow.indexOf(`const ${handler}`);
    const end = workflow.indexOf('\n  const ', start + 1);
    assert.ok(start >= 0, `${handler} must exist`);
    assert.match(workflow.slice(start, end >= 0 ? end : undefined), /canManage/);
  }

  const downloadStart = workflow.indexOf('const handleDownload');
  const downloadEnd = workflow.indexOf('\n\n  return {', downloadStart);
  const downloadHandler = workflow.slice(downloadStart, downloadEnd);
  assert.match(downloadHandler, /\/documents\/\$\{encodeURIComponent\(doc\.id\)\}\/download/);
  assert.doesNotMatch(downloadHandler, /if \(!canManage\)/);

  assert.match(page, /actions=\{canManage \? \(/);
  assert.match(page, /isOpen=\{canManage && uploadModal\.isOpen\}/);
  assert.match(list, /\{canManage \? <Button[\s\S]*?Link standard/);
  assert.match(list, /\{canManage \? <Button[\s\S]*?Delete/);
  assert.match(list, /onPress=\{\(\) => handleDownload\(doc\)\}/);
});

test('Dashboard gives members review language while preserving legitimate navigation', () => {
  const page = dashboard('dashboard', 'page.tsx');
  const workflow = dashboard('dashboard', 'use-dashboard-workflow.ts');
  const summaries = dashboard('dashboard', 'dashboard-summary-cards.tsx');
  const actions = dashboard('dashboard', 'dashboard-action-lists.tsx');
  const progress = dashboard('dashboard', 'dashboard-progress-panels.tsx');

  assert.match(workflow, /const canManage = canManageGovernance\(user\?\.role\)/);
  assert.match(workflow, /const canManageBilling = user\?\.role === 'OWNER'/);
  assert.match(page, /Read-only overview/);
  assert.match(page, /Ask an owner or administrator to make changes/);
  assert.match(page, /View billing status/);
  assert.match(page, /\{canManageBilling \? 'Manage billing' : 'View billing status'\}/);
  assert.match(summaries, /canManage \? 'Manage sign-off' : 'View sign-off'/);
  assert.match(actions, /canManage \? 'Add board members' : 'View board register'/);
  assert.match(progress, /review recorded progress and evidence gaps/);
  assert.match(page, /href="\/compliance"/);
  assert.match(page, /href="\/export"/);
});
