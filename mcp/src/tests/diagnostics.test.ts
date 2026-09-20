import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics } from '../diagnostics.js';
import { registerSecret, clearSecrets } from '../redact.js';

test('nothing is written unless verbose is on', () => {
  const lines: string[] = [];
  createDiagnostics(false, (line) => lines.push(line)).toolCall('board_register', 'ok', 12);
  assert.deepEqual(lines, []);
});

test('a verbose line names the tool, the outcome and the time, with secrets redacted', () => {
  clearSecrets();
  registerSecret('supersecrettoken123');
  const lines: string[] = [];
  createDiagnostics(true, (line) => lines.push(line)).toolCall(
    'board_register',
    'error UNAUTHORIZED supersecrettoken123',
    12,
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\[charitypilot-mcp\] board_register error UNAUTHORIZED \[redacted\] 12ms$/);
  clearSecrets();
});
