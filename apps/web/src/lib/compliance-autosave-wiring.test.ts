import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const dashboard = (...parts: string[]) =>
  readFileSync(join(process.cwd(), 'src', 'app', '(dashboard)', ...parts), 'utf8');
const component = (...parts: string[]) =>
  readFileSync(join(process.cwd(), 'src', 'components', ...parts), 'utf8');

test('principle autosave is revision-aware and delegates ordering to the serialized queue', () => {
  const workflow = dashboard('compliance', '[principleId]', 'use-principle-detail-workflow.ts');

  assert.match(workflow, /new ComplianceAutosaveQueue<StandardFormState>/);
  assert.match(workflow, /expectedRevision,/);
  assert.match(workflow, /createSaveQueue\(standard\.id, record\?\.revision \?\? 0\)/);
  assert.match(workflow, /COMPLIANCE_RECORD_REVISION_CONFLICT/);
  assert.match(workflow, /queue\.hasUnsettledChanges\(\)/);
  assert.doesNotMatch(workflow, /const pendingSaveData = useRef/);
  assert.doesNotMatch(workflow, /delete pendingSaveData\.current/);
  assert.doesNotMatch(workflow, /setTimeout\([\s\S]{0,300}\[standardId\]: 'idle'/);
});

test('field events enqueue once outside React state updaters and conflict UI preserves the draft', () => {
  const workflow = dashboard('compliance', '[principleId]', 'use-principle-detail-workflow.ts');
  const editor = dashboard('compliance', '[principleId]', 'standard-editor-card.tsx');
  const states = component('ui', 'states.tsx');

  const updateField = workflow.slice(
    workflow.indexOf('const updateField ='),
    workflow.indexOf('useEffect(() => {', workflow.indexOf('const updateField =')),
  );
  assert.match(updateField, /formStateRef\.current/);
  assert.match(updateField, /setFormState\(formStateRef\.current\);\s*autoSave\(standardId, nextForm\);/);
  assert.doesNotMatch(updateField, /setFormState\(\(prev\)[\s\S]*autoSave/);

  assert.match(editor, /save === 'conflict'/);
  assert.match(editor, /Your local draft is preserved/);
  assert.match(editor, /Discard my draft and reload saved version/);
  assert.match(editor, /Discard draft and reload/);
  assert.match(workflow, /resolveConflictFromServer/);
  assert.match(workflow, /const conflictGeneration = conflictedQueue\.getSnapshot\(\)\.localGeneration/);
  assert.match(workflow, /latestQueue\.getSnapshot\(\)\.localGeneration !== conflictGeneration/);
  assert.match(workflow, /conflictedQueue\.dispose\(\)/);
  assert.match(states, /Newer saved version/);
  assert.match(states, /Unsaved changes/);
});

test('principle route loads are abortable and stale responses cannot replace the active principle', () => {
  const workflow = dashboard('compliance', '[principleId]', 'use-principle-detail-workflow.ts');

  assert.match(workflow, /const principleLoadRequestSeq = useRef\(0\)/);
  assert.match(workflow, /const requestSeq = \+\+principleLoadRequestSeq\.current/);
  assert.match(workflow, /const controller = new AbortController\(\)/);
  assert.match(workflow, /signal: controller\.signal/);
  assert.match(workflow, /if \(!active \|\| requestSeq !== principleLoadRequestSeq\.current\) return/);
  assert.match(workflow, /controller\.abort\(\)/);
});
