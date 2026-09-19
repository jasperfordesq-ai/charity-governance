# CharityPilot MCP connector — read everything (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every readable CharityPilot route answerable through the connector, with the personal-data gate covering all of it, so any question about the charity that can be answered by reading has a tool behind it.

**Architecture:** The tool registry gains validated inputs (pagination, path parameters, filters) built without a new dependency. The field policy gains two things: entries for every model these routes return, and a *shape* concept for the four payloads that mix models, which a single per-model allowlist cannot express. A coverage test then requires every `GET` route under `/api/v1` to be either a tool or a listed exclusion carrying a reason.

**Tech Stack:** TypeScript, Node 22 built-in test runner, `@modelcontextprotocol/sdk` 1.30.0, Playwright for the live harness.

**Spec:** `docs/superpowers/specs/2026-09-19-charitypilot-mcp-full-access-design.md`, Phase 1. Phase 0 plan and its outcome: `docs/superpowers/plans/2026-09-19-charitypilot-mcp-live-harness.md`.

## Global Constraints

- **`mcp/` stays outside the npm workspace globs.** Never `npm install --prefix mcp` from the root. Use `cd mcp && npm install`.
- **No task may change the root `package-lock.json`.** Another session is active in this working tree; commit with an explicit pathspec and check `git status` before and after every commit. A plain `git commit` takes the whole index, including their staged files.
- **No new runtime dependency.** The connector has two, and that is a stated security property. Input validation is hand-written. If a later phase needs a schema library for write bodies, that is a decision for that phase.
- **The gate is an allowlist, deny by default.** Three API services spread whole Prisma rows into responses, so a column added next year ships to clients automatically. The allowlist is the only thing standing in front of it.
- **No tool input schema may contain the string `organisationId`.** The tenant is derived from the session, never supplied. Existing test enforces this.
- **TLS verification must never be disabled**, and do not write either of the two strings the `tls-verification-disabled` SAST rule matches, in code or in prose — the scanner reads documentation too.
- **A green test proves nothing without a canary.** Every new gate assertion must be shown to fail when the policy it guards is deliberately broken.

## Route facts this plan is built on

Established by reading the API, not inferred:

- **Envelope shape is inconsistent and not guessable from the route name.** `sendSuccess` returns `{data}`. But `/documents`, `/board-members`, `/deadlines`, `/deadlines/history`, `/team`, `/members` and `/auth/me` return their value bare. `/documents` and `/deadlines` happen to contain a `data` key because the service builds a pagination envelope itself, which is not the same thing. `/members` is a bare array.
- **`/governing-acts` embeds full `Resolution` rows** under `resolutions`. The current policy drops them because a relation is not in the allowlist, which is correct and must stay true.
- **`/governance-registers/summary` returns six integers and no records.** An earlier note claimed it mixed models; it does not.
- **Four payloads genuinely mix models:** `/dashboard`, `/governing-acts/board-submissions`, `/team`, and `/governing-acts/voids` (whose `snapshot` is an opaque JSON blob containing a whole act and its resolutions).
- **`requireCompletePlan` gates every GET under `/governance-registers`, `/governing-acts` and `/members`.** Nothing else. A tool for these must report a 403 as a plan limitation, not as a failure.
- **A MEMBER is refused** on `/integrations/*`, `/team/security-audit`, `/team/members/:id/sessions`, `/deadlines/reminder-history` and `/documents/storage-deletions/dead-letter`.

### The gap this phase closes

`dashboard_overview` ships today with no model, so `runTool` returns it raw and the gate never touches it. Its payload carries whole `Deadline` rows via a spread, `boardAlerts[].memberName`, and `recentActivity[].description` strings built by interpolation, for example `Updated board member 'Aoife Chairperson'`, plus `userName` from a `User` record that no policy classifies. Free text built this way cannot be protected by a field allowlist, so the shape filter withholds the whole `description` and `userName` when the gate is closed.

---

### Task 1: Validated tool inputs

**Files:**
- Create: `mcp/src/tool-input.ts`
- Modify: `mcp/src/tools.ts`, `mcp/src/server.ts`
- Test: `mcp/src/tests/tool-input.test.ts` (create), `mcp/src/tests/tools.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ParamSpec` and `buildPath(tool, args)`.

```ts
export type ParamSpec =
  | { kind: 'page' }                                   // integer >= 1, query `page`, default absent
  | { kind: 'pageSize' }                               // integer 1..100, query `pageSize`
  | { kind: 'year' }                                   // integer 2000..2200, query `year`
  | { kind: 'enum'; name: string; values: readonly string[] }
  | { kind: 'flag'; name: string }                     // boolean, serialised as the literal "true"
  | { kind: 'id'; name: string };                      // path segment, 1..160 of [A-Za-z0-9_-]
```

`ToolDefinition` gains `params?: readonly ParamSpec[]`. A path containing `:name` takes its value from an `id` param of that name; every other kind appends a query parameter. `inputSchema` is generated from `params` so the advertised schema and the validator cannot drift.

- [ ] **Step 1: Write the failing tests**

Create `mcp/src/tests/tool-input.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPath, inputSchemaFor, type ParamSpec } from '../tool-input.js';

const PAGED: readonly ParamSpec[] = [{ kind: 'page' }, { kind: 'pageSize' }];

test('a tool with no params ignores arguments entirely', () => {
  assert.equal(buildPath('/api/v1/dashboard', [], { page: 3 }), '/api/v1/dashboard');
});

test('pagination is appended only when supplied', () => {
  assert.equal(buildPath('/api/v1/documents', PAGED, {}), '/api/v1/documents');
  assert.equal(buildPath('/api/v1/documents', PAGED, { page: 2 }), '/api/v1/documents?page=2');
  assert.equal(
    buildPath('/api/v1/documents', PAGED, { page: 2, pageSize: 10 }),
    '/api/v1/documents?page=2&pageSize=10',
  );
});

test('pagination bounds are enforced', () => {
  for (const bad of [0, -1, 1.5, '2', null, Number.NaN]) {
    assert.throws(() => buildPath('/api/v1/documents', PAGED, { page: bad }), /page/i, String(bad));
  }
  assert.throws(() => buildPath('/api/v1/documents', PAGED, { pageSize: 101 }), /pageSize/i);
  assert.throws(() => buildPath('/api/v1/documents', PAGED, { pageSize: 0 }), /pageSize/i);
});

test('an unknown argument is refused rather than ignored', () => {
  assert.throws(() => buildPath('/api/v1/documents', PAGED, { organisationId: 'x' }), /unknown/i);
});

test('a path parameter is substituted and url-encoded', () => {
  const params: readonly ParamSpec[] = [{ kind: 'id', name: 'standardId' }];
  assert.equal(
    buildPath('/api/v1/compliance/records/:standardId', params, { standardId: 'abc-123' }),
    '/api/v1/compliance/records/abc-123',
  );
});

test('a path parameter is required and constrained', () => {
  const params: readonly ParamSpec[] = [{ kind: 'id', name: 'standardId' }];
  assert.throws(() => buildPath('/api/v1/compliance/records/:standardId', params, {}), /standardId/);
  for (const bad of ['../../etc', 'a/b', 'a?b', '', 'x'.repeat(161)]) {
    assert.throws(
      () => buildPath('/api/v1/compliance/records/:standardId', params, { standardId: bad }),
      /standardId/,
      bad,
    );
  }
});

test('a path parameter can never inject a second path segment or a query', () => {
  const params: readonly ParamSpec[] = [{ kind: 'id', name: 'id' }];
  // The allowlist above already refuses these, which is the point: the guard is
  // on the character set, not on escaping after the fact.
  for (const bad of ['1/../../owner/tenants', '1?x=y', '1#frag']) {
    assert.throws(() => buildPath('/api/v1/documents/:id', params, { id: bad }), /id/, bad);
  }
});

test('an enum accepts only its own values', () => {
  const params: readonly ParamSpec[] = [
    { kind: 'enum', name: 'kind', values: ['BOARD_MEETING', 'ANNUAL_GENERAL_MEETING'] },
  ];
  assert.equal(
    buildPath('/api/v1/governing-acts', params, { kind: 'BOARD_MEETING' }),
    '/api/v1/governing-acts?kind=BOARD_MEETING',
  );
  assert.throws(() => buildPath('/api/v1/governing-acts', params, { kind: 'OTHER' }), /kind/);
});

test('a year is bounded', () => {
  const params: readonly ParamSpec[] = [{ kind: 'year' }];
  assert.equal(buildPath('/api/v1/x', params, { year: 2026 }), '/api/v1/x?year=2026');
  assert.throws(() => buildPath('/api/v1/x', params, { year: 1999 }), /year/);
});

test('a flag is serialised as the literal the API checks for', () => {
  const params: readonly ParamSpec[] = [{ kind: 'flag', name: 'includeFormer' }];
  assert.equal(
    buildPath('/api/v1/members', params, { includeFormer: true }),
    '/api/v1/members?includeFormer=true',
  );
  assert.equal(buildPath('/api/v1/members', params, { includeFormer: false }), '/api/v1/members');
  assert.throws(() => buildPath('/api/v1/members', params, { includeFormer: 'yes' }), /includeFormer/);
});

test('the advertised schema is generated from the same params the validator uses', () => {
  const schema = inputSchemaFor(PAGED) as {
    type: string;
    properties: Record<string, unknown>;
    additionalProperties: boolean;
    required?: string[];
  };
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['page', 'pageSize']);
  assert.equal(schema.required, undefined, 'pagination is optional');

  const withId = inputSchemaFor([{ kind: 'id', name: 'standardId' }]) as { required?: string[] };
  assert.deepEqual(withId.required, ['standardId'], 'a path parameter is required');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mcp && npm test`
Expected: FAIL — `../tool-input.js` does not exist.

- [ ] **Step 3: Implement `mcp/src/tool-input.ts`**

```ts
/**
 * Input validation for tool arguments, hand-written on purpose.
 *
 * The connector has two runtime dependencies and that is a stated security
 * property: every dependency is code that runs on the operator's machine with
 * their credential in reach. The inputs here are integers, enums and opaque
 * ids, which is not enough surface to justify a third.
 *
 * Validation is deny-by-default in both directions: an argument the tool does
 * not declare is refused rather than ignored, and a declared argument must
 * match its kind exactly. Ignoring an unknown argument would let a caller
 * believe a filter had been applied when it had not.
 */
export type ParamSpec =
  | { kind: 'page' }
  | { kind: 'pageSize' }
  | { kind: 'year' }
  | { kind: 'enum'; name: string; values: readonly string[] }
  | { kind: 'flag'; name: string }
  | { kind: 'id'; name: string };

// A path parameter is interpolated into a URL path, so its character set is the
// guard rather than escaping applied afterwards: no slash, no dot, no question
// mark, no hash means it cannot open a new path segment, traverse upwards, or
// start a query string however it is concatenated.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

export function paramName(spec: ParamSpec): string {
  switch (spec.kind) {
    case 'page': return 'page';
    case 'pageSize': return 'pageSize';
    case 'year': return 'year';
    default: return spec.name;
  }
}

function integerIn(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}.`);
  }
  return value;
}

export function inputSchemaFor(params: readonly ParamSpec[]): object {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const spec of params) {
    const name = paramName(spec);
    switch (spec.kind) {
      case 'page':
        properties[name] = { type: 'integer', minimum: 1, description: 'Page number, from 1.' };
        break;
      case 'pageSize':
        properties[name] = { type: 'integer', minimum: 1, maximum: 100, description: 'Records per page, up to 100.' };
        break;
      case 'year':
        properties[name] = { type: 'integer', minimum: 2000, maximum: 2200, description: 'Reporting year.' };
        break;
      case 'enum':
        properties[name] = { type: 'string', enum: [...spec.values] };
        break;
      case 'flag':
        properties[name] = { type: 'boolean' };
        break;
      case 'id':
        properties[name] = { type: 'string', description: 'Identifier returned by a list tool.' };
        required.push(name);
        break;
    }
  }
  const schema: Record<string, unknown> = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

export function buildPath(
  path: string,
  params: readonly ParamSpec[],
  args: Record<string, unknown>,
): string {
  const declared = new Set(params.map(paramName));
  for (const key of Object.keys(args)) {
    if (!declared.has(key)) {
      throw new Error(
        `Unknown argument "${key}". This tool accepts: ${[...declared].join(', ') || 'no arguments'}.`,
      );
    }
  }

  let out = path;
  const query: string[] = [];

  for (const spec of params) {
    const name = paramName(spec);
    const value = args[name];

    if (spec.kind === 'id') {
      if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
        throw new Error(`${name} must be an identifier of letters, digits, hyphens or underscores.`);
      }
      out = out.replace(`:${name}`, encodeURIComponent(value));
      continue;
    }

    if (value === undefined) continue;

    switch (spec.kind) {
      case 'page':
        query.push(`page=${integerIn(name, value, 1, Number.MAX_SAFE_INTEGER)}`);
        break;
      case 'pageSize':
        query.push(`pageSize=${integerIn(name, value, 1, 100)}`);
        break;
      case 'year':
        query.push(`year=${integerIn(name, value, 2000, 2200)}`);
        break;
      case 'enum':
        if (typeof value !== 'string' || !spec.values.includes(value)) {
          throw new Error(`${name} must be one of: ${spec.values.join(', ')}.`);
        }
        query.push(`${name}=${encodeURIComponent(value)}`);
        break;
      case 'flag':
        if (typeof value !== 'boolean') throw new Error(`${name} must be true or false.`);
        // The API tests for the literal string "true"; anything else means off,
        // so a false flag is omitted rather than sent as "false".
        if (value) query.push(`${name}=true`);
        break;
    }
  }

  if (out.includes('/:')) {
    throw new Error(`Path parameter missing for ${out}.`);
  }
  return query.length > 0 ? `${out}?${query.join('&')}` : out;
}
```

- [ ] **Step 4: Wire it into the registry and server**

In `mcp/src/tools.ts`, add `params?: readonly ParamSpec[]` to `ToolDefinition`, drop the hand-written `NO_INPUT` in favour of `inputSchemaFor(tool.params ?? [])` computed where the list is built, and change `runTool`:

```ts
export async function runTool(
  tool: ToolDefinition,
  client: ApiClient,
  allowPersonalData: boolean,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const path = buildPath(tool.path, tool.params ?? [], args);
  const raw = await client.get<unknown>(path);
  return applyPolicy(tool, raw, allowPersonalData);
}
```

`applyPolicy` arrives in Task 2; for this task keep the existing `if (!tool.model) return raw;` body and rename in Task 2.

In `mcp/src/server.ts`, generate the advertised schema and pass arguments through:

```ts
export function buildToolList() {
  return TOOLS.map(({ name, description, params }) => ({
    name,
    description,
    inputSchema: inputSchemaFor(params ?? []),
  }));
}
```

```ts
const args = (request.params.arguments ?? {}) as Record<string, unknown>;
const result = await runTool(tool, client, config.allowPersonalData, args);
```

- [ ] **Step 5: Keep the existing guarantees**

In `mcp/src/tests/tools.test.ts`, the existing assertion that no input schema mentions `organisationId` must now walk the *generated* schemas. Update it to call `buildToolList()` rather than reading `inputSchema` off the registry, so it tests what is actually advertised.

- [ ] **Step 6: Run the tests**

Run: `cd mcp && npm test`
Expected: PASS, with the pre-existing `organisationId` and tool-route tests still green.

- [ ] **Step 7: Commit**

```bash
git status --porcelain
git commit -F- -- mcp/src/tool-input.ts mcp/src/tools.ts mcp/src/server.ts mcp/src/tests/tool-input.test.ts mcp/src/tests/tools.test.ts <<'MSG'
feat(mcp): give tools validated inputs without a new dependency

Pagination, path parameters and filters are validated by hand rather than by
a schema library: the connector has two runtime dependencies and that is a
security property, and integers, enums and opaque ids are not enough surface
to justify a third.

Validation denies by default in both directions. An argument a tool does not
declare is refused rather than ignored, because ignoring it would let a
caller believe a filter had been applied when it had not. A path parameter
is constrained to a character set that cannot open a new path segment,
traverse upwards or begin a query string, so the guard does not depend on
escaping applied afterwards.

The advertised schema is generated from the same declarations the validator
reads, so the two cannot drift.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 2: Extend the field policy, and add shapes for mixed payloads

**Files:**
- Modify: `mcp/src/field-policy.ts`, `mcp/src/tools.ts`
- Test: `mcp/src/tests/field-policy.test.ts`, `mcp/src/tests/schema-drift.test.ts`

**Interfaces:**
- Consumes: `ModelName` (existing).
- Produces: `ModelName` widened; `ShapeName = 'dashboard' | 'team' | 'boardSubmissions' | 'governingActVoid' | 'complianceSignoff'`; `applyPolicy(tool, value, allowPersonalData)`.

A tool declares **either** `model` (every record in the payload is one model) **or** `shape` (the payload mixes models). Shapes are built from the same per-model record filters, so there is one allowlist per model and no second place to update.

- [ ] **Step 1: Write the failing tests**

Append to `mcp/src/tests/field-policy.test.ts`. The dashboard case is the one that matters most, because it is the gap this phase closes:

```ts
test('the dashboard withholds interpolated free text and whole deadline rows', () => {
  const raw = {
    data: {
      compliance: { overallPercent: 42 },
      upcomingDeadlines: [
        { id: 'd1', title: 'File the B1', dueDate: '2026-09-30', description: 'ask Aoife',
          generationInputs: { secret: 'x' }, isComplete: false },
      ],
      boardAlerts: [{ memberId: 'b1', memberName: 'Aoife Chairperson', alertType: 'conduct_unsigned' }],
      recentActivity: [
        { id: 'board-member-b1', type: 'board_member', timestamp: '2026-03-02T00:00:00.000Z',
          description: "Updated board member 'Aoife Chairperson'", userId: 'u1', userName: 'Staff Person' },
      ],
    },
  };
  const filtered = applyShapePolicy('dashboard', raw, false) as any;

  assert.equal(filtered.data.compliance.overallPercent, 42, 'aggregate figures survive');
  assert.equal(filtered.data.upcomingDeadlines[0].title, 'File the B1');
  assert.ok(!('generationInputs' in filtered.data.upcomingDeadlines[0]), 'unlisted deadline columns are dropped');
  assert.ok(!('description' in filtered.data.upcomingDeadlines[0]), 'deadline free text is withheld');

  const serialised = JSON.stringify(filtered);
  assert.ok(!serialised.includes('Staff Person'), 'a staff name must not survive the closed gate');
  assert.ok(!serialised.includes('Updated board member'), 'interpolated free text must not survive');
  assert.ok(serialised.includes('conduct_unsigned'), 'the alert type is the useful part and survives');
});

test('the dashboard returns everything when the gate is open', () => {
  const raw = { data: { compliance: {}, upcomingDeadlines: [], boardAlerts: [],
    recentActivity: [{ description: "Updated board member 'Aoife'", userName: 'Staff Person' }] } };
  const filtered = applyShapePolicy('dashboard', raw, true) as any;
  assert.equal(filtered.data.recentActivity[0].userName, 'Staff Person');
});

test('the team payload filters members and invites by their own models', () => {
  const raw = {
    members: [{ id: 'u1', email: 'a@b.test', name: 'Staff Person', role: 'ADMIN', activeSessionCount: 2 }],
    invites: [{ id: 'i1', email: 'new@b.test', role: 'MEMBER', invitedByName: 'Staff Person' }],
  };
  const closed = JSON.stringify(applyShapePolicy('team', raw, false));
  assert.ok(!closed.includes('Staff Person'));
  assert.ok(!closed.includes('a@b.test'));
  assert.ok(closed.includes('ADMIN'), 'roles are the governance-relevant part and survive');
});

test('a void withholds its snapshot blob, which an allowlist cannot see inside', () => {
  const raw = { data: [{ id: 'v1', reference: 'BM-1', voidedAt: '2026-03-02',
    voidedByEmail: 'owner@example.org', reason: 'duplicate of BM-2',
    snapshot: { title: 'Removal of Jane Doe', resolutions: [{ text: 'Jane Doe removed' }] } }] };
  const closed = JSON.stringify(applyShapePolicy('governingActVoid', raw, false));
  assert.ok(!closed.includes('Jane Doe'), 'the opaque blob must not pass the closed gate');
  assert.ok(!closed.includes('owner@example.org'));
  assert.ok(closed.includes('BM-1'), 'the reference survives so the void is still traceable');
});
```

Then extend `mcp/src/tests/schema-drift.test.ts`: widen its hardcoded `MUST_BE_GATED` to every model now in the policy, so dropping one still fails the build. Keep it hardcoded — a list read from the artifact under test agrees with it however wrong it becomes.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mcp && npm test`
Expected: FAIL — `applyShapePolicy` is not exported and the new models are absent.

- [ ] **Step 3: Extend the policy**

Add allowlist entries for every model these routes return. Personal data stays out by default; the flags in the route inventory are the starting point, and each judgement gets a one-line comment stating why, matching the style of the existing entries. Models to add: `RiskRecord`, `FundraisingRecord`, `FinancialControlReview`, `AnnualReportReadiness`, `ComplianceRecord`, `ComplianceSignoff`, `Deadline`, `Document`, `Resolution`, `GovernancePrinciple`, `GovernanceStandard`, `Organisation`, `User`, `TeamInvite`, `GoverningActVoid`, `Subscription`.

Decisions to make explicitly in comments, because they are the reversible ones:

- `RiskRecord.owner`, `FinancialControlReview.reviewedBy` and `FundraisingRecord.thirdPartyFundraiser` are **withheld**: each is a natural person's name, and unlike a trustee they are on no public register.
- `Deadline.title` is **safe** and `Deadline.description` is **withheld**. The title is the obligation, the description is an open box.
- `Document.name` is **safe**, `Document.owner` and `Document.description` are **withheld**. A document's name is governance evidence; its owner is a person.
- `User.name` and `User.email` are **withheld**; `User.role`, `lifecycleStatus` and `emailVerified` are safe. Who holds an account is personal; what authority the account carries is governance.
- `Resolution.text` and `abstentions` are **withheld**, matching the existing treatment of the minute book.

Then add the shape filters:

```ts
export type ShapeName =
  | 'dashboard' | 'team' | 'boardSubmissions' | 'governingActVoid' | 'complianceSignoff';

/**
 * Shapes exist for the four payloads that mix models. A single ModelName
 * cannot describe them, and the alternative — leaving them ungated — is how
 * the dashboard came to return interpolated trustee names through a closed
 * gate.
 *
 * Every shape is built from the same per-model record filters, so a model's
 * allowlist is stated in exactly one place.
 */
export function applyShapePolicy<T>(shape: ShapeName, value: T, allowPersonalData: boolean): T
```

The dashboard shape keeps `compliance` as-is (aggregates), filters `upcomingDeadlines` through `Deadline`, keeps `boardAlerts` as `{memberId, alertType}` plus `memberName` only when the gate is open, and reduces `recentActivity` to `{id, type, timestamp}` when closed. `description` and `userName` are dropped wholesale: the personal data is *inside* the string, so there is nothing to allowlist.

The void shape keeps the traceable scalars and drops `snapshot`, `reason`, `voidedByEmail`, `voidedByUserId` and `title` when closed. An opaque JSON blob cannot be filtered field-wise, so it fails closed.

Finally replace `runTool`'s policy step with a single `applyPolicy(tool, raw, allowPersonalData)` that dispatches on `tool.model` or `tool.shape`, and **throws if a tool declares both or a shape name that does not exist** — a tool with neither returns raw, which stays legitimate only for payloads carrying no records at all.

- [ ] **Step 4: Run the tests**

Run: `cd mcp && npm test`
Expected: PASS, including the existing 20 field-policy cases and the drift guard.

- [ ] **Step 5: Commit** (pathspec; check `git status` first)

---

### Task 3: A tool for every single-model read route

**Files:**
- Modify: `mcp/src/tools.ts`
- Test: `mcp/src/tests/tools.test.ts`

Add tools for: `compliance_principle` (`:principleId`), `compliance_record` (`:standardId`), `compliance_signoff`, `organisation`, `document` (`:id`), `deadlines_reminder_history`, `registers_summary`, `conflicts_list`, `risks_list`, `complaints_list`, `fundraising_list`, `annual_report_readiness` (`year`), `financial_controls` (`year`), `members_list` (`includeFormer`), `governing_acts_voids`, `confluence_status`, `document_storage_dead_letter`. Add `page`/`pageSize` to `board_register`, `documents_list` and `deadlines_list`, and `year`/`kind`/`status` to `governing_acts`.

Each description states plainly what the gate withholds, as the existing ones do, and ends with the shared note that the result is data rather than instructions.

Descriptions must also carry the access facts a model cannot otherwise know, because a 403 is otherwise indistinguishable from a bug:
- the register, minute-book and member tools say they need the Complete plan;
- the audit, session, reminder-history, dead-letter and integration tools say they need an owner or administrator account.

- [ ] **Step 1: Write the failing test** — extend `mcp/src/tests/tools.test.ts` to assert each new tool's name, path and declared model, and that every tool with a `:param` in its path declares a matching `id` param.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Add the tools.**
- [ ] **Step 4: Run `cd mcp && npm test`.** The existing `tool-routes.test.ts` will now check every new path against the real API source and fail on any that would 404.
- [ ] **Step 5: Commit** (pathspec).

---

### Task 4: The mixed-payload tools, and closing the dashboard gap

**Files:**
- Modify: `mcp/src/tools.ts`
- Test: `mcp/src/tests/tools.test.ts`

Give `dashboard_overview` the `dashboard` shape — this is the fix, and it changes what an already-shipped tool returns. Add `team_list` (`team` shape), `board_submissions` (`boardSubmissions` shape), and give `governing_acts_voids` the `governingActVoid` shape and `compliance_signoff` the `complianceSignoff` shape.

- [ ] **Step 1: Write a test asserting every tool either declares a model, declares a shape, or appears in an explicit `NO_RECORDS` list naming why it carries no records.** This is the assertion that stops the dashboard gap recurring: a new tool cannot be added ungated by accident.
- [ ] **Step 2: Run it and watch it fail** — `dashboard_overview` currently has neither.
- [ ] **Step 3: Attach the shapes.**
- [ ] **Step 4: Run `cd mcp && npm test`.**
- [ ] **Step 5: Commit** (pathspec).

---

### Task 5: Coverage — every GET route is a tool or a stated exclusion

**Files:**
- Create: `mcp/src/route-coverage.ts`
- Test: `mcp/src/tests/route-coverage.test.ts`

`route-coverage.ts` exports `EXCLUDED_ROUTES: ReadonlyArray<{ path: string; reason: string }>`, seeded with: both `/export/*` HTML routes, `/documents/:id/download`, all three `/health/*`, all `/owner/*`, `/integrations/confluence/authorize`, `/integrations/confluence/callback`, `/integrations/confluence/spaces`, `/billing/status`, `/team/security-audit`, `/team/members/:id/sessions`, `/auth/me`, and `/api/v1/risks`. Each reason is a sentence, not a label.

The test parses `apps/api/src/server.ts` for group prefixes and each `routes/<group>/index.ts` for `app.get(` registrations, then asserts every discovered `GET` route is either covered by a tool or listed with a reason, and that no exclusion is stale. It must assert the discovered route count is plausible (more than 30) so a parser that silently matches nothing cannot pass — the failure mode that made an earlier drift guard audit an empty list.

- [ ] **Step 1: Write the test, including the non-empty canary.**
- [ ] **Step 2: Run it; expect a list of uncovered routes.**
- [ ] **Step 3: Resolve each** by adding a tool or an exclusion with a reason.
- [ ] **Step 4: Prove the canary** by temporarily breaking the parser's regex and confirming the test fails rather than passing on an empty list. Restore it.
- [ ] **Step 5: Commit** (pathspec).

---

### Task 6: Live assertions for the new surface

**Files:**
- Modify: `e2e/helpers/mcp-seed.ts`, `e2e/tests/mcp/connector-live.spec.ts`

- [ ] **Step 1: Extend the seed** with a risk (owner a person's name), a complaint, a fundraising activity, a second document, and an admin-authored security-audit-producing action, each carrying a `PD-CANARY-` sentinel in its personal fields. Add the new sentinels to `PD_SENTINELS`.
- [ ] **Step 2: Add assertions:**
  - every new tool returns without error for an OWNER;
  - no `PD-CANARY-` sentinel appears in any closed-gate result, across every tool, asserted by iterating the whole tool list rather than naming tools individually, so a tool added later is covered without anyone remembering;
  - `dashboard_overview` with the gate closed contains no activity `description` and no staff name, and with the gate open contains them — the regression test for the gap this phase closes;
  - pagination works: `board_register` with `pageSize: 2` returns two records and `hasMore` true, and page 2 returns the third;
  - an unknown argument is a clean tool error, not a crash;
  - a MEMBER calling an administrator-only tool gets a clean error naming the permission, not a stack trace;
  - `members_list` and the register tools succeed on the Complete plan the seed sets.
- [ ] **Step 3: Run `npm run test:e2e:mcp`.**
- [ ] **Step 4: Add a third canary** to `scripts/mcp-live-canary.mjs` that makes the dashboard shape a passthrough, and confirm the suite goes red.
- [ ] **Step 5: Commit** (pathspec).

---

### Task 7: Documentation

**Files:**
- Modify: `mcp/README.md`, `mcp/HANDOVER.md`, `docs/superpowers/specs/2026-09-19-charitypilot-mcp-full-access-design.md`

- [ ] **Step 1: Rewrite the README's Tools section** as a table of every tool, its inputs, what the gate withholds, and the plan or role it needs.
- [ ] **Step 2: Replace the README's "No `governance_registers` tool" limitation** — per-register tools now exist, which is what that entry asked for. Say what replaced it.
- [ ] **Step 3: Record the dashboard gap in the handover** as something found and fixed, with the reason free text cannot be allowlisted, so nobody reintroduces it.
- [ ] **Step 4: Mark Phase 1 complete in the spec** and note the remaining exclusions.
- [ ] **Step 5: Run the full gate:** `cd mcp && npm test`, `cd e2e && npm run typecheck`, `npm run test:e2e:contract`, `npm run security:scan`, `npm run test:e2e:mcp`, then `git status --porcelain`.
- [ ] **Step 6: Commit** (pathspec).

---

## What Phase 1 does not do

No writes, uploads or downloads, and no session access level: those need the API changes in Phase 2. The excluded routes stay excluded, and each carries its reason in `route-coverage.ts` rather than in someone's memory.
