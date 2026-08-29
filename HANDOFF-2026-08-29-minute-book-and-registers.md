# Handoff — give CharityPilot a minute book

**Written 29 August 2026, after the first full governance audit of a live charity in this app.**
Target: hOUR Timebank CLG, RCN 20162023, CRO 608327. Single-member CLG, FYE 31 July, three
directors, audit exempt under s.360 Companies Act 2014.

Read this whole file before writing code. The first section is why, and it matters more than the
spec — the feature is small, but getting its semantics wrong would make the app actively harmful.

---

## Why this exists

CharityPilot's compliance record is only as good as the evidence behind it. Today we audited the
charity's paper record against the app and found the same defect everywhere:

**Eight documents assert that the Board approved them, and in every case the minute says something
else or does not exist.**

- Abridged financial statements FY2021 claim approval on 4 August 2021. That meeting's own minute
  records approval of the **2020** report.
- FY2022 claim 23 November 2022. That minute contains no approval of accounts at all — the real
  approval is at the AGM of 24–25 August 2022.
- FY2023 carries no approval statement whatsoever.
- FY2024 carries the literal string `approved by the board on [30/10/2025]` — square brackets, an
  unfilled template placeholder. **No board minutes exist for calendar 2025 anywhere.**
- FY2025 carries an illegible handwritten date.
- The Governance Code compliance records for 2020 and 2022 cite minutes that, on reading, record a
  review and an administrative remark respectively.
- The website Terms and Conditions are "previously approved by board resolution" — a phrase that
  originated in an **agenda** and was carried into the minute. No resolution exists.

Twenty-eight policies dated March 2026 sit in the folder and **not one is adopted on the record**:
two approval instruments were drafted and neither was executed.

The cause is structural, and it is in this app. **CharityPilot models documents, standards, risks,
conflicts, deadlines and trustees. It does not model a meeting, a minute, or a resolution.** So the
link between "the Board approved X" and "here is the minute that proves it" lives nowhere, and the
compliance record can be filled in with approvals nobody can produce.

That link is the product. Everything below serves it.

---

## Priority 1 — Meetings and Resolutions register

The core of the work. New models, routes and UI.

### Data model

```prisma
enum GoverningActKind {
  BOARD_MEETING              // minuted meeting of the directors
  DIRECTORS_WRITTEN_RESOLUTION   // s.161 Companies Act 2014
  MEMBER_WRITTEN_RESOLUTION      // s.193, incl. s.175(3) in lieu of AGM
  ANNUAL_GENERAL_MEETING
  EXTRAORDINARY_GENERAL_MEETING
}

enum GoverningActStatus {
  SCHEDULED
  HELD                // meeting happened, minutes not yet drafted
  DRAFT               // minutes drafted, not circulated
  CIRCULATED          // out to directors for correction
  APPROVED            // approved at a later meeting, or executed for a written resolution
  SUPERSEDED
}

model GoverningAct {
  id             String   @id @default(cuid())
  organisationId String
  kind           GoverningActKind
  status         GoverningActStatus @default(SCHEDULED)
  actDate        DateTime @db.Date        // date held, or date the last signature was applied
  reference      String                    // human key, e.g. "BM-2026-08-07", "WR-2026-07-10"
  title          String
  statutoryBasis String?                   // "s.161 Companies Act 2014"
  approvedAtActId String?                  // the later meeting that approved these minutes
  approvedAt     DateTime?
  documentId     String?                   // the minutes or resolution file in Document
  notes          String?

  resolutions    Resolution[]
  @@unique([organisationId, reference])
}

model Resolution {
  id              String   @id @default(cuid())
  organisationId  String
  governingActId  String
  itemNumber      String?                 // "10.4"
  text            String                  // the operative "Resolved: that ..." wording
  carried         Boolean  @default(true)
  abstentions     String?                 // names, for conflicted directors
  conflictRecordId String?                // link to ConflictRecord where a director stood out
  createdAt       DateTime @default(now())
}
```

Add to `Document`: `approvedByResolutionId String?`. **Do not remove the existing `approvedDate`
and `boardMinuteReference` fields** — backfill them from the resolution and keep them as the
denormalised display values.

### Rules the model must enforce

These are not cosmetic. Each one corresponds to a real failure found today.

1. **A document cannot be marked approved without a `Resolution`.** No free-text approval. If a
   user has a document that claims approval and cannot produce the resolution, the correct state
   is `approvalAsserted: true, approvedByResolutionId: null` — surfaced as **"asserted, not
   evidenced"**, never as approved.
2. **Minutes are not evidence until approved.** A `GoverningAct` of kind `BOARD_MEETING` in status
   `DRAFT` or `CIRCULATED` cannot be cited as the evidence for a compliance record. Draft minutes
   backing an approval is exactly the FY2024 problem.
3. **A written resolution cannot be dated after its statutory deadline.** For
   `MEMBER_WRITTEN_RESOLUTION` under s.175(3), the resolution must be signed *before* the latest
   date for holding the meeting. A later date does not cure it. **Warn, do not block** — and never
   silently accept a date that makes the record look compliant when it is not.
4. **Refuse to fabricate.** No "assume approved", no defaulting an approval date to the document
   date. An empty approval is a finding, not a gap to fill.

### API

```
GET    /api/v1/governing-acts?year=&kind=&status=
POST   /api/v1/governing-acts
PATCH  /api/v1/governing-acts/:id        (expectedUpdatedAt, as deadlines do)
POST   /api/v1/governing-acts/:id/resolutions
PATCH  /api/v1/resolutions/:id
GET    /api/v1/board-submissions          <- see Priority 2
```

---

## Priority 2 — The Board Submissions view

This is what the feature is *for*, and it should be the page a trustee opens.

A single view, backed by `GET /api/v1/board-submissions`, listing every document that needs a
board decision, in two parts:

- **Evidenced** — approved, with the resolution and the meeting date shown as a link, not as text.
- **Outstanding** — split into *not evidenced* (approval asserted, no resolution), *not submitted*
  (exists, never went to the Board), and *does not exist yet*.

We are currently maintaining this by hand as `BOARD-SUBMISSIONS-INDEX.md` in the charity's project
folder at `C:\Users\jaspe\OneDrive\Documents\Timebank Ireland`. **Read that file before designing
the view** — it is a worked example of the output, written against a real charity, including the
statuses that turned out to be necessary. It will drift the moment nobody updates it, which is
precisely why this belongs in the app.

Add an export that regenerates that markdown, so the folder copy stays true without hand-editing.

---

## Priority 3 — Statutory registers

The app holds `BoardMember` but has no statutory registers. Two are needed.

**Register of Members.** Section 54D of the Charities (Amendment) Act 2024 — enacted, not yet
commenced — will require every charity to keep one: name, address, date entered, date ceased, with
ex-member data deleted one year after cessation. Build it now with that retention rule.

It also matters immediately: **`memberCount` drives the AGM logic in `deadline-calendar.ts`** and
is currently a bare number a user types in. It should be derived from the register.

**Register of Directors and Secretary.** Section 149 Companies Act 2014. `BoardMember` is close but
is missing the particulars — date of birth, usual residential address, other directorships, former
names, and the distinction between appointment *by the Board* under a constitutional article and
appointment by the members. That distinction is not academic: a director appointed by the Board
holds office only until the next AGM and must be confirmed in the annual member resolution.

---

## Priority 4 — Single-member correctness

`deadline-calendar.ts` already handles the sole-member case, which is good. Two things in it are
wrong or over-cautious, and both were checked against primary sources today.

**The rule is not 12 months.** The code uses
`sole-member-written-resolution-plus-12-month-internal-review-cadence`. The statutory position is
that a written resolution is deemed passed at a meeting held on the date of the last signature
(s.193(4)), so the s.175(1) limits run from it exactly as they run from an AGM: the earlier of
15 months and 31 December of the following calendar year. The 12-month convention is *safer*, not
*correct*, and the two branches of the same function currently apply different rules to the same
statutory test. Use the AGM branch's `min(plus15Months, calendarYearCap)` for both, and if a
tighter internal cadence is wanted, surface it as a separate planning reminder.

**"A written resolution is never treated as an AGM" is too strong.** Section 175(4) provides that
where the Act requires a thing to be done at an AGM and that thing is dealt with in the resolution,
the requirement "shall be regarded as having been complied with". The resolution does not *become*
an AGM, but it does discharge the obligation. The current copy tells a compliant charity it is not.

**Add the eligibility test the app should be running.** Three conditions, all checkable:
`memberCount == 1` (s.1202 withholds the dispensation only from a CLG with *more than one* member);
the constitution does not exclude written resolutions (s.1208 permits exclusion — for this charity
Article 20 expressly permits them); and no change of statutory auditor is proposed (s.175(3)(c)).
If all three hold, say so plainly instead of routing the user to professional review.

---

## Priority 5 — The session drops constantly

`JWT_EXPIRY` defaults to `15m` and a refresh token exists, but in practice the app signs out
mid-task, repeatedly. Over one working session today it dropped four times, each time losing work
in progress.

Diagnose before changing the TTL — 15 minutes is a reasonable access-token lifetime and the bug is
more likely in the refresh path. Check that the web app retries once on a 401 by refreshing, that
the refresh cookie's `maxAge` is what it should be, and that a refresh failure surfaces as "please
sign in" rather than a silent 401 from every subsequent call. **Do not raise `JWT_EXPIRY` above
`1h`** — `requireAccessTokenExpiry` in `utils/env.ts` rejects it in production, correctly.

---

## Priority 6 — API ergonomics

Small, cheap, and they cost real time today.

- **`GET /api/v1/compliance/records` without `year` returns**
  `Expected number, received nan`. `complianceQuerySchema` uses `z.coerce.number()` on a required
  field. Default it to the current reporting year, or return a message naming the missing parameter.
- **Concurrency tokens are undiscoverable.** `PUT /compliance/records/:standardId` needs
  `expectedRevision`; `PATCH /deadlines/:id` needs `expectedUpdatedAt`; the governance-register
  PATCH routes need neither. The 428 on the compliance route is good — the pattern should be
  consistent across all mutating routes, and the required field should be named in the error.
- **`/api/v1/risks` 404s**; the real path is `/api/v1/governance-registers/risks`. Either alias it
  or make the 404 name the correct prefix.

---

## Data to load once the models exist

Backfill this charity from its minute book. It is the acceptance test.

| Reference | Kind | Date | Notes |
|---|---|---|---|
| AGM-2023-08-04 | ANNUAL_GENERAL_MEETING | 2023-08-04 | The last general meeting held |
| BM-2024-09-08 | BOARD_MEETING | 2024-09-08 | Appointed Catherine Murphy Chair and Secretary; discontinued the former Treasurer's policies |
| WR-2025-10-24-omnibus | MEMBER_WRITTEN_RESOLUTION | 2025-10-24 | Ratification of prior acts. **Not** an annual member decision |
| WR-2025-11-03 | MEMBER_WRITTEN_RESOLUTION | 2025-11-03 | Director appointment |
| BM-2026-03-18 | BOARD_MEETING | 2026-03-18 | **Status DRAFT — never approved.** Four compliance findings cite it |
| BM-2026-06-12 | BOARD_MEETING | 2026-06-12 | Approved at BM-2026-07-03 |
| WR-2026-07-10 | DIRECTORS_WRITTEN_RESOLUTION | 2026-07-10 | s.161. Timebanking UK framework. Chairperson conflicted, did not vote |
| BM-2026-07-03 | BOARD_MEETING | 2026-07-03 | Approved at BM-2026-08-07 |
| BM-2026-08-07 | BOARD_MEETING | 2026-08-07 | Status CIRCULATED. Director's loan approved by the two non-conflicted directors |

**Calendar 2025 has no board meetings at all.** That absence must be visible in the UI, not merely
implied by empty rows — a year with no minuted board meeting is a finding in itself.

---

## What not to do

- **Do not build a document management system.** Files live in the charity's project folder, which
  is the single source of truth as of today. This app holds the *record about* those documents.
- **Do not add a members portal, messaging, or e-signature.** Out of scope.
- **Do not touch FilingBridge.** See the note below.
- **Do not let any of this write a date, a name, or an approval the user did not supply.**

---

## Note on FilingBridge — and why it needs nothing

The accounts app has `ApprovedBy` and `ApprovedAt` on its filing packages, plus
`ApproverProfessionalBody` and `ApproverMembershipNumber` on the CRO package. Those record **who
signed off the filing** — an accountant-style attestation. They are *not* the board's approval of
the financial statements under section 324 Companies Act 2014, which requires the statutory
financial statements to be approved by the board and signed by two directors, and minuted.

There is no board-minute reference anywhere in FilingBridge's entity model. The only resolution
fields in it are `SapResolutionDate` and `SapResolutionReference` on `DirectorLoan`, for the summary
approval procedure. So FilingBridge can generate and hand off a filing package asserting approval
with nothing behind it — which is exactly how the FY2024 and FY2025 statements went to the CRO
carrying approval dates no minute supports.

**The fix is not in FilingBridge.** The minute book is a governance artefact and belongs in one
place. Once CharityPilot holds the resolutions, FilingBridge needs at most a single reference field
to quote — and until then, the honest position is that its `ApprovedBy` must never be read as
evidence of a board approval. Say so in its UI copy; that is the only change it needs.

---

## How to verify you are done

1. Load the nine governing acts above. `BM-2026-03-18` shows as unapproved, and every compliance
   record citing it is flagged.
2. Attempt to mark a policy approved with no resolution. It must refuse, and offer
   "asserted, not evidenced" instead.
3. The Board Submissions view reproduces `BOARD-SUBMISSIONS-INDEX.md` without hand-editing.
4. With `memberCount = 1` and a member written resolution dated 2026-12-15, the next member-action
   deadline is 2027-12-15 or earlier under `min(+15 months, 31 Dec 2027)` — not a bare +12 months —
   and the copy does not tell the charity it needs professional review to skip an AGM it is
   entitled to skip.
5. Work for an hour without being signed out.

Run the existing test suites. `governance-registers-reliability.test.ts` is the model to follow for
the new routes — concurrency, validation and no-write-on-error are all covered there already.
