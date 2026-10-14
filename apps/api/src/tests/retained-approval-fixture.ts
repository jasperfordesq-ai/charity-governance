/**
 * A Compliance Record approval exactly as it was retained before linked
 * evidence documents, the trustee-declaration table and the narrative
 * staleness warnings were added to the report (2026-10-14).
 *
 * The dataset below is what the charity's rows looked like when the board
 * approved. The stored snapshot and both hashes were computed from it by the
 * code as it stood BEFORE that change, then frozen here as literals, because
 * the point of the test that uses them is that code written afterwards must
 * still accept them. Never regenerate these values to make a test pass: a
 * mismatch means a retained approval has stopped verifying.
 */

export const RETAINED_MATRIX_LAST_CHECKED_AT_CAPTURE = '2026-07-09';

export const retainedOrganisation = {
  id: 'org-retained',
  name: 'Retained Approval Charity',
  rcnNumber: '20000001',
  complexity: 'SIMPLE',
  conditionalObligationProfile: {
    hasPaidStaff: false,
    hasVolunteers: true,
    raisesFundsFromPublic: false,
    worksWithChildrenOrVulnerableAdults: false,
    processesPersonalData: true,
    operatesPremisesOrEvents: false,
    isPublicSectorBody: false,
    usesDataProcessors: false,
  },
};

const principleTwo = { id: 'p-2', number: 2, title: 'Behaving with integrity', description: '', sortOrder: 2 };
const principleFive = { id: 'p-5', number: 5, title: 'Working effectively', description: '', sortOrder: 5 };

export const retainedStandards = [
  { id: 's-2-1', principleId: 'p-2', principle: principleTwo, code: '2.1', title: 'Agree the basic values', isCore: true, isAdditional: false, sortOrder: 1 },
  { id: 's-2-3', principleId: 'p-2', principle: principleTwo, code: '2.3', title: 'Have a code of conduct signed by all charity trustees', isCore: true, isAdditional: false, sortOrder: 3 },
  { id: 's-5-6', principleId: 'p-5', principle: principleFive, code: '5.6', title: 'Recruit and induct charity trustees', isCore: true, isAdditional: false, sortOrder: 6 },
];

function record(standardId: string, actionTaken: string, evidence: string) {
  return {
    id: `rec-${standardId}`,
    organisationId: retainedOrganisation.id,
    standardId,
    reportingYear: 2026,
    status: 'COMPLIANT',
    actionTaken,
    evidence,
    notes: null,
    explanationIfNA: null,
    revision: 2,
    updatedById: 'user-retained',
    createdAt: new Date('2026-08-01T09:00:00.000Z'),
    updatedAt: new Date('2026-09-01T10:00:00.000Z'),
  };
}

export const retainedRecords = [
  record('s-2-1', 'Values agreed and published on the website.', 'Board minutes 2026-03.'),
  record('s-2-3', 'Code of conduct adopted; no trustee has signed yet. Target: 3 September 2026', 'Adopted code of conduct.'),
  record('s-5-6', 'Induction pack issued to new trustees.', 'Induction checklist.'),
];

export const retainedApproval = {
  sequence: 1,
  boardMeetingDate: '2026-09-02',
  minuteReference: 'BM-2026-09',
  approvedByName: 'Chairperson',
  approvedByRole: 'Chair',
  approvalNotes: null,
  recordedById: 'user-retained',
  recordedByName: 'Recording User',
  approvedAt: '2026-09-02T19:30:00.000Z',
};

// ---- Frozen from the pre-change code. Do not edit. -------------------------

export const RETAINED_EVIDENCE_HASH = '8e18df896fe2f520236f1766c7644acbc8ec06042b40e87373f951c6d8548735';
export const RETAINED_SNAPSHOT_HASH = 'acba7d325d299e96de53fec252d515019bfeefe3dccb1de94ea1374bd84b448b';
export const retainedStoredPayload: unknown = {
  "kind": "charitypilot.compliance-approval",
  "formatVersion": 1,
  "evidence": {
    "organisation": {
      "id": "org-retained",
      "name": "Retained Approval Charity",
      "rcnNumber": "20000001"
    },
    "reportingYear": 2026,
    "scope": {
      "complexity": "SIMPLE",
      "plan": "ESSENTIALS",
      "conditionalObligationProfile": {
        "hasPaidStaff": false,
        "hasVolunteers": true,
        "raisesFundsFromPublic": false,
        "worksWithChildrenOrVulnerableAdults": false,
        "processesPersonalData": true,
        "operatesPremisesOrEvents": false,
        "isPublicSectorBody": false,
        "usesDataProcessors": false
      }
    },
    "matrixLastChecked": "2026-07-09",
    "standards": [
      {
        "principle": {
          "id": "p-2",
          "number": 2,
          "title": "Behaving with integrity",
          "sortOrder": 2
        },
        "standard": {
          "id": "s-2-1",
          "code": "2.1",
          "title": "Agree the basic values",
          "isCore": true,
          "isAdditional": false,
          "sortOrder": 1
        },
        "record": {
          "id": "rec-s-2-1",
          "revision": 2,
          "status": "COMPLIANT",
          "actionTaken": "Values agreed and published on the website.",
          "evidence": "Board minutes 2026-03.",
          "notes": null,
          "explanationIfNA": null,
          "updatedById": "user-retained",
          "updatedAt": "2026-09-01T10:00:00.000Z"
        }
      },
      {
        "principle": {
          "id": "p-2",
          "number": 2,
          "title": "Behaving with integrity",
          "sortOrder": 2
        },
        "standard": {
          "id": "s-2-3",
          "code": "2.3",
          "title": "Have a code of conduct signed by all charity trustees",
          "isCore": true,
          "isAdditional": false,
          "sortOrder": 3
        },
        "record": {
          "id": "rec-s-2-3",
          "revision": 2,
          "status": "COMPLIANT",
          "actionTaken": "Code of conduct adopted; no trustee has signed yet. Target: 3 September 2026",
          "evidence": "Adopted code of conduct.",
          "notes": null,
          "explanationIfNA": null,
          "updatedById": "user-retained",
          "updatedAt": "2026-09-01T10:00:00.000Z"
        }
      },
      {
        "principle": {
          "id": "p-5",
          "number": 5,
          "title": "Working effectively",
          "sortOrder": 5
        },
        "standard": {
          "id": "s-5-6",
          "code": "5.6",
          "title": "Recruit and induct charity trustees",
          "isCore": true,
          "isAdditional": false,
          "sortOrder": 6
        },
        "record": {
          "id": "rec-s-5-6",
          "revision": 2,
          "status": "COMPLIANT",
          "actionTaken": "Induction pack issued to new trustees.",
          "evidence": "Induction checklist.",
          "notes": null,
          "explanationIfNA": null,
          "updatedById": "user-retained",
          "updatedAt": "2026-09-01T10:00:00.000Z"
        }
      }
    ],
    "readiness": {
      "ready": true,
      "missingRecords": [],
      "missingEvidence": [],
      "missingExplanations": [],
      "profileIssues": [],
      "conditionalReviewItems": [
        {
          "profileKey": "hasVolunteers",
          "label": "Volunteer role and supervision evidence",
          "recommendedAction": "Keep role descriptions, onboarding, supervision and policy ownership records proportionate to the volunteer activity.",
          "standardCodes": [
            "3.1",
            "3.2",
            "3.3"
          ],
          "commencementStatuses": [
            "conditional"
          ],
          "professionalReview": [
            "employment",
            "equality",
            "governance_expert"
          ],
          "sourceRefs": [
            {
              "name": "Charities Governance Code",
              "owner": "Charities Regulator",
              "url": "https://www.charitiesregulator.ie/media/fpbnz5xz/charities-governance-code.pdf",
              "lastChecked": "2026-07-09",
              "note": "Canonical six-principle Governance Code and standards catalogue."
            },
            {
              "name": "Charities Governance Code Compliance Record Form",
              "owner": "Charities Regulator",
              "url": "https://www.charitiesregulator.ie/en/guidance/forms-and-templates/forms",
              "lastChecked": "2026-07-09",
              "note": "Official annual record form used to document actions and evidence."
            },
            {
              "name": "Your Rights",
              "owner": "Irish Human Rights and Equality Commission",
              "url": "https://www.ihrec.ie/your-rights",
              "lastChecked": "2026-07-09",
              "note": "Public guidance on equality and human-rights law in Ireland."
            },
            {
              "name": "Information Guides and Booklets",
              "owner": "Workplace Relations Commission",
              "url": "https://www.workplacerelations.ie/en/publications_forms/guides_booklets/",
              "lastChecked": "2026-07-09",
              "note": "Employment, labour and equality law guides for employers."
            }
          ],
          "applicabilityNotes": [
            "Role clarity applies to every charity; employment-law prompts apply only where the charity has paid staff, and equality review depends on activities and workforce context."
          ]
        },
        {
          "profileKey": "processesPersonalData",
          "label": "Data protection accountability",
          "recommendedAction": "Review privacy, retention, processor, access-control and breach-response evidence under data-protection obligations.",
          "standardCodes": [
            "4.2",
            "6.1"
          ],
          "commencementStatuses": [
            "conditional",
            "guidance",
            "not_commenced"
          ],
          "professionalReview": [
            "data_protection",
            "governance_expert",
            "health_and_safety",
            "protected_disclosures",
            "safeguarding",
            "solicitor"
          ],
          "sourceRefs": [
            {
              "name": "Charities Governance Code",
              "owner": "Charities Regulator",
              "url": "https://www.charitiesregulator.ie/media/fpbnz5xz/charities-governance-code.pdf",
              "lastChecked": "2026-07-09",
              "note": "Canonical six-principle Governance Code and standards catalogue."
            },
            {
              "name": "Charities Governance Code Compliance Record Form",
              "owner": "Charities Regulator",
              "url": "https://www.charitiesregulator.ie/en/guidance/forms-and-templates/forms",
              "lastChecked": "2026-07-09",
              "note": "Official annual record form used to document actions and evidence."
            },
            {
              "name": "Protected Disclosures",
              "owner": "Charities Regulator",
              "url": "https://www.charitiesregulator.ie/en/information-for-the-public/protected-disclosures",
              "lastChecked": "2026-07-09",
              "note": "Protected disclosure route and workplace-reporting context."
            },
            {
              "name": "For Organisations",
              "owner": "Data Protection Commission",
              "url": "https://www.dataprotection.ie/en/organisations",
              "lastChecked": "2026-07-09",
              "note": "Organisational obligations under data protection law and GDPR."
            },
            {
              "name": "Safety Statement and Risk Assessment",
              "owner": "Health and Safety Authority",
              "url": "https://www.hsa.ie/topics/managing_health_and_safety/safety_statement_and_risk_assessment/",
              "lastChecked": "2026-07-09",
              "note": "Employer risk-assessment and safety-statement guidance."
            },
            {
              "name": "Charities (Amendment) Act 2024 commencement and effects",
              "owner": "Irish Statute Book",
              "url": "https://www.irishstatutebook.ie/eli/isbc/2024_21.html",
              "lastChecked": "2026-07-09",
              "note": "Commencement and legislative-effects table for 2024 charity amendments."
            },
            {
              "name": "Charities Act 2009 Revised",
              "owner": "Law Reform Commission",
              "url": "https://revisedacts.lawreform.ie/eli/2009/act/6/revised/en/pdf?annotations=false",
              "lastChecked": "2026-07-09",
              "note": "Administrative consolidation of current Charities Act 2009 text."
            },
            {
              "name": "Guidance on Developing a Child Safeguarding Statement",
              "owner": "Tusla",
              "url": "https://www.tusla.ie/uploads/content/4214-TUSLA_Guidance_on_Developing_a_CSS_LR.PDF",
              "lastChecked": "2026-07-09",
              "note": "Guidance for organisations required to prepare child safeguarding statements."
            }
          ],
          "applicabilityNotes": [
            "Applies as a legal-obligations register prompt for every charity; specialist topics apply only where the charity profile triggers them, such as personal data, staff, child-facing services, insurance risks or reporting-channel thresholds.",
            "Monitor the Irish Statute Book commencement table for Charities (Amendment) Act 2024 provisions that are not yet commenced; do not treat those provisions as current live duties until a commencement order brings them into force.",
            "Applies to every charity for public identity and stakeholder accountability; funder-reporting and subscribed-standard prompts apply where those relationships exist."
          ]
        }
      ],
      "matrixReviewItems": [
        {
          "standardCode": "2.1",
          "matrixEntryId": "values-conflicts-and-conduct",
          "commencementStatus": "guidance",
          "boardApproval": "required",
          "professionalReview": [
            "governance_expert"
          ],
          "sourceRefs": [
            {
              "name": "Charities Governance Code",
              "owner": "Charities Regulator",
              "url": "https://www.charitiesregulator.ie/media/fpbnz5xz/charities-governance-code.pdf",
              "lastChecked": "2026-07-09",
              "note": "Canonical six-principle Governance Code and standards catalogue."
            },
            {
              "name": "Charities Governance Code Compliance Record Form",
              "owner": "Charities Regulator",
              "url": "https://www.charitiesregulator.ie/en/guidance/forms-and-templates/forms",
              "lastChecked": "2026-07-09",
              "note": "Official annual record form used to document actions and evidence."
            },
            {
              "name": "Managing Conflicts of Interest",
              "owner": "Charities Regulator",
              "url": "https://www.charitiesregulator.ie/en/guidance/managing-a-charity/general",
              "lastChecked": "2026-07-09",
              "note": "Regulator guidance on identifying and managing charity conflicts."
            }
          ],
          "applicabilityNote": "Applies to every charity as governance evidence; the specific conflict-management procedure should fit the charity size and decision context.",
          "evidenceRequired": [
            "Published values statement",
            "Conflict of interest policy or procedure",
            "Conflict register extracts",
            "Signed trustee code of conduct records"
          ]
        },
        {
          "standardCode": "2.3",
          "matrixEntryId": "values-conflicts-and-conduct",
          "commencementStatus": "guidance",
          "boardApproval": "required",
          "professionalReview": [
            "governance_expert"
          ],
          "sourceRefs": [
            {
              "name": "Charities Governance Code",
              "owner": "Charities Regulator",
              "url": "https://www.charitiesregulator.ie/media/fpbnz5xz/charities-governance-code.pdf",
              "lastChecked": "2026-07-09",
              "note": "Canonical six-principle Governance Code and standards catalogue."
            },
            {
              "name": "Charities Governance Code Compliance Record Form",
              "owner": "Charities Regulator",
              "url": "https://www.charitiesregulator.ie/en/guidance/forms-and-templates/forms",
              "lastChecked": "2026-07-09",
              "note": "Official annual record form used to document actions and evidence."
            },
            {
              "name": "Managing Conflicts of Interest",
              "owner": "Charities Regulator",
              "url": "https://www.charitiesregulator.ie/en/guidance/managing-a-charity/general",
              "lastChecked": "2026-07-09",
              "note": "Regulator guidance on identifying and managing charity conflicts."
            }
          ],
          "applicabilityNote": "Applies to every charity as governance evidence; the specific conflict-management procedure should fit the charity size and decision context.",
          "evidenceRequired": [
            "Published values statement",
            "Conflict of interest policy or procedure",
            "Conflict register extracts",
            "Signed trustee code of conduct records"
          ]
        },
        {
          "standardCode": "5.6",
          "matrixEntryId": "board-meetings-decisions-and-induction",
          "commencementStatus": "guidance",
          "boardApproval": "recommended",
          "professionalReview": [
            "governance_expert"
          ],
          "sourceRefs": [
            {
              "name": "Charities Governance Code",
              "owner": "Charities Regulator",
              "url": "https://www.charitiesregulator.ie/media/fpbnz5xz/charities-governance-code.pdf",
              "lastChecked": "2026-07-09",
              "note": "Canonical six-principle Governance Code and standards catalogue."
            },
            {
              "name": "Charities Governance Code Compliance Record Form",
              "owner": "Charities Regulator",
              "url": "https://www.charitiesregulator.ie/en/guidance/forms-and-templates/forms",
              "lastChecked": "2026-07-09",
              "note": "Official annual record form used to document actions and evidence."
            }
          ],
          "applicabilityNote": "Applies to every charity with proportionate evidence for its board size, meeting cadence and trustee turnover.",
          "evidenceRequired": [
            "Trustee role and skills record",
            "Board calendar and agendas",
            "Board packs and minutes",
            "Induction completion records",
            "Issue or action log"
          ]
        }
      ],
      "matrixLastChecked": "2026-07-09"
    }
  },
  "approval": {
    "sequence": 1,
    "boardMeetingDate": "2026-09-02",
    "minuteReference": "BM-2026-09",
    "approvedByName": "Chairperson",
    "approvedByRole": "Chair",
    "approvalNotes": null,
    "recordedById": "user-retained",
    "recordedByName": "Recording User",
    "approvedAt": "2026-09-02T19:30:00.000Z"
  }
};
