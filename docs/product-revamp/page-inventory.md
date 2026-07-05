# Page Inventory

Date checked: 2026-07-05

Superseded by the generated platform completion audit in
`docs/platform-completion-audit.md`. Keep this file as a short handoff note only;
the generated audit is the current route inventory source of truth.

## Current Snapshot

- 25 page routes scanned.
- 15 routes are P0 trustee, compliance, billing, auth, or conversion-critical workflows.
- 0 route files are 450+ lines.
- Route page inline icon cleanup is closed for the audited app-route files.
- Static route-level dark-mode and decorative-style findings are clear.
- Deployed browser QA remains the proof gate for route polish, mobile fit, theme contrast, and real auth/provider wiring.

## Routes Still Requiring Launch QA Evidence

| Priority | Route | Area | Current next proof |
| --- | --- | --- | --- |
| P0 | `/` | Marketing | Desktop/mobile, light/dark, public CTA and trust-copy review. |
| P0 | `/pricing` | Marketing | Plan comparison, CTA, billing-copy, and mobile scanability check. |
| P0 | `/login` | Auth | Safe redirect, validation, password control, and mobile form check. |
| P0 | `/register` | Auth | Account creation, validation, organisation setup entry, and mobile form check. |
| P0 | `/dashboard` | App | Trustee overview, next actions, empty states, and responsive dashboard navigation. |
| P0 | `/compliance` | App | Compliance year, simple/complex standards, progress language, and source posture. |
| P0 | `/compliance/[principleId]` | App | Autosave, pending-save navigation guard, retry state, and evidence/explanation editing. |
| P0 | `/documents` | App | Upload, linked standards, signed downloads, delete flow, and private-storage messaging. |
| P0 | `/deadlines` | App | Auto/manual deadlines, profile-triggered prompts, completion toggles, and delete confirmation. |
| P0 | `/board` | App | Trustee register, induction/conduct evidence prompts, mobile cards, and edit states. |
| P0 | `/registers` | App | Complete-plan gate, conflicts, risks, complaints, fundraising, annual report, and financial controls. |
| P0 | `/regulator` | App | Source-cited readiness map, conditional obligations, and professional-review warnings. |
| P0 | `/organisation` | App | Conditional obligation profile, charity setup facts, dirty state, and save feedback. |
| P0 | `/billing` | App | Current plan, checkout/portal degradation, Complete-only messaging, and provider-safe errors. |
| P0 | `/export` | App | Readiness warnings, source/professional-review appendix, board sign-off, and download flow. |

## Remaining Work

Use `docs/platform-completion-audit.md`, `PRODUCTION_TODO.md`, and
`docs/production-browser-qa.md` for the live checklist. The next local UI work is
not another static inventory; it is deployed browser evidence across desktop and
mobile in both themes, plus any defect fixes discovered by that evidence.

Do not mark this inventory complete by inspection alone. The launch evidence
ledger must include deployed browser QA and accessibility command transcripts
before CharityPilot can handle real charity data.
