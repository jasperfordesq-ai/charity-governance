import assert from 'node:assert/strict';
import test from 'node:test';
import { GOVERNANCE_PRINCIPLES } from '../constants/governance-code.js';
import {
  IRISH_COMPLIANCE_MATRIX,
  IRISH_COMPLIANCE_MATRIX_LAST_CHECKED,
  getMatrixEntriesForStandard,
  getProfessionalReviewFlags,
} from '../constants/irish-compliance-matrix.js';

const allGovernanceCodes = GOVERNANCE_PRINCIPLES.flatMap((principle) =>
  principle.standards.map((standard) => standard.code),
);
const knownGovernanceCodes = new Set(allGovernanceCodes);
const principleNumberByCode = new Map(
  GOVERNANCE_PRINCIPLES.flatMap((principle) =>
    principle.standards.map((standard) => [standard.code, principle.number] as const),
  ),
);

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
      assert.equal(sourceRef.lastChecked, IRISH_COMPLIANCE_MATRIX_LAST_CHECKED);
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

test('Irish compliance matrix entries have unique IDs and non-empty review fields', () => {
  const ids = IRISH_COMPLIANCE_MATRIX.map((entry) => entry.id);

  assert.equal(new Set(ids).size, ids.length);
  for (const entry of IRISH_COMPLIANCE_MATRIX) {
    assert.ok(entry.id.trim(), 'Expected entry id');
    assert.ok(entry.userTask.trim(), `Expected user task for ${entry.id}`);
    assert.ok(entry.copyTone.trim(), `Expected copy tone for ${entry.id}`);
    assert.ok(entry.testExpectation.trim(), `Expected test expectation for ${entry.id}`);
    assert.ok(entry.applicabilityNote.trim(), `Expected applicability note for ${entry.id}`);
    assert.ok(entry.evidenceRequired.length > 0, `Expected evidence for ${entry.id}`);
    for (const sourceRef of entry.sourceRefs) {
      assert.ok(sourceRef.name.trim(), `Expected source name for ${entry.id}`);
      assert.ok(sourceRef.owner.trim(), `Expected source owner for ${entry.id}`);
      assert.ok(sourceRef.note.trim(), `Expected source note for ${entry.id}`);
    }
  }
});

test('Irish compliance matrix entries use valid principle numbers and align standards to principles', () => {
  const validPrincipleNumbers = new Set(GOVERNANCE_PRINCIPLES.map((principle) => principle.number));

  for (const entry of IRISH_COMPLIANCE_MATRIX) {
    for (const principleNumber of entry.principleNumbers) {
      assert.ok(validPrincipleNumbers.has(principleNumber), `${entry.id} has invalid principle ${principleNumber}`);
    }
    for (const code of entry.standardCodes) {
      const expectedPrinciple = principleNumberByCode.get(code);
      assert.ok(expectedPrinciple, `${entry.id} references unknown standard ${code}`);
      assert.ok(
        entry.principleNumbers.includes(expectedPrinciple),
        `${entry.id} standard ${code} must align to principle ${expectedPrinciple}`,
      );
    }
  }
});

test('Irish compliance matrix entries do not duplicate professional review flags per entry', () => {
  for (const entry of IRISH_COMPLIANCE_MATRIX) {
    assert.equal(
      new Set(entry.professionalReview).size,
      entry.professionalReview.length,
      `${entry.id} should not duplicate professional review flags`,
    );
  }
});

test('Irish compliance matrix uses revised Charities Act sources, not enacted statutory text', () => {
  const sourceUrls = IRISH_COMPLIANCE_MATRIX.flatMap((entry) => entry.sourceRefs.map((sourceRef) => sourceRef.url));

  assert.ok(
    sourceUrls.some((url) => url.includes('revisedacts.lawreform.ie/eli/2009/act/6/revised')),
    'Expected revised Law Reform Commission Charities Act 2009 source',
  );
  assert.ok(
    sourceUrls.some((url) => url.includes('irishstatutebook.ie/eli/isbc/2024_21.html')),
    'Expected Irish Statute Book Charities (Amendment) Act 2024 commencement/effects source',
  );
  assert.equal(
    sourceUrls.some((url) => url.includes('/enacted/')),
    false,
    'Matrix statutory sources should not use enacted URLs',
  );
});
