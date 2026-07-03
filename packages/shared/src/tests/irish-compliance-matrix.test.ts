import assert from 'node:assert/strict';
import test from 'node:test';
import { GOVERNANCE_PRINCIPLES } from '../constants/governance-code.js';
import {
  IRISH_COMPLIANCE_MATRIX,
  getMatrixEntriesForStandard,
  getProfessionalReviewFlags,
} from '../constants/irish-compliance-matrix.js';

const allGovernanceCodes = GOVERNANCE_PRINCIPLES.flatMap((principle) =>
  principle.standards.map((standard) => standard.code),
);
const knownGovernanceCodes = new Set(allGovernanceCodes);

test('Irish compliance matrix covers every Governance Code standard with a source-cited entry', () => {
  const coveredCodes = new Set(IRISH_COMPLIANCE_MATRIX.flatMap((entry) => entry.standardCodes));

  assert.deepEqual([...coveredCodes].sort(), [...allGovernanceCodes].sort());
  for (const code of allGovernanceCodes) {
    const entries = getMatrixEntriesForStandard(code);
    assert.ok(entries.length > 0, `Expected matrix entry for standard ${code}`);
    assert.ok(
      entries.every((entry) => entry.sourceRefs.length > 0),
      `Expected source references for standard ${code}`,
    );
  }
});

test('Irish compliance matrix source references are dated HTTPS citations', () => {
  for (const entry of IRISH_COMPLIANCE_MATRIX) {
    for (const sourceRef of entry.sourceRefs) {
      assert.match(sourceRef.url, /^https:\/\//, `${entry.id} source must use HTTPS`);
      assert.match(sourceRef.lastChecked, /^\d{4}-\d{2}-\d{2}$/, `${entry.id} source date must be ISO`);
      assert.equal(sourceRef.lastChecked, '2026-07-03');
    }
  }
});

test('Irish compliance matrix does not reference unknown Governance Code standards', () => {
  for (const entry of IRISH_COMPLIANCE_MATRIX) {
    for (const code of entry.standardCodes) {
      assert.ok(knownGovernanceCodes.has(code), `${entry.id} references unknown standard ${code}`);
    }
  }
});

test("standard 4.2 includes a regulator feature-area matrix entry", () => {
  assert.ok(
    getMatrixEntriesForStandard('4.2').some((entry) => entry.featureArea === 'regulator'),
    'Expected 4.2 to include regulator feature area',
  );
});

test("standard 4.2 includes solicitor professional review", () => {
  assert.ok(getProfessionalReviewFlags('4.2').includes('solicitor'));
});

test('conditional professional review flags exist for specialist obligations', () => {
  const flags = new Set(IRISH_COMPLIANCE_MATRIX.flatMap((entry) => entry.professionalReview));

  assert.ok(flags.has('data_protection'));
  assert.ok(flags.has('safeguarding'));
  assert.ok(flags.has('health_and_safety'));
  assert.ok(flags.has('protected_disclosures'));
});
