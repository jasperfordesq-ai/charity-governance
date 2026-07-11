import assert from "node:assert/strict";
import test from "node:test";
import { upsertComplianceSignoffSchema } from "../schemas/compliance.js";
import { createDeadlineSchema } from "../schemas/deadline.js";
import { uploadDocumentSchema } from "../schemas/document.js";
import { createConflictRecordSchema } from "../schemas/governance-registers.js";
import { updateOrganisationSchema } from "../schemas/organisation.js";

const EXPECTED_UPDATED_AT = "2026-01-01T00:00:00.000Z";

test("shared date schemas reject impossible calendar dates instead of Date.parse normalization", () => {
  const cases = [
    [
      "organisation financial year end",
      updateOrganisationSchema,
      { expectedUpdatedAt: EXPECTED_UPDATED_AT, financialYearEnd: "2026-02-31" },
    ],
    [
      "deadline due date",
      createDeadlineSchema,
      { title: "Annual return", dueDate: "2026-02-31" },
    ],
    [
      "governance register declared date",
      createConflictRecordSchema,
      {
        trusteeName: "A Trustee",
        matter: "Related-party payment",
        nature: "Potential conflict",
        dateDeclared: "2026-02-31",
        actionTaken: "Recorded and recused",
      },
    ],
    [
      "compliance signoff board date",
      upsertComplianceSignoffSchema,
      {
        reportingYear: 2026,
        status: "APPROVED",
        boardMeetingDate: "2026-02-31",
        minuteReference: "BM-2026-01",
        approvedByName: "Chair",
      },
    ],
    [
      "document approval date",
      uploadDocumentSchema,
      {
        name: "Safeguarding policy",
        category: "POLICY",
        approvedDate: "2026-02-31",
      },
    ],
  ] as const;

  for (const [label, schema, payload] of cases) {
    assert.equal(
      schema.safeParse(payload).success,
      false,
      `${label} must reject impossible dates`,
    );
  }
});

test("civil-date fields accept real calendar dates while timestamp fields still accept datetimes", () => {
  assert.equal(
    updateOrganisationSchema.safeParse({ expectedUpdatedAt: EXPECTED_UPDATED_AT, financialYearEnd: "2024-02-29" })
      .success,
    true,
  );
  assert.equal(
    createDeadlineSchema.safeParse({
      title: "Annual return",
      dueDate: "2026-06-06",
    }).success,
    true,
  );
  assert.equal(
    uploadDocumentSchema.safeParse({
      name: "Board minutes",
      category: "BOARD_MINUTES",
      approvedDate: "2026-06-06T12:00:00.000Z",
    }).success,
    true,
  );
});

test("organisation and deadline civil-date fields reject timestamps even when the date part is valid", () => {
  for (const [label, schema, payload] of [
    [
      "organisation financial year end",
      updateOrganisationSchema,
      { expectedUpdatedAt: EXPECTED_UPDATED_AT, financialYearEnd: "2026-06-30T00:00:00.000Z" },
    ],
    [
      "organisation CRO annual return date",
      updateOrganisationSchema,
      { expectedUpdatedAt: EXPECTED_UPDATED_AT, croAnnualReturnDate: "2026-09-30T00:00:00.000Z" },
    ],
    [
      "deadline due date",
      createDeadlineSchema,
      { title: "Annual return", dueDate: "2026-06-06T00:00:00.000Z" },
    ],
  ] as const) {
    assert.equal(
      schema.safeParse(payload).success,
      false,
      `${label} must be an exact YYYY-MM-DD date`,
    );
  }
});

test("organisation legal-calendar inputs stay within a derivation-safe civil range", () => {
  assert.equal(
    updateOrganisationSchema.safeParse({ expectedUpdatedAt: EXPECTED_UPDATED_AT, financialYearEnd: "9997-12-31" })
      .success,
    true,
  );
  for (const payload of [
    { expectedUpdatedAt: EXPECTED_UPDATED_AT, financialYearEnd: "9998-01-01" },
    { expectedUpdatedAt: EXPECTED_UPDATED_AT, incorporationDate: "9999-01-01" },
    { expectedUpdatedAt: EXPECTED_UPDATED_AT, croAnnualReturnDate: "9999-12-31" },
  ]) {
    assert.equal(updateOrganisationSchema.safeParse(payload).success, false);
  }
});

test("updateOrganisationSchema accepts nullable confirmed calendar inputs and enforces member count", () => {
  assert.equal(updateOrganisationSchema.safeParse({ name: "Missing version" }).success, false);
  assert.equal(
    updateOrganisationSchema.safeParse({ expectedUpdatedAt: "2026-01-01", name: "Bad version" }).success,
    false,
  );
  assert.equal(
    updateOrganisationSchema.safeParse({
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
      legalForm: "CLG",
      confirmLegalForm: true,
      incorporationDate: "2018-05-15",
      croAnnualReturnDate: "2026-09-30",
      confirmCroAnnualReturnDate: true,
      lastActualAgmDate: "2026-03-12",
      lastUnanimousAnnualMemberResolutionDate: null,
      memberCount: 4,
    }).success,
    true,
  );

  assert.equal(
    updateOrganisationSchema.safeParse({ expectedUpdatedAt: EXPECTED_UPDATED_AT, legalForm: null, memberCount: null })
      .success,
    true,
  );
  assert.equal(
    updateOrganisationSchema.safeParse({ expectedUpdatedAt: EXPECTED_UPDATED_AT, memberCount: 0 }).success,
    false,
  );
  assert.equal(
    updateOrganisationSchema.safeParse({ expectedUpdatedAt: EXPECTED_UPDATED_AT, memberCount: 2_147_483_647 }).success,
    true,
  );
  assert.equal(
    updateOrganisationSchema.safeParse({ expectedUpdatedAt: EXPECTED_UPDATED_AT, memberCount: 2_147_483_648 }).success,
    false,
  );
  assert.equal(
    updateOrganisationSchema.safeParse({ expectedUpdatedAt: EXPECTED_UPDATED_AT, confirmLegalForm: "yes" }).success,
    false,
  );
});

test("updateOrganisationSchema rejects contradictory confirmations and chronology in one patch", () => {
  for (const payload of [
    { expectedUpdatedAt: EXPECTED_UPDATED_AT, legalForm: null, confirmLegalForm: true },
    { expectedUpdatedAt: EXPECTED_UPDATED_AT, croAnnualReturnDate: null, confirmCroAnnualReturnDate: true },
    {
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
      incorporationDate: "2025-01-01",
      lastActualAgmDate: "2024-12-31",
    },
    {
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
      incorporationDate: "2025-01-01",
      lastUnanimousAnnualMemberResolutionDate: "2024-12-31",
    },
    {
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
      incorporationDate: "2025-01-01",
      croAnnualReturnDate: "2024-12-31",
    },
  ]) {
    assert.equal(updateOrganisationSchema.safeParse(payload).success, false);
  }
});

test("createDeadlineSchema accepts only known conditional-obligation profile rule keys", () => {
  assert.equal(
    createDeadlineSchema.safeParse({
      title: "Safeguarding review",
      dueDate: "2026-08-10",
      profileRuleKey: "worksWithChildrenOrVulnerableAdults",
    }).success,
    true,
  );

  assert.equal(
    createDeadlineSchema.safeParse({
      title: "Invented review",
      dueDate: "2026-08-10",
      profileRuleKey: "inventedProfileFact",
    }).success,
    false,
  );
});

test("updateOrganisationSchema accepts conditional obligation profile facts", () => {
  const result = updateOrganisationSchema.safeParse({
    expectedUpdatedAt: EXPECTED_UPDATED_AT,
    conditionalObligationProfile: {
      hasPaidStaff: true,
      hasVolunteers: true,
      raisesFundsFromPublic: true,
      worksWithChildrenOrVulnerableAdults: false,
      processesPersonalData: true,
      operatesPremisesOrEvents: true,
      isPublicSectorBody: false,
      usesDataProcessors: true,
    },
  });

  assert.equal(result.success, true);
});

test("updateOrganisationSchema rejects invalid conditional obligation profile facts", () => {
  const result = updateOrganisationSchema.safeParse({
    expectedUpdatedAt: EXPECTED_UPDATED_AT,
    conditionalObligationProfile: {
      hasPaidStaff: "yes",
      raisesFundsFromPublic: true,
      unknownTrigger: true,
    },
  });

  assert.equal(result.success, false);
});
