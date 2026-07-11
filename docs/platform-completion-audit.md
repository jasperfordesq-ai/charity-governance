# CharityPilot Platform Completion Audit

Generated: 2026-07-11

Branch: `unknown`

Generation note: repository state is intentionally live-only; run `npm run launch:status -- --json` from the release checkout before collecting launch evidence. Use `node scripts/platform-completion-audit.mjs --json` for machine-readable route, backend, launch, compliance, and next-action data without rewriting this Markdown ledger.

This ledger is a current-state engineering audit. It is not legal advice and does not claim CharityPilot is legally complete, guaranteed, or ready to process real charity data.

## Executive Readiness

| Area | Current state | Next action |
| --- | --- | --- |
| Product UI | 26 page routes scanned; 15 are P0 trustee/compliance workflows; 0 route files are 450+ lines. | Complete deployed browser QA for every route across desktop/mobile and both themes. |
| API/backend | 12 route groups scanned with route-local guard heuristics and 67 API test files. | Preserve auth, tenant isolation, role guards, plan gates, validation, and redaction while fixing only audit-backed defects. |
| Launch operations | You have not created a production environment file yet. | Complete external provider, hosting, backup, observability, legal, browser QA, and security evidence before real charity data. |
| Irish compliance model | 12 matrix entries; last checked 2026-07-09; statuses guidance:6, conditional:3, not_commenced:2, in_force:1. | Refresh official sources before legal copy changes and record professional-review signoff outside git. |
| Verification surface | 36 web unit test files, 67 API test files, 17 Playwright specs. | Run full release, production-check, accessibility, and deployed-browser gates before launch signoff. |

## Fixed During This Audit Pass

- Strict shared ISO date validation now rejects impossible calendar dates before they can normalize into filing, board, document, register, or deadline records.
- Organisation profile date changes and derived auto-deadline regeneration now run inside one Prisma transaction.
- Document storage paths now include a UUID segment to avoid same-millisecond same-filename collisions.
- The documents API route now delegates upload MIME, signature, extension, and multipart-limit validation helpers to a dedicated module behind a production tooling regression test.
- Stripe customer creation now uses an organisation-scoped idempotency key to reduce orphan/duplicate external customers after retries.
- Stripe checkout now reconciles an existing Stripe customer by organisation metadata before creating a new customer.
- Stored Stripe customer IDs are now verified against Stripe customer metadata before checkout or portal reuse, and stale or wrong-organisation IDs are repaired through metadata reconciliation.
- Sensitive auth and invite throttles now use body-aware identifier keys for email or token attempts while preserving request-level protection where needed.
- Refresh and logout throttles now key by hashed refresh-token identifiers from the request body or refresh cookie, so one token cannot exhaust the same-IP bucket for another token.
- Sensitive public auth and invite throttles now have regression coverage proving one email/token identifier does not block a different identifier from the same caller.
- Registration throttling now has regression coverage proving normalized email identifiers share a throttle bucket without blocking a different email from the same caller.
- Resend-verification throttling now keys by hashed bearer/access-cookie credentials at the request hook, so one invalid credential cannot burn the same-IP bucket for another credential.
- Optional in-process cron logging now serializes errors through the redacted logger helper.
- Deadline reminder and optional cron runtime logs now route through injectable logger contracts instead of direct console.log calls.
- Email delivery degradation logs now route through an injectable logger contract instead of direct console warn/error calls.
- Runtime provider-error formatting now redacts Stripe, Stripe webhook, Resend, bearer-token, and Supabase apikey-shaped values before log serialization.
- Production preflight now rejects reserved documentation hostnames in DATABASE_URL so copied sample PostgreSQL values cannot pass as real launch configuration.
- Production database backup/restore checks now also reject reserved documentation hostnames before attempting a production PostgreSQL backup.
- Production launch status, core preflight, and the Supabase storage checker now reject copied Supabase service-role secret-store placeholders before marking the value complete or probing storage.
- Compliance/export/dashboard aggregate progress labels now say recorded progress rather than implying legal compliance certification.
- API-rendered exports now include a source/professional-review appendix and a not-legal-advice/non-certificate disclaimer.
- The API export route now delegates source-cited HTML report rendering to a dedicated module behind a production tooling regression test.
- The export workflow now surfaces source counts, professional-review flags, and not-yet-commenced monitoring metadata before report generation or board sign-off.
- Compliance detail autosave now flushes pending edits on blur/unmount, warns on browser unload, confirms in-app navigation while saves are pending, and exposes a retry action for failed saves.
- Production deploy defaults now include the TLS compose overlay, with an explicit --no-tls-proxy escape hatch for managed platform TLS.
- Production launch evidence now accepts either the default compose.production-tls.yml deploy path or an explicit --no-tls-proxy managed-TLS deploy transcript with external TLS certificate evidence.
- The plain-English launch guide now describes the Caddy TLS overlay as the default deploy path rather than optional proxy wiring.
- Production hostname defaults, launch validators, web runtime API validation, and production CSP now consistently require app.charitypilot.ie for the web app and api.charitypilot.ie for the API.
- The Irish compliance matrix now includes explicit not-yet-commenced Charities (Amendment) Act 2024 monitoring rows with solicitor review flags.
- Organisation setup now captures conditional obligation profile facts for staff, volunteers, fundraising, safeguarding, GDPR, premises/events, public-sector context, and processors.
- Approval readiness and exports now flag missing standard records, missing action/evidence fields, missing explanations, missing conditional-profile facts, and profile-triggered professional-review prompts.
- Governance architecture and backend audit docs now describe the broadened approval-readiness model behind a production tooling regression test.
- Dashboard navigation now gives the mobile sidebar explicit ARIA controls, Escape-to-close focus recovery, non-tabbable closed mobile links, and source-backed principle breadcrumb labels.
- Dashboard navigation now traps Tab and Shift+Tab inside the open mobile sidebar while preserving Escape-to-close focus recovery.
- Dashboard, compliance, compliance detail, and export route chrome now use lucide-react status, chevron, and download icons instead of route-local inline SVG markup behind a wiring regression test.
- Auth routes now use lucide-react password visibility, validation, mail, and alert icons instead of route-local inline SVG markup behind a wiring regression test.
- Marketing routes now use lucide-react feature, pricing, FAQ, and share/navigation icons instead of route-local inline SVG markup behind a wiring regression test.
- Documents now surface profile-triggered evidence prompts from the conditional obligation profile, including linked standard counts, source references, and professional-review flags.
- The document summary panel is split out of the oversized documents route behind a wiring regression test while preserving successful-load gating.
- The document upload modal and oversize-file guard UI are split out of the oversized documents route behind a wiring regression test.
- The document standard-link modal is split out of the oversized documents route behind a wiring regression test.
- Document upload and standard-link modals now share a HeroUI modal form-action footer primitive behind a wiring regression test.
- The document delete confirmation modal is split out of the oversized documents route behind a wiring regression test.
- The uploaded-document list panel is split out of the oversized documents route behind a wiring regression test.
- The document evidence-pack checklist and operational signal panels are split out of the documents route behind a wiring regression test.
- The document workflow loading, organisation-profile prompts, upload/link/delete/download mutations, and trusted download handling are split into a route-local hook behind a wiring regression test.
- Document upload, link, unlink, and delete mutations now expose the shared save-status primitive in the Document Vault header behind a production tooling regression test.
- Shared loading, empty, error, locked-feature, review-warning, and inline-status primitives now contain long text and actions within narrow/mobile layouts.
- Document and deadline destructive confirmations now share a contained HeroUI confirmation modal primitive behind a wiring regression test.
- Deadlines now surface profile-triggered review-date prompts from the conditional obligation profile, including source references, professional-review flags, and one-click review deadline prefills.
- The deadlines regulatory cadence panel now cites the Charities Regulator Annual Report source and last-checked metadata for the 10-month filing prompt.
- Deadline and regulator official-source links now share reusable source-reference primitives behind a wiring regression test.
- Regulator profile-triggered priority source links now use the shared source-reference primitive instead of route-local anchor styling.
- Profile-triggered document, deadline, register, regulator, and export prompts now render official sources as shared clickable source-reference lists.
- Export controls and board-approval panels now use shared status panel styling instead of route-local neutral card markup.
- The regulator guide now prioritises conditional obligation profile triggers with source references, workflow areas, and professional-review flags without legal-certainty claims.
- Governance registers now prioritise conditional obligation profile triggers with register-evidence signals, source references, and professional-review flags.
- The register profile-priority model and panel are split out of the oversized registers route behind a wiring regression test.
- The register Annual Report readiness and financial control review cards are split out of the oversized registers route behind a wiring regression test.
- The register overview summary panel and metric tiles are split out of the oversized registers route behind a wiring regression test.
- The register modal record forms and payload normaliser are split out of the oversized registers route behind a wiring regression test.
- The register record modal shell is split out of the oversized registers route behind a wiring regression test.
- The register operational record list sections are split out of the oversized registers route behind a wiring regression test.
- The register workflow loading, stale-request guard, save mutations, and priority derivation are split into a route-local hook behind a wiring regression test.
- The compliance principle standard editor card and save-state UI are split out of the oversized compliance detail route behind a wiring regression test.
- The compliance principle standard list is split out of the oversized compliance detail route behind a wiring regression test.
- The compliance principle loading and error states are split out of the oversized compliance detail route behind a wiring regression test.
- The compliance principle workflow hook now owns loading, autosave, approval-readiness refresh, and pending-navigation guards behind a wiring regression test.
- The document profile-triggered evidence prompt model and panel are split out of the oversized documents route behind a wiring regression test.
- The deadline profile-triggered review-date prompt model and panel are split out of the oversized deadlines route behind a wiring regression test.
- The deadline add/edit form modal is split out of the oversized deadlines route behind a wiring regression test.
- Deadline, board trustee, and register record form modals now share the HeroUI modal form-action footer primitive behind wiring regression tests.
- The deadline list panel, status classifier, and summary helper are split out of the oversized deadlines route behind a wiring regression test.
- The deadline overview and regulatory cadence panels are split out of the oversized deadlines route behind a wiring regression test.
- The deadline delete confirmation modal is split out of the deadlines route behind a wiring regression test.
- The deadline workflow loading, organisation-profile prompts, add/edit/delete/toggle mutations, and modal state are split into a route-local hook behind a wiring regression test.
- The board trustee evidence prompt cards and evidence chips are split out of the oversized board route behind a wiring regression test.
- The board member add/edit modal is split out of the oversized board route behind a wiring regression test.
- The board member list, mobile cards, desktop table, and status-toggle states are split out of the oversized board route behind a wiring regression test.
- The board workflow loading, summary derivation, add/edit/toggle mutations, and trustee form state are split into a route-local hook behind a wiring regression test.
- The export report preview cards and score helpers are split out of the oversized export route behind a wiring regression test.
- The export controls and readiness-warning panel are split out of the oversized export route behind a wiring regression test.
- The export board-approval form panel is split out of the oversized export route behind a wiring regression test.
- The export board sign-off save action now exposes the shared save-status primitive behind a production tooling regression test.
- The export workflow loading, approval-readiness refresh, board sign-off mutation, report-opening state, and blocker derivation are split into a route-local hook behind a wiring regression test.
- The compliance principle evidence-readiness panel is split out of the oversized compliance detail route behind a wiring regression test.
- Compliance principle in-app navigation now uses a HeroUI save/leave confirmation modal instead of a bare browser confirm prompt.
- Compliance principle pending-save navigation now uses the shared confirmation modal primitive while preserving keep-editing, leave, and save-now choices.
- The session-timeout warning now uses the shared HeroUI modal form-action footer with explicit sign-out and stay-signed-in actions behind a wiring regression test.
- The primary add actions on documents, board, and deadlines now use lucide-react Plus icons instead of route-local inline SVG markup behind a wiring regression test.
- The organisation conditional-obligation profile fields are split out of the oversized organisation route behind a wiring regression test.
- The organisation profile form section is split out of the oversized organisation route behind a wiring regression test.
- The organisation complexity guidance modal is split out of the oversized organisation route behind a wiring regression test.
- The organisation complexity guidance modal now uses a shared HeroUI dismiss-action footer primitive behind a wiring regression test.
- The organisation setup summary panel is split out of the oversized organisation route behind a wiring regression test.
- The organisation workflow session hydration, dirty-state guard, validation, save mutation, and setup form state are split into a route-local hook behind a wiring regression test.
- The dashboard deadline and board-alert action lists are split out of the oversized dashboard route behind a wiring regression test.
- The dashboard annual sign-off and governance register summary cards are split out of the oversized dashboard route behind a wiring regression test.
- The dashboard overall progress and principle progress panels are split out of the oversized dashboard route behind a wiring regression test.
- The dashboard workflow API loading, approval-readiness fetch, subscription-lapse handling, and derived board-alert state are split into a route-local hook behind a wiring regression test.
- The compliance overview principle list and disclosure cards are split out of the oversized compliance route behind a wiring regression test.
- The compliance overview workflow API loading, approval-readiness fetch, year/filter state, and evidence-prompt derivation are split into a route-local hook behind a wiring regression test.
- The billing plan gates, Stripe checkout cards, and billing notes are split out of the oversized billing route behind a wiring regression test.
- The board review-ready summary panel is split out of the oversized board route behind a wiring regression test.
- Responsive browser-smoke coverage now enumerates every shipped page route across desktop/mobile and light/dark themes, with a guard against reverting to network-idle waits.
- The local e2e public-route readiness sweep logs progress and can be skipped or time-boxed with E2E_SKIP_ROUTE_WARMING, E2E_ROUTE_WARM_TIMEOUT_MS, and E2E_ROUTE_WARM_BUDGET_MS for focused diagnostics.
- Local destructive E2E now runs only through a managed standalone stack with a positive allow-list build context, pinned local Docker daemon and integrated builder, exact pre-start Compose/DSN validation, generated UUID-bound disposable database, protected marker, restricted role, keyed API binding proof, internal-only database/API/web services exposed solely through a secretless fixed-route loopback TCP gateway, bounded tmpfs data storage, a baked read-only production web runtime, and finally-enforced exact-project cleanup; cleanup residue fails the gate and the retired boolean reset flag grants no authority.
- Exceptional remote-disposable database seams now require an active suite lease and same-session advisory-lease ownership before reset; after proven child-group absence, a fresh-connection outer janitor re-proves database identity, boundedly reacquires that lease, verifies API binding before and after the centralized reset, releases, and disconnects. Native-Windows remote-destructive execution is refused until Job Object-backed tree-lifetime proof exists; Linux and WSL process groups remain supported.
- One bounded parent lifecycle covers local, deployed, and remote modes and rechecks cancellation immediately before spawn. POSIX completion requires process-group absence plus leader close; abnormal Windows termination requires checked bounded taskkill /T /F plus leader close. If termination remains unproven, the runner fails red, skips the remote janitor or local Docker cleanup, and preserves recovery inputs.
- GET /auth/me now combines a 60-per-minute credential bucket with an independent 1,000-per-minute coarse IP ceiling. A shared case-insensitive, tab-tolerant Bearer parser governs authentication, rate limiting, and origin checks, and malformed Authorization never falls back to cookies; logout remains origin-sensitive. The proxy accepts only exact 200 for /me and refresh, requires exactly two strict nonempty scoped rotation cookies, forwards exactly two validated deletion cookies only on definitive refresh 401, and maps throttles, transient failures, and malformed responses to no-store 503.
- The production readiness TODO now requires final-release-ref command transcripts, commit SHA, workflow run, and digest manifest evidence instead of preserving stale local selected-gate commit claims.
- Deployed browser QA mode now uses existing non-sensitive test credentials and skips direct database reset or token-injection seams.
- Regulator official-source links now use compact link styling instead of pill-badge styling behind a wiring regression test.
- Regulator official guidance cards now use the shared source-reference card primitive instead of route-local external-link card markup.
- The regulator profile-triggered priorities section is split out of the oversized regulator route behind a wiring regression test.
- The regulator readiness overview and operating-model cards are split out of the oversized regulator route behind a wiring regression test.
- The regulator source-cited readiness matrix is split out of the oversized regulator route behind a wiring regression test.
- The platform audit now distinguishes decorative pill styling from functional switches and status dots so visual QA findings stay actionable.
- The platform audit now scans route-local extracted UI components when assessing static route-level visual and dark-mode signals.
- Launch status now separates missing production env values from external launch evidence gates, including deployed QA, provider/backups/observability evidence, legal review, pentest, and final signoffs.
- Platform audit now records launch evidence ledger status so operators know whether the ignored external evidence file has been initialized before filling the 86 checks.
- Platform audit now surfaces launch evidence approval state, final signoff state, and the next incomplete checks from the ignored evidence ledger.
- Launch evidence status now reports final approval role progress separately from checklist completion so signoff gaps stay visible.
- Launch evidence status now includes strict evidence validation and refuses status-complete approval when generic status flags would fail the final evidence validator.
- Launch status and platform audit now group missing production values by provider/source so operator handoff is clearer.
- Launch status and platform audit now report strict launch-gate completion percentages based only on production values, launch evidence checks, and final signoff roles.
- Launch status and production readiness TODO now name all 86 machine-readable launch evidence checks and the browserQa accessibility, cross-browser, and iOS Safari evidence slots.
- Production launch evidence now has a read-only status command that summarizes area-by-area completion without weakening the final validator.
- Production launch evidence status now surfaces required evidence hints for the next incomplete checks in both text and JSON output.
- Production launch evidence status now reports evidence-check and final-signoff completion percentages in both text and JSON output.
- Strict production launch evidence validation now prints checklist and final-signoff progress before the detailed issue list.
- Strict production launch evidence validation now supports --json output for CI and operator dashboards.
- Launch status now includes the next launch-evidence hint details in text and JSON output so operator dashboards can show the next proof to collect.
- Platform audit now records repository branch, HEAD, upstream sync, and dirty-worktree launch-evidence risk so external proof is tied to a clean, synced ref.
- Production launch evidence templates now include operator evidence hints for every required launch check behind a regression test.
- Production launch evidence status now falls back to current template hints for older evidence ledgers that were initialized before hint coverage was complete.
- Production launch evidence initialization now writes the template to an ignored .charitypilot-launch-evidence directory to keep real launch evidence out of the repo root.
- Protected production launch evidence workflows now validate dispatch-controlled artifact names, evidence file names, upload run ids, and SHA-256 values before using them in artifact or shell-path operations.
- Production launch evidence now requires legal/compliance final approval alongside engineering, operations, security, and business signoffs.
- Production launch evidence now requires named solicitor/governance/privacy review evidence inside the legal/compliance checklist area.
- Production preflight now rejects obvious low-entropy or sample JWT_SECRET and READINESS_API_KEY values instead of accepting length-only secrets.
- Production preflight now rejects sample Supabase project refs across API, public web, and Compose runtime Supabase origins.
- GitHub production environment validation now rejects sample Supabase project refs such as configured-project before release image promotion.
- Production launch evidence templates and validators now reject sample Supabase project refs so release evidence cannot contradict the GitHub environment preflight.
- Production Supabase storage checks now reject sample project refs before making any provider probe.
- Production release-run evidence validation now rejects sample Supabase build origins before GitHub API calls.
- Launch status now reports copied sample Supabase project refs as unresolved production values instead of ENV_COMPLETE.
- Production launch evidence status now treats sample Supabase release bindings as incomplete release identity evidence.
- Launch status now reports copied Stripe and Resend provider setup placeholders as unresolved production values instead of ENV_COMPLETE.
- Billing/email launch evidence now requires Stripe webhook subscription-event proof, webhook-secret secret-store proof, Resend accepted-send proof, and production email-link origin proof.
- Billing disabled checkout and portal actions now describe the visible provider-degraded or current-plan reason for assistive technology.
- Billing checkout and portal handoffs now use a shared visible inline status instead of a route-local hidden live-region message.
- Billing current-plan summary now uses shared status panel styling instead of route-local brand panel markup.
- Browser QA launch evidence now requires a dedicated deployed accessibility command transcript for light and dark theme checks.
- Deployed browser QA now has cross-browser responsive and accessibility script wiring for Chromium desktop, Chromium mobile emulation, Firefox, and WebKit evidence runs while keeping real iOS Safari as manual or cloud-device evidence.
- Deployed browser QA preflight now rejects copied credential placeholders and documentation owner email domains like example.com while keeping owner credential values out of operator transcripts.
- Supabase launch evidence now requires backup policy or PITR evidence plus restore-test owner/date/recovery notes, isolated restore target, non-production restore target, and confirmation that the production project was not overwritten.
- The team member list, role edit controls, loading/error/empty states, and shared role display metadata are split out of the team route behind a wiring regression test.
- The team invite form and pending-invite list are split out of the team route behind a wiring regression test while preserving invite role gates and revoke states.
- The team role guidance panel is split out of the team route behind a wiring regression test and now uses shared status panel styling.
- Team feedback now uses the shared inline status primitive instead of route-local alert styling.
- Team role-change and invite-revoke permission-denied messages now use a shared permission hint primitive instead of route-local grey boxes or text.
- Billing plan price blocks now use flat border bands instead of nested grey card panels behind a production tooling regression test.
- Dashboard shell loading and dashboard/compliance status dots now use shared UI primitives with dark-mode-aware semantic tones.
- Board and compliance binary filters now use HeroUI Switch controls instead of route-local switch markup.
- Deadline completion now uses a HeroUI Checkbox instead of a route-local button with checkbox ARIA.
- Export approval-readiness issue cards and conditional review prompts are split out of the route and now use shared status/review primitives instead of repeated warning-card markup.
- Organisation setup warning surfaces now use the shared inline status primitive instead of route-local amber advisory boxes.
- Organisation purpose and conditional-obligation checkbox groups now use HeroUI Checkbox controls instead of raw input controls.
- Organisation complexity selection now uses HeroUI RadioGroup controls instead of route-local pressed-button toggles.
- Board trustee conduct and induction evidence toggles now use HeroUI Checkbox controls instead of raw checkbox inputs.
- Register Annual Report and financial-control checklist rows now use HeroUI Checkbox controls instead of raw checkbox inputs.
- Compliance standard editor status rendering now tolerates optional selected-item labels during production builds.
- Compliance overview principle disclosure buttons now expose expanded state and controlled panel relationships for assistive technology.
- Auth password visibility controls now use a shared HeroUI icon-button primitive instead of repeated route-local raw buttons.
- Auth email and password-recovery status illustrations now use a shared dark-mode-aware status icon primitive instead of repeated route-local icon containers.
- Auth invite, reset-password, and verify-email async fallbacks now use shared loading primitives instead of route-local skeleton or spinner markup.
- Marketing blog search now uses the shared empty-state primitive for no-result filters instead of route-local dashed-panel markup.
- Marketing blog article copy now pairs hard-coded gray text colors with dark-mode text variants, closing the dark article contrast regression behind wiring and axe checks.
- Marketing landing workflow signal tiles now use shared status panel styling instead of route-local grey card markup.
- Compliance standard autosave, organisation profile saving, governance register saving, document vault mutations, export board sign-off, and board/deadline/team list mutations now use the shared save-status primitive instead of route-local status markup.
- Compliance overview summary and principle cards now use shared status panel styling instead of route-local neutral card markup.
- Compliance detail standard editor cards now use shared status panel styling instead of route-local neutral card markup.
- Shared utility icon controls for theme switching, copying links, and back-to-top now use HeroUI Button semantics.
- Compliance principle back navigation and autosave retry controls now use HeroUI Button primitives.
- Dashboard annual regulator summary now uses shared status panel styling instead of route-local brand panel markup.
- Dashboard summary and progress cards now use shared status panel styling instead of route-local neutral card markup.
- Dashboard deadline and board-alert action list cards now use shared status panel styling instead of route-local neutral card markup.
- The platform audit next sequence now shifts from broad route-local state cleanup to deployed-QA-driven fixes once static route findings are clear.
- Public marketing navigation, blog filters, and cookie-consent actions now use HeroUI Button primitives with dark-mode mobile navigation styling.
- Global recovery, not-found, dashboard mobile-menu, and compliance disclosure actions now use HeroUI Button primitives instead of bespoke route-local action markup.
- Responsive browser-smoke QA now waits for the parsed document shell before applying light/dark theme checks after commit-stage navigations.
- Document uploads now use a shared HeroUI-backed file upload field instead of route-local file input styling.
- Marketing blog search and trial CTA now use HeroUI Input and Button primitives instead of route-local form/link styling.
- Billing plan-gate explanation tiles now use a shared status tile primitive instead of route-local tile markup.
- Billing plan price bands, feature lists, and FAQ disclosure controls avoid nested card treatment and use lucide-react Check and ChevronDown icons instead of decorative dot/text affordances.
- Dashboard primary actions now share dark-mode-aware action button styling instead of repeating route-local teal button classes.
- Public marketing and auth primary CTAs now share the same dark-mode-aware action styling as dashboard workflows.
- Remaining public action controls now share the dark-mode-aware action button helper while banner and selected-filter styling stay scoped.
- Pricing metadata is ASCII-safe and pricing feature/comparison icons now use lucide-react directly without route-local wrappers.
- The plain-English launch guide now matches the evidence validator by requiring five final approval roles, including legal/compliance.
- The release readiness command now emits ASCII-safe operator output for cleaner Windows terminals and launch evidence transcripts.
- Public attribution surfaces now identify Jasper Ford as CharityPilot IP holder, declare AGPL-3.0-or-later licensing/no-warranty posture, and link to the canonical GitHub source repository across marketing, auth, dashboard, sitemap, NOTICE, and package metadata.
- The release readiness command now distinguishes skipped gates from a full release-ready result in its final summary.
- The managed isolated E2E runner now owns bounded stack startup and reachability probes, so a half-started disposable web/API stack fails the browser gate cleanly instead of hanging operator evidence collection.
- The release readiness command delegates destructive Playwright to the managed runner and leaves unrelated Node/npm processes untouched; the runner owns the common bounded lifecycle and fail-closed cleanup policy.
- The release readiness command now resolves npm and npx gates through explicit Node CLI entrypoints on Windows instead of shell execution, keeping launch evidence transcripts free of shell-argument deprecation warnings.
- The production readiness TODO now reflects the current 17-value launch blocker state without overclaiming unrun local smoke or external evidence.
- Supabase URL, service-role, and bucket configuration is now server-only end to end; web builds and runtimes trust only the authenticated CharityPilot API document-download route.
- The launch guide, production readiness TODO, and agent continuation handoff now reflect the 2026-07-09 launch counters: 9/28 production values, 9/87 evidence checks, 0/5 final signoffs, and the remaining external launch blockers.
- The plain-English launch guide now uses ASCII-safe operator text for cleaner Windows terminals, CI logs, and launch evidence transcripts.
- The production readiness TODO and launch guide record local responsive and accessibility QA evidence while keeping deployed QA open.
- The 2026-07-08 local Docker browser QA rerun completed all four responsive route chunks and the accessibility suite cleanly after stabilizing the local QA stack.
- The personal local readiness gate now gives operators a non-destructive local confidence command for one-person use without Stripe, payments, or production providers, while directing all destructive browser tests through the managed isolated runner that refuses personal database targets.
- Local-driver document downloads now require the requested storage path to belong to a live document row for the caller organisation before any file read occurs.
- The reliability report and generated reliability ledger now use ASCII-safe status text for cleaner release and launch evidence transcripts.
- The production environment generator now uses ASCII-safe operator hints for cleaner setup transcripts.
- The launch status script now keeps its operator-facing source text ASCII-safe for cleaner status transcripts.
- Launch status now has a non-secret JSON output mode for CI summaries, release handoffs, and operations dashboards.
- The release readiness command now reports full local success as repository release gates passed instead of implying production launch readiness.
- The standalone Next production web server now serializes caught request and shutdown errors before logging them.
- The Prisma seed script now serializes fatal seed errors through the shared redacted logger helper before printing them.
- The Next build cleanup helper now reports sanitized error codes instead of raw filesystem error objects in release transcripts.
- The PostgreSQL backup and restore helper now redacts database URLs, DATABASE_URL assignments, --database-url arguments, and user:password credentials from launch evidence transcripts.
- The production Supabase checker now redacts bearer keys, apikey values, signed URL tokens, storage object paths, and probe identifiers from request-failure launch transcripts.
- Production deploy, preflight, and rollback transcripts now redact database URLs, secret env assignments, bearer/apikey values, and signed token query parameters before surfacing command, smoke, or rollback failures.
- Production deploy smoke now redacts readiness keys, bearer values, and signed token query parameters from thrown request-failure launch transcripts.
- Production hosting checks now redact bearer values and signed token query parameters from thrown DNS/TLS/fetch failure launch transcripts.
- Production observability checks now retain sanitized webhook delivery exception detail while redacting bearer values and signed token query parameters from launch transcripts.
- Production provider checks now retain sanitized Stripe and Resend request exception detail while redacting bearer values, provider keys, and signed token query parameters from launch transcripts.
- Production release-run evidence checks now redact GitHub bearer tokens, GITHUB_TOKEN assignments, GitHub token prefixes, and signed artifact URL parameters from request-failure transcripts.
- Production database checks now catch and redact thrown backup-helper failures while still removing temporary backup directories unless retention is explicitly requested.
- Production rollback checks now redact manifest validation failures and thrown deploy exceptions while still deleting temporary merged env files.
- Production Supabase checks now redact service-role env assignments as well as bearer/apikey values, signed URL tokens, and storage probe paths from launch transcripts.
- Backend architecture docs now describe UUID-backed document storage keys and Stripe customer reconciliation instead of stale pre-hardening behavior.
- Request lifecycle docs now describe identifier-aware auth throttles for email, token, refresh-token, and credential buckets.
- Module dependency docs now describe auth as a public or partial-auth boundary with identifier-aware throttles instead of a missing organisation-guard concern.
- Production deploy preflight now redacts env-file failure transcripts before they are copied into release-gate evidence.
- Production environment preflight now redacts token-bearing env-file path failures before they are copied into release-gate evidence.
- Production launch evidence status and strict validation now redact token-bearing evidence-file path failures before operator handoff transcripts are stored.
- Production launch evidence status now has a non-secret JSON output mode for CI dashboards and operator handoff automation while preserving the strict final validator.
- Production launch evidence status completion now requires area statuses as well as all checks and final approval roles, reducing operator/validator drift.
- Launch status now exposes text and JSON launch-evidence status commands plus a stricter evidence-status-complete flag for operator dashboards.
- Launch status now exposes strict launch-evidence validation commands, including JSON output, alongside the read-only progress commands so operators can move from tracking to final gate validation without command drift.
- Strict launch-evidence JSON validation now includes the next incomplete checklist items and evidence hints so failing launch-gate output can drive operator work queues.
- Production launch evidence initialization now supports non-secret JSON output for operator dashboards and handoff automation without weakening the strict final validator.
- Deployed browser QA now has a no-network environment preflight that checks the deployed QA flag, canonical HTTPS origins, and test credential presence without printing credential values.
- Final signoff approval-role evidence now has to name the promoted release.commitSha, so engineering, operations, security, legal/compliance, and business signoffs cannot float across releases.
- Launch evidence status now counts final approval roles only when their approval evidence is bound to the promoted release.commitSha.
- Launch evidence status completion now requires the full release artifact binding, not only completed checklist statuses and final approval roles.
- Launch status now exposes repository branch, HEAD, upstream sync, and dirty-worktree risk so operators do not collect launch evidence from an unpushed or modified ref.
- Launch status now keeps the full source-grouped production value checklist visible even after .env.production exists, while separately listing the currently missing values.
- Launch status now exposes the deployed browser QA command set, including required environment values, the browserQa.browser-qa-completed preflight success marker, responsive/accessibility commands, cross-browser commands, iOS Safari evidence expectations, and the browserQa evidence target.
- Launch status now exposes the full production check, provider, deploy, rollback, release-run evidence, and final evidence validation command sequence needed to close the launch ledger.
- Platform audit now surfaces the release image promotion GitHub environment variables, workflow command, digest artifact, and evidence target from launch status so deploy operators do not miss the signed-image prerequisite.
- Launch status now exposes the required final signoff roles, solicitor/governance/privacy review, external pentest, release binding, and review-ready legal posture without legal-certainty claims.
- Production launch evidence now binds pentest, deployed browser QA, and final signoff proof to the exact promoted release commit SHA.
- Production launch evidence references now must use approved HTTPS evidence hosts and reject signed or token-bearing URL query strings.
- Production launch evidence now restricts GitHub evidence references to the canonical charity-governance repository.
- Production launch evidence chronology now lets operators prepare the package before collecting evidence while requiring all checklist evidence before final signoff approval.
- Production launch evidence deploy-smoke hints now match the strict validator by naming the deploy command, standalone smoke command, success marker, and canonical production origins.
- Platform audit generation now falls back to reading .git metadata directly when shelling out to git is unavailable.
- The plain-English launch guide and platform audit now describe launch status as local non-committed state, so fresh clones and partially configured production workstations do not contradict each other.
- Accessibility browser QA now uses commit-stage navigation, parsed-document waits, direct light/dark theme application, and explicit owner setup headroom.
- Responsive browser-smoke global setup now checks every public and auth route in the smoke suite before timed browser assertions.
- Responsive browser-smoke navigation now retries only bounded local transport-loss failures after probing the web origin, without masking timeouts or deployed QA failures.
- Responsive browser-smoke dashboard coverage now runs one route per test and seeds the shared local owner directly, while auth journey specs still exercise registration UI.
- Local Docker web QA now builds an optimized Next.js artifact once and serves it from the read-only isolated image, so route compilation cannot stall an individual browser test.
- Local Playwright screenshots, traces, videos, and HTML reports now default outside the repository, while CI writes them to an explicit uploaded artifact directory.
- Local Playwright QA now creates external artifact directories before reporters run, keeping early setup failures readable.
- Browser auth helpers now pre-seed the cookie-consent preference before registration, login, and invite acceptance so setup submissions are not competing with the consent dialog.
- Compliance record autosave now recovers from concurrent create races on the organisation/standard/year key with a scoped update instead of leaking a 500.
- Auth journey browser helpers require controlled input state and the expected API response before accepting a form submission while keeping deployed QA failures strict.
- Irish compliance matrix source metadata was refreshed against official Charities Regulator, Irish Statute Book, and Revised Acts sources on 2026-07-09.

## Local Verification Evidence

- Historical local release-gate evidence: `npm run release:ready` passed locally on 2026-07-09 at commit cf683f1: security scan, lint, build, workspace tests, dependency audit, reliability ledger, and 95 Playwright E2E tests passed; OVERALL: GREEN - repository release gates passed. This may be stale for the current checkout; rerun the selected gate on the final release ref and verify `npm run launch:status -- --json` reports the intended `repositoryState.headSha` before treating it as current release evidence.
- P0-05 published evidence on 2026-07-10: local isolation contracts passed 113/113, the managed disposable browser gate passed 96/96, API/web/shared tests passed 488/295/23, and production/local-Docker tooling passed 512/44. Commit `e9f63038a5e8fe0c0680dcc015566dff2525a56b` then passed exact-SHA CI run `29116192805` and direct-`master` E2E run `29116192729`, where the isolated browser gate again passed 96/96. Static reliability-title linkage remains distinct from execution, and release-promotion plus deployed-browser evidence remain open under P0-09.
- `npm run test:production-check` passed locally on 2026-07-09 with 352/352 production-tooling checks passing, including production validators, launch evidence validation, provider checker contracts, GitHub secret-store checker contracts, deployment tooling, deployed browser QA environment preflight, launch evidence work queue JSON, and CI/release workflow guards.
- `node --test scripts\check-production-providers.test.mjs scripts\production-launch-evidence.test.mjs` passed locally for provider and launch-evidence hardening.
- `npm test` passed locally across workspace tests, production-check scripts, and local Docker guard checks.
- `npm run test:e2e -- tests/accessibility.spec.ts` passed locally on 2026-07-08 across launch-critical public/auth and dashboard routes in light and dark themes, with no serious/critical violations.
- `cd e2e && npm test -- tests/accessibility.spec.ts --grep "/blog/understanding-the-charities-governance-code is axe-clean" --repeat-each=3` passed locally on 2026-07-09 after blog article dark-mode contrast hardening.
- Local responsive browser QA revalidated cleanly on 2026-07-09 with focused `npm run test:e2e:responsive:*` chunk commands: public desktop 14/14, public mobile 14/14, dashboard desktop 12/12, and dashboard mobile 12/12.
- `npm run test:e2e -- tests/accessibility.spec.ts` passed locally on 2026-07-09 with 26/26 accessibility checks across launch-critical public/auth and dashboard routes in light and dark themes.
- `npm run test:local-docker`, `npm run test:production-check`, and `npm run build -w @charitypilot/api` passed locally after the launch-status JSON and log-redaction hardening.
- `npm run lint -w @charitypilot/web`, `npm run build -w @charitypilot/web`, `node --check scripts\platform-completion-audit.mjs`, and `npm run test:production-check` passed locally after shared board/deadline/team/document/export mutation-status, billing action/status and price-band cleanup, team permission-hint cleanup, launch-evidence hardening, GitHub secret-store checker hardening, release-ready stack probe/repo-scoped child-process cleanup/no-shell gate execution hardening, deployed browser QA env preflight hardening, and launch evidence work-queue JSON hardening; production-tooling checks passed 352/352.
- `node --check scripts\clean-next-export.cjs`, `node --test scripts\check-production.test.mjs`, and `npm run test:production-check` passed locally after the Next cleanup transcript hardening.
- `node --check scripts\postgres-backup.mjs`, `node --test scripts\postgres-backup.test.mjs`, and `npm run test:production-check` passed locally after the PostgreSQL backup transcript-redaction hardening.
- `node --check scripts\check-production-supabase.mjs`, `node --test scripts\check-production-supabase.test.mjs`, and `npm run test:production-check` passed locally after the Supabase request-failure transcript hardening.
- `node --check scripts\production-deploy-preflight.mjs scripts\production-compose-deploy.mjs scripts\production-compose-rollback.mjs`, focused deploy/rollback tests, and `npm run test:production-check` passed locally after deploy transcript-redaction hardening.
- `node --check scripts\smoke-production-deploy.mjs`, focused smoke/deploy tests, and `npm run test:production-check` passed locally after production deploy smoke transcript-redaction hardening.
- `node --check scripts\check-production-hosting.mjs`, focused hosting/smoke tests, and `npm run test:production-check` passed locally after production hosting transcript-redaction hardening.
- `node --check scripts\check-production-observability.mjs`, focused observability/provider/hosting tests, and `npm run test:production-check` passed locally after production observability transcript-redaction hardening.
- `node --check scripts\check-production-providers.mjs`, focused provider/preflight tests, and `npm run test:production-check` passed locally after production provider transcript-redaction hardening.
- `node --check scripts\production-release-run-evidence.mjs`, focused release-run/preflight tests, and `npm run test:production-check` passed locally after production release-run transcript-redaction hardening.
- `node --check scripts\check-production-database.mjs`, focused database/backup tests, and `npm run test:production-check` passed locally after production database checker thrown-failure redaction hardening.
- `node --check scripts\production-compose-rollback.mjs`, focused rollback/deploy/preflight tests, and `npm run test:production-check` passed locally after production rollback transcript-redaction hardening.
- `node --check scripts\check-production-supabase.mjs`, focused Supabase/production-config tests, and `npm run test:production-check` passed locally after production Supabase transcript-redaction hardening.
- `node --check scripts\production-deploy-preflight.mjs`, focused deploy/preflight/rollback tests, and `npm run test:production-check` passed locally after production deploy preflight env-failure transcript hardening.
- `node --check scripts\check-production.mjs`, focused production/preflight tests, and `npm run test:production-check` passed locally after production environment preflight path-redaction hardening.
- `node --check scripts\production-launch-evidence.mjs scripts\production-launch-evidence-status.mjs`, focused launch-evidence/status tests, and `npm run test:production-check` passed locally after production launch evidence path-redaction hardening.
- `node --check scripts\production-launch-evidence-status.mjs`, focused launch-evidence status tests, and `npm run test:production-check` passed locally after production launch evidence status JSON hardening.
- `node --check scripts\production-launch-evidence-status.mjs`, focused launch-evidence status tests, and `npm run test:production-check` passed locally after aligning status completion with area statuses.
- `node --check scripts\launch-status.mjs scripts\production-launch-evidence-status.mjs`, focused launch-status/evidence-status tests, and `npm run test:production-check` passed locally after surfacing launch-evidence status commands in launch status.
- `npm run test:local-docker:smoke` passed locally on 2026-07-08 after stabilizing the local Docker QA stack, covering API health/readiness, registration, local admin document storage, and the web root over loopback.
- CI local Docker smoke passed on 2026-07-09 at commit 91e26b9, covering API health/readiness, registration, local admin document storage, and the web root over loopback before production Docker image gates.
- `npm run personal:ready` passed locally on 2026-07-09, covering local Docker smoke, PostgreSQL backup, restore verification, local document storage backup, and a non-destructive personal browser smoke with billing disabled when Stripe is absent.
- This is local Docker evidence only; deployed HTTPS QA with `E2E_DEPLOYED_QA=true` remains a launch gate.

## Independent Audit Findings Still Driving Next Work

| Priority | Area | Finding |
| --- | --- | --- |
| P0 | Production launch | Launch evidence remains a template and .env.production still has placeholders; real provider, hosting, backup, observability, legal, browser QA, and pentest evidence are external blockers. |
| P1 | Frontend polish | No route files remain over 450 lines, route page inline SVG findings are closed, and route-surface static dark-mode/decorative findings are clear; deployed browser and accessibility evidence remain. |

## Route Audit

| Priority | Route | Area | File | Lines | Client | Static audit finding |
| --- | --- | --- | --- | ---: | --- | --- |
| P0 | `/` | marketing | `apps/web/src/app/(marketing)/page.tsx` | 365 | no | no obvious static risk; verify in browser |
| P2 | `/about` | marketing | `apps/web/src/app/(marketing)/about/page.tsx` | 79 | no | no obvious static risk; verify in browser |
| P1 | `/accept-invite` | auth | `apps/web/src/app/(auth)/accept-invite/page.tsx` | 163 | yes | no obvious static risk; verify in browser |
| P0 | `/billing` | dashboard | `apps/web/src/app/(dashboard)/billing/page.tsx` | 232 | yes | no obvious static risk; verify in browser |
| P2 | `/blog` | marketing | `apps/web/src/app/(marketing)/blog/page.tsx` | 33 | no | no obvious static risk; verify in browser |
| P2 | `/blog/[slug]` | marketing | `apps/web/src/app/(marketing)/blog/[slug]/page.tsx` | 192 | no | no obvious static risk; verify in browser |
| P0 | `/board` | dashboard | `apps/web/src/app/(dashboard)/board/page.tsx` | 124 | yes | no obvious static risk; verify in browser |
| P0 | `/compliance` | dashboard | `apps/web/src/app/(dashboard)/compliance/page.tsx` | 150 | yes | no obvious static risk; verify in browser |
| P0 | `/compliance/[principleId]` | dashboard | `apps/web/src/app/(dashboard)/compliance/[principleId]/page.tsx` | 107 | yes | no obvious static risk; verify in browser |
| P0 | `/dashboard` | dashboard | `apps/web/src/app/(dashboard)/dashboard/page.tsx` | 143 | yes | no obvious static risk; verify in browser |
| P0 | `/deadlines` | dashboard | `apps/web/src/app/(dashboard)/deadlines/page.tsx` | 187 | yes | no obvious static risk; verify in browser |
| P0 | `/documents` | dashboard | `apps/web/src/app/(dashboard)/documents/page.tsx` | 205 | yes | no obvious static risk; verify in browser |
| P0 | `/export` | dashboard | `apps/web/src/app/(dashboard)/export/page.tsx` | 159 | yes | no obvious static risk; verify in browser |
| P1 | `/features` | marketing | `apps/web/src/app/(marketing)/features/page.tsx` | 253 | no | no obvious static risk; verify in browser |
| P1 | `/forgot-password` | auth | `apps/web/src/app/(auth)/forgot-password/page.tsx` | 108 | yes | no obvious static risk; verify in browser |
| P0 | `/login` | auth | `apps/web/src/app/(auth)/login/page.tsx` | 137 | yes | no obvious static risk; verify in browser |
| P0 | `/organisation` | dashboard | `apps/web/src/app/(dashboard)/organisation/page.tsx` | 178 | yes | no obvious static risk; verify in browser |
| P0 | `/pricing` | marketing | `apps/web/src/app/(marketing)/pricing/page.tsx` | 256 | no | no obvious static risk; verify in browser |
| P1 | `/privacy` | marketing | `apps/web/src/app/(marketing)/privacy/page.tsx` | 245 | no | no obvious static risk; verify in browser |
| P0 | `/register` | auth | `apps/web/src/app/(auth)/register/page.tsx` | 267 | yes | no obvious static risk; verify in browser |
| P0 | `/registers` | dashboard | `apps/web/src/app/(dashboard)/registers/page.tsx` | 188 | yes | no obvious static risk; verify in browser |
| P0 | `/regulator` | dashboard | `apps/web/src/app/(dashboard)/regulator/page.tsx` | 189 | yes | no obvious static risk; verify in browser |
| P1 | `/reset-password` | auth | `apps/web/src/app/(auth)/reset-password/page.tsx` | 185 | yes | no obvious static risk; verify in browser |
| P1 | `/team` | dashboard | `apps/web/src/app/(dashboard)/team/page.tsx` | 436 | yes | no obvious static risk; verify in browser |
| P1 | `/terms` | marketing | `apps/web/src/app/(marketing)/terms/page.tsx` | 264 | no | no obvious static risk; verify in browser |
| P1 | `/verify-email` | auth | `apps/web/src/app/(auth)/verify-email/page.tsx` | 190 | yes | no obvious static risk; verify in browser |

## API And Backend Audit

| Route group | File | Lines | Guard signals | Nearby tests | Audit note |
| --- | --- | ---: | --- | ---: | --- |
| `auth` | `apps/api/src/routes/auth/index.ts` | 263 | public/partial by design | 10 | preserve current guard and tenant boundary |
| `billing` | `apps/api/src/routes/billing/index.ts` | 96 | auth, owner actions | 7 | preserve current guard and tenant boundary |
| `board-members` | `apps/api/src/routes/board-members/index.ts` | 64 | auth, subscription, admin writes | 2 | preserve current guard and tenant boundary |
| `compliance` | `apps/api/src/routes/compliance/index.ts` | 177 | auth, subscription, admin writes | 5 | preserve current guard and tenant boundary |
| `dashboard` | `apps/api/src/routes/dashboard/index.ts` | 101 | auth, subscription | 1 | preserve current guard and tenant boundary |
| `deadlines` | `apps/api/src/routes/deadlines/index.ts` | 107 | auth, subscription, admin writes | 6 | preserve current guard and tenant boundary |
| `documents` | `apps/api/src/routes/documents/index.ts` | 406 | auth, subscription, admin writes | 6 | preserve current guard and tenant boundary |
| `export` | `apps/api/src/routes/export/index.ts` | 215 | auth, subscription, plan gate | 3 | preserve current guard and tenant boundary |
| `governance-registers` | `apps/api/src/routes/governance-registers/index.ts` | 243 | auth, subscription, admin writes | 2 | preserve current guard and tenant boundary |
| `health` | `apps/api/src/routes/health/index.ts` | 221 | public/partial by design | 2 | preserve current guard and tenant boundary |
| `organisations` | `apps/api/src/routes/organisations/index.ts` | 39 | auth, subscription, admin writes | 3 | preserve current guard and tenant boundary |
| `team` | `apps/api/src/routes/team/index.ts` | 291 | auth, subscription | 5 | preserve current guard and tenant boundary |

## Launch Evidence Blockers

- Real production secrets and provider values are not committed and must be supplied from the operator secret store.
- Production hosting, DNS, TLS, reverse proxy, and public HTTPS smoke evidence remain external launch gates.
- Production PostgreSQL backup and restore evidence is required before real charity data.
- Production Supabase private bucket, authenticated service-role storage probe, backup, and restore evidence is required.
- Stripe live products/prices/webhook and Resend sender-domain evidence are required.
- Observability, uptime checks, alert routing, incident owner, and test-alert evidence are required.
- Solicitor/governance/privacy review and external penetration test are required before real charity data.

Local-state note: This generated section reflects local non-committed files. This checkout has no `.env.production` and no committed launch evidence; a partially configured production workstation may instead report `ENV_INCOMPLETE` with operator-supplied values still outstanding.

### Launch Evidence Ledger

- .charitypilot-launch-evidence/production-launch-evidence.json has not been created yet.
- Create it with:  npm run check:production:evidence:init
- Strict validation: `npm run check:production:evidence -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json`
- Strict validation JSON: `npm run check:production:evidence -- --json --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json`

### Local Personal Data Safety

- Command: `npm run personal:ready`
- Docs: `docs/personal-local-use.md`
- Purpose: Non-destructive local confidence gate for one-person use without Stripe, Supabase, Resend, public hosting, or payments.
- Proves:
  - local Docker API/web/PostgreSQL boot over loopback
  - seeded local owner sign-in
  - local document storage upload/download
  - PostgreSQL backup and restore verification
  - local document storage backup copy
  - core personal-use browser smoke with billing safely disabled when Stripe is absent
- Warning: Run destructive browser tests only through npm run test:e2e. The managed runner provisions and proves a separate disposable database and refuses personal targets; never bypass it with direct Playwright or weakened identity guards.
- Launch evidence limit: This protects local personal use only. It does not replace production provider, deployed HTTPS, legal, pentest, backup/restore, or final signoff evidence.

### Deployed Browser QA Commands

- Required environment:
  - `E2E_DEPLOYED_QA=true`
  - `E2E_WEB_URL=https://app.charitypilot.ie`
  - `E2E_API_URL=https://api.charitypilot.ie`
  - `E2E_OWNER_EMAIL from the approved non-sensitive test workspace`
  - `E2E_OWNER_PASSWORD from the approved non-sensitive test workspace`
- Preflight: `npm run check:production:browser-qa-env`
- Preflight JSON: `npm run check:production:browser-qa-env -- --json`
- Responsive: `npm run test:e2e:responsive`
- Focused responsive chunks:
  - `npm run test:e2e:responsive:public:desktop`
  - `npm run test:e2e:responsive:public:mobile`
  - `npm run test:e2e:responsive:dashboard:desktop`
  - `npm run test:e2e:responsive:dashboard:mobile`
- Accessibility: `npm run test:e2e -- tests/accessibility.spec.ts`
- Cross-browser responsive: `npm run test:e2e:deployed:responsive:cross-browser`
- Cross-browser accessibility: `npm run test:e2e:deployed:accessibility:cross-browser`
- iOS Safari: Record real iOS Safari manual or cloud-device evidence for the promoted release.
- Evidence target: Record the preflight command and success marker in browserQa.checks.browser-qa-completed, including Deployed browser QA environment preflight passed; record the remaining outputs under browserQa.checks.* in the production launch evidence ledger.

### Production Launch Command Sequence

- Core preflight: `npm run check:production -- --production-env-file=.env.production`
- GitHub production environment: `npm run check:production:github-env -- --environment=production`
- GitHub production environment JSON: `npm run check:production:github-env -- --environment=production --json`
- GitHub production secret store: `npm run check:production:github-secrets -- --environment=production`
- GitHub production secret-store JSON: `npm run check:production:github-secrets -- --environment=production --json`
- Hosting/DNS/TLS: `npm run check:production:hosting -- --production-env-file=.env.production`
- Database source identity capture: `npm run check:production:database -- --production-env-file=.env.production --capture-source-identity --json --expected-release-commit-sha=PROMOTED_RELEASE_COMMIT_SHA`
- Database backup/restore: `npm run check:production:database -- --production-env-file=.env.production --recovery-set-id=RECOVERY_SET_ID --expected-source-database-identity-sha256=EXTERNAL_SHA256 --expected-release-commit-sha=PROMOTED_RELEASE_COMMIT_SHA --backup-output-dir=/mnt/encrypted/charitypilot/recovery/RECOVERY_SET_ID --keep-backup --json`
- Supabase storage: `npm run check:production:supabase -- --production-env-file=.env.production`
- Joint document recovery: `npm run check:production:document-recovery -- --manifest-file=.charitypilot-launch-evidence/document-recovery-manifest.json --expected-recovery-manifest-sha256=EXTERNAL_SHA256 --expected-source-binding-sha256=EXTERNAL_SHA256 --expected-database-dump-sha256=EXTERNAL_SHA256 --expected-object-backup-manifest-sha256=EXTERNAL_SHA256 --expected-source-capture-report-sha256=EXTERNAL_SHA256 --expected-source-database-identity-sha256=EXTERNAL_SHA256 --expected-source-object-store-identity-sha256=EXTERNAL_SHA256 --expected-metadata-inventory-sha256=EXTERNAL_SHA256 --expected-object-inventory-sha256=EXTERNAL_SHA256 --expected-restored-metadata-inventory-sha256=EXTERNAL_SHA256 --expected-restored-object-inventory-sha256=EXTERNAL_SHA256 --expected-storage-deletion-inventory-sha256=EXTERNAL_SHA256 --expected-restored-storage-deletion-inventory-sha256=EXTERNAL_SHA256 --expected-recovery-event-inventory-sha256=EXTERNAL_SHA256 --expected-restored-recovery-event-inventory-sha256=EXTERNAL_SHA256 --expected-production-document-count=EXTERNAL_POSITIVE_COUNT --expected-storage-deletion-count=EXTERNAL_NONNEGATIVE_COUNT --expected-pending-storage-deletion-count=EXTERNAL_NONNEGATIVE_COUNT --expected-dead-letter-storage-deletion-count=EXTERNAL_NONNEGATIVE_COUNT --expected-processed-storage-deletion-count=EXTERNAL_NONNEGATIVE_COUNT --expected-recovery-event-count=EXTERNAL_NONNEGATIVE_COUNT --expected-source-metadata-captured-at=EXTERNAL_TIMESTAMP --expected-restored-metadata-captured-at=EXTERNAL_TIMESTAMP --expected-source-object-inventory-captured-at=EXTERNAL_TIMESTAMP --expected-restored-object-inventory-captured-at=EXTERNAL_TIMESTAMP --expected-source-metadata-capture-transaction-id=EXTERNAL_TRANSACTION_ID --expected-restored-metadata-capture-transaction-id=EXTERNAL_TRANSACTION_ID --expected-maximum-document-proof-age-minutes=EXTERNAL_MAXIMUM_AGE_MINUTES --expected-exercise-id=EXTERNAL_ID --expected-recovery-set-id=EXTERNAL_ID --json`
- Stripe/Resend providers: `npm run check:production:providers -- --production-env-file=.env.production`
- Observability alerting: `npm run check:production:observability -- --production-env-file=.env.production`
- Deployed browser QA env preflight: `npm run check:production:browser-qa-env`
- Deployed browser QA env preflight JSON: `npm run check:production:browser-qa-env -- --json`
- Deploy preflight: `npm run deploy:preflight -- --production-env-file=.env.production`
- Deploy production: `npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=/secure/charitypilot/cutovers`
- Rollback rehearsal: `npm run deploy:rollback -- --production-env-file=.env.production --rollback-digest-file=release-image-digests.previous.env --schema-compatibility-attestation-file=/secure/schema-compatibility-attestation.json --backup-output-dir=/secure/charitypilot/rollback-cutovers`
- Release-run evidence: `npm run check:production:release-run -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json`
- Release-run evidence JSON: `npm run check:production:release-run -- --json --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json`
- Final evidence validation: `npm run check:production:evidence -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json`
- Final evidence validation JSON: `npm run check:production:evidence -- --json --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json`

### Protected Final Launch Evidence Workflow

- Upload workflow file: `.github/workflows/upload-production-launch-evidence.yml`
- Workflow file: `.github/workflows/production-launch-evidence.yml`
- GitHub environment: `production`
- Required input: `evidence_artifact_run_id`
- Default evidence artifact: `production-launch-evidence`
- Default evidence file: `production-launch-evidence.json`
- Validation artifact: `production-launch-evidence-validation`
- Validation artifact files:
  - `production-launch-evidence-validation.log`
  - `production-release-run-evidence.json`
  - `production-launch-evidence-validation.json`
- Prepare/upload: `npm run prepare:production:evidence-upload -- --json | gh workflow run upload-production-launch-evidence.yml --ref master --json`
- Upload evidence target: Use the successful upload-production-launch-evidence.yml run id as evidence_artifact_run_id for the protected validation workflow.
- Run: `gh workflow run production-launch-evidence.yml --ref master -f evidence_artifact_run_id=EVIDENCE_ARTIFACT_RUN_ID -f evidence_artifact_name=production-launch-evidence -f evidence_file_name=production-launch-evidence.json`
- Evidence target: Record the protected workflow run URL and production-launch-evidence-validation artifact, including pass/fail command statuses, the text log, and JSON validation files, in the launch evidence ledger.

### Release Image Promotion

- GitHub environment: `production`
- Required GitHub environment variables:
  - `NEXT_PUBLIC_API_URL=https://api.charitypilot.ie`
  - `DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST=<managed-postgres-hostname>`
- Configure with:
  - `gh variable set NEXT_PUBLIC_API_URL --env production --repo jasperfordesq-ai/charity-governance --body "https://api.charitypilot.ie"`
  - `gh variable set DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST --env production --repo jasperfordesq-ai/charity-governance --body "<managed-postgres-hostname>"`
- Workflow: `gh workflow run release-images.yml --ref master`
- Watch: `gh run watch RELEASE_RUN_ID --exit-status`
- Preflight GitHub environment: `npm run check:production:github-env -- --environment=production`
- Preflight GitHub environment JSON: `npm run check:production:github-env -- --environment=production --json`
- Digest artifact: `release-image-digests.env`
- Evidence target: Copy digest-pinned CHARITYPILOT_*_IMAGE and CHARITYPILOT_WEB_BUILD_* values into the production secret source and release evidence ledger.

### Final Signoff Requirements

- Required roles: `engineering`, `operations`, `security`, `legalCompliance`, `business`
- External reviews:
  - solicitor review
  - governance review
  - privacy review
  - external penetration test
  - critical/high findings remediated or formally accepted
- Release binding: Every final signoff evidence entry must bind to release.commitSha for the promoted release.
- Evidence target: Record approvals under finalSignoff and finalSignoff.approvals.* in the production launch evidence ledger.
- Legal posture: Review-ready, source-cited, and not legal advice; no legal-certainty or guarantee claims.

### Repository State For Launch Evidence

- Do not use this committed audit file as proof that the current checkout is clean, synced, or release-bound.
- Run `npm run launch:status -- --json` and inspect `repositoryState` immediately before collecting external launch evidence.
- Required live state: branch `master`, clean worktree, synced with `origin/master`, and `launchEvidenceRisk: clean_synced`.
- Record the exact final release commit in the ignored launch evidence ledger after the release workflow and deployed checks complete.

### Local Production Environment State

- Phase: `NO_ENV`
- You have not created a production environment file yet.
- This generated section reflects local non-committed files. This checkout has no `.env.production` and no committed launch evidence; a partially configured production workstation may instead report `ENV_INCOMPLETE` with operator-supplied values still outstanding.

### Launch Progress Summary

- Production values complete: 0 / 27 (27 remaining)
- Strict launch gates complete: 0 / 118 (118 remaining, 0% complete)
- approvedForLaunch: false

## Irish Compliance Source Posture

The matrix must stay source-cited and review-ready. The following official sources were used as the current verification set for this audit; refresh them again before production legal signoff.

| Source | Owner | URL |
| --- | --- | --- |
| Charities Governance Code | Charities Regulator | https://www.charitiesregulator.ie/en/information-for-charities/charities-governance-code |
| Toolkit and templates | Charities Regulator | https://www.charitiesregulator.ie/en/information-for-charities/charities-governance-code/toolkit-and-templates |
| Compliance Record Form | Charities Regulator | https://www.charitiesregulator.ie/en/guidance/forms-and-templates/forms |
| Annual report submission guidance | Charities Regulator | https://www.charitiesregulator.ie/en/information-for-charities/annual-report-how-to-submit |
| Charities Act 2009 revised | Law Reform Commission | https://revisedacts.lawreform.ie/eli/2009/act/6/front/revised/en/html |
| Charities (Amendment) Act 2024 commencement table | Irish Statute Book | https://www.irishstatutebook.ie/isbc/2024_21.html |
| S.I. No. 10/2025 commencement order | Irish Statute Book | https://www.irishstatutebook.ie/eli/2025/si/10/made/en/print |
| GDPR accountability obligation | Data Protection Commission | https://www.dataprotection.ie/en/organisations/know-your-obligations/accountability-obligation |
| Safety Statement and Risk Assessment | Health and Safety Authority | https://www.hsa.ie/topics/managing_health_and_safety/safety_statement_and_risk_assessment/ |
| Child safeguarding statement relevance | Tusla | https://www.tusla.ie/children-first/organisations/what-is-a-child-safeguarding-statement/who-needs-to-have-a-child-safeguarding-statement/ |
| Protected disclosures employer obligations | Workplace Relations Commission | https://www.workplacerelations.ie/en/what_you_should_know/employer-obligations/protection-of-whistleblowers/new-obligations-under-the-protected-disclosures-amendment-act-2022/ |

## Next Completion Sequence

1. Close launch evidence: real secret store, provider accounts, hosting, DNS/TLS, backups, observability, release evidence, and external signoffs.
2. Complete deployed browser QA across every route in desktop/mobile and light/dark mode, then attach production-only evidence.
3. Use deployed QA findings to fix route-specific state or visual regressions with shared primitives for loading, empty, error, locked-feature, review-warning, status, source, evidence, and sticky form actions.
4. Keep compliance source metadata, professional-review flags, and conditional obligation prioritisation review-ready across deadlines, registers, evidence, exports, and regulator workflows without creating legal-certainty claims.
5. Run deployed HTTPS browser QA, accessibility checks in both themes, tenant-isolation regression tests, document privacy checks, billing/email provider checks, and external penetration testing.
