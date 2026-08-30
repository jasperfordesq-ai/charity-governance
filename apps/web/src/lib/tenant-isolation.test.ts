import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

// Concern: tenant isolation (UI). The #1 multi-tenant trust guarantee is that the app
// never lets a user choose which organisation's data they see. Org context must come
// from the httpOnly session cookie (resolved server-side), NEVER from a URL param a user
// can edit. This is a STRUCTURAL guard: it fails loudly the moment a page starts sourcing
// an org id from the URL or talking to the API with an org-id query/path param.

// The web suite runs with cwd = apps/web (see package.json `test` and reliability-report).
const SRC = join(process.cwd(), 'src');
const APP = join(SRC, 'app');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(tsx?|ts)$/.test(entry) && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const appFiles = walk(APP);
const allSrc = appFiles.map((f) => ({ f, src: readFileSync(f, 'utf8') }));

test('every API client (tenant and owner) is cookie-based, with no JS-readable auth token', () => {
  // owner-api.ts is a strictly higher-privilege client than api.ts (it can suspend or close
  // any charity on the platform), so it gets the same scrutiny as the tenant client — not a
  // pass because it lives outside the (dashboard)/(auth) tree this file otherwise walks.
  for (const file of ['api.ts', 'owner-api.ts']) {
    const src = readFileSync(join(SRC, 'lib', file), 'utf8');
    assert.match(src, /withCredentials:\s*true/, `${file} must send credentials via cookie, not a header`);
    // No bearer/access token is ever read from JS storage and attached as a header.
    assert.ok(
      !/localStorage\.getItem\(['"`](access|token|authToken)/.test(src),
      `${file}: no JS-readable auth token`,
    );
  }
});

test('no page sources an organisation id from a URL param (useParams / useSearchParams / query)', () => {
  const orgFromUrl = [
    /useParams\([^)]*\)[^;]*organisation/i,
    /params\.(organisation|org)Id/i,
    /searchParams[^;]*\b(organisation|org)Id\b/i,
    /useSearchParams\([^)]*\)[^;]*organisation/i,
  ];
  for (const { f, src } of allSrc) {
    for (const re of orgFromUrl) {
      assert.ok(!re.test(src), `${f} must not read an organisation id from the URL (${re})`);
    }
  }
});

test('no API request carries an organisation id as a query or path parameter', () => {
  const orgInRequest = [
    /[?&]organisationId=/i,
    /\/organisations?\/\$\{/i, // e.g. `/organisations/${someId}` built from a variable
    /api\.(get|post|put|patch|delete)\([^)]*organisationId/i,
  ];
  for (const { f, src } of allSrc) {
    for (const re of orgInRequest) {
      assert.ok(!re.test(src), `${f} must not send an organisation id to the API (${re})`);
    }
  }
});

test('the only editable dynamic route segment is the global principleId (a content id, not a tenant id)', () => {
  // The (owner) route group is the platform-owner console: a separately authenticated
  // (Path-scoped charitypilot_owner_* cookies, its own axios client in lib/owner-api.ts)
  // operator tool whose job is to look up an arbitrary tenant by id — that cross-tenant
  // lookup is the feature, not the leak this guard protects against on the tenant side.
  //
  // The carve-out below is PINNED, not a blanket exemption. A route group name is invisible
  // in the URL — e.g. app/(owner)/compliance/[organisationId]/page.tsx would be served at
  // /compliance/<editable-id> for ordinary tenant users, even though the file lives under
  // (owner)/. So "is under (owner)" must never be treated as "is the owner console": we
  // assert the owner-side segment set is exactly the one tenant-lookup id we expect (a new
  // or different segment fails loudly), AND that every routable file under (owner) is
  // actually served under /owner, so (owner) can never become a hiding place for a
  // tenant-facing route.
  const segmentsOf = (files: string[]) => [
    ...new Set(files.flatMap((f) => (f.match(/\[([^\]]+)\]/g) || []).map((s) => s.slice(1, -1)))),
  ].sort();

  const ownerFiles = appFiles.filter((f) => f.includes('(owner)'));
  const tenantFiles = appFiles.filter((f) => !ownerFiles.includes(f));

  // principleId references a global governance principle (seeded reference data shared by
  // all orgs); slug is a public marketing blog segment. No [organisationId]/[orgId]/[id].
  assert.deepEqual(
    segmentsOf(tenantFiles),
    ['principleId', 'slug'],
    'a new tenant-facing dynamic route segment appeared — tenant data must never be addressed by an editable id',
  );

  // Today the owner console has exactly one dynamic segment: tenants/[id]. If this ever
  // grows (e.g. a nested [somethingId]), update this pin deliberately rather than let it
  // slide by unnoticed.
  assert.deepEqual(
    segmentsOf(ownerFiles),
    ['id'],
    'the owner console dynamic-segment set changed — update this pin deliberately if intended',
  );

  // Only page.tsx/route.ts files actually serve a URL; layout.tsx and friends do not have a
  // path of their own, so they are irrelevant to "is this served under /owner".
  const ownerRoutableFiles = ownerFiles.filter(
    (f) => f.endsWith(`${sep}page.tsx`) || f.endsWith(`${sep}route.ts`),
  );
  for (const f of ownerRoutableFiles) {
    assert.ok(
      f.includes(`${sep}owner${sep}`),
      `${f} is a route inside the (owner) group but is not actually served under /owner`,
    );
  }
});
