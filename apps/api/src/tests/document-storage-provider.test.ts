import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDocumentStorageProviderRegistry,
  documentStorageProviders,
} from '../services/document-storage-provider.js';
import { AppError } from '../utils/errors.js';

function assertAppError(action: () => unknown, statusCode: number, code: string) {
  assert.throws(action, (err) => {
    assert.equal(err instanceof AppError, true);
    assert.equal((err as AppError).statusCode, statusCode);
    assert.equal((err as AppError).code, code);
    return true;
  });
}

const registry = createDocumentStorageProviderRegistry([
  { id: 'supabase', stage: 'ga' },
  { id: 'local', stage: 'ga' },
  { id: 'confluence', stage: 'alpha' },
]);

test('a ga provider is selectable without any alpha opt-in', () => {
  assert.equal(registry.assertSelectable('supabase', { alphaOptIn: false }), 'supabase');
  assert.equal(registry.assertSelectable('local', { alphaOptIn: false }), 'local');
});

test('an alpha provider is refused unless the organisation has opted in', () => {
  assertAppError(
    () => registry.assertSelectable('confluence', { alphaOptIn: false }),
    400,
    'STORAGE_PROVIDER_ALPHA_NOT_ENABLED',
  );
});

test('an alpha provider is selectable once the organisation has opted in', () => {
  assert.equal(registry.assertSelectable('confluence', { alphaOptIn: true }), 'confluence');
});

test('an alpha provider can never be the deployment default, even with opt-in', () => {
  assertAppError(
    () => registry.assertDefaultable('confluence'),
    500,
    'STORAGE_PROVIDER_ALPHA_NOT_DEFAULTABLE',
  );
  assert.equal(registry.assertDefaultable('supabase'), 'supabase');
});

test('an unknown provider is refused by both gates', () => {
  assertAppError(() => registry.assertSelectable('dropbox', { alphaOptIn: true }), 400, 'STORAGE_PROVIDER_UNKNOWN');
  assertAppError(() => registry.assertDefaultable('dropbox'), 500, 'STORAGE_PROVIDER_UNKNOWN');
});

test('isKnown reports membership without throwing', () => {
  assert.equal(registry.isKnown('local'), true);
  assert.equal(registry.isKnown('dropbox'), false);
});

test('the shipped registry contains only ga providers in this phase', () => {
  const stages = documentStorageProviders.list().map((descriptor) => `${descriptor.id}:${descriptor.stage}`).sort();
  assert.deepEqual(stages, ['local:ga', 'supabase:ga']);
});
