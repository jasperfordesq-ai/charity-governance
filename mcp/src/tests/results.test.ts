import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asObject, okResult, describeError, errorResult } from '../results.js';
import { ApiError, ApprovalRequiredError } from '../client.js';
import { NotConnectedError } from '../session.js';
import { FileAccessError } from '../files.js';
import { ConnectorError, ConnectionError } from '../errors.js';

test('a result is text and structured content of the same object', () => {
  const result = okResult({ data: [{ id: 'a' }], total: 1 });
  assert.deepEqual(result.structuredContent, { data: [{ id: 'a' }], total: 1 });
  assert.deepEqual(JSON.parse(result.content[0]!.text), result.structuredContent);
  assert.equal(result.isError, undefined);
});

test('a bare array or primitive is wrapped, because structured content must be an object', () => {
  assert.deepEqual(asObject([1, 2]), { data: [1, 2] });
  assert.deepEqual(asObject('ok'), { data: 'ok' });
  assert.deepEqual(asObject(null), { data: null });
});

test('an approval refusal is structured with everything but a way to grant it', () => {
  const error = new ApprovalRequiredError({
    approvalId: 'apr_1',
    summary: 'Permanently delete risk "Flood"',
    command: 'charitypilot-mcp approve apr_1',
    expiresAt: '2026-09-20T10:05:00.000Z',
    resourceId: 'r-1',
  });
  const described = describeError(error);
  assert.equal(described.code, 'APPROVAL_REQUIRED');
  assert.equal(described.action, 'approve');
  assert.equal(described.approvalId, 'apr_1');
  assert.equal(described.command, 'charitypilot-mcp approve apr_1');
  assert.equal(described.resourceId, 'r-1');
  assert.equal(described.retryable, true);
});

test('API, connector, connection, file and session errors each keep their code', () => {
  assert.equal(
    describeError(new ApiError(409, 'x', { code: 'DEADLINE_UPDATE_CONFLICT', action: 'reread', retryable: true })).action,
    'reread',
  );
  assert.equal(describeError(new ApiError(409, 'x', { code: 'DEADLINE_UPDATE_CONFLICT' })).status, 409);
  assert.equal(describeError(new ConnectorError('PERSONAL_DATA_WITHHELD', 'x')).code, 'PERSONAL_DATA_WITHHELD');
  assert.equal(describeError(new ConnectionError('x')).code, 'NETWORK');
  assert.equal(describeError(new FileAccessError('x')).code, 'FILE_ACCESS');
  assert.equal(describeError(new NotConnectedError()).code, 'NOT_CONNECTED');
  assert.equal(describeError(new NotConnectedError()).action, 'connect');
});

test('a plain error is the connector refusing the arguments', () => {
  const described = describeError(new Error('page must be a whole number between 1 and 9007199254740991.'));
  assert.equal(described.code, 'INVALID_ARGUMENTS');
  assert.equal(described.action, 'fix_arguments');
  assert.equal(described.retryable, false);
});

test('an error result redacts secrets from the text and carries the structure', () => {
  const result = errorResult(new ApiError(401, 'Bearer abcdefghijklmnop was refused', { code: 'UNAUTHORIZED' }));
  assert.equal(result.isError, true);
  assert.ok(!result.content[0]!.text.includes('abcdefghijklmnop'));
  assert.equal(result.structuredContent['code'], 'UNAUTHORIZED');
});
