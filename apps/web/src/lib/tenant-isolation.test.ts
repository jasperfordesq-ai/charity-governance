import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

test('the API client is cookie-based (withCredentials), so the org is resolved from the session', () => {
  const api = readFileSync(join(SRC, 'lib', 'api.ts'), 'utf8');
  assert.match(api, /withCredentials:\s*true/);
  // No bearer/access token is ever read from JS storage and attached as a header.
  assert.ok(!/localStorage\.getItem\(['"`](access|token|authToken)/.test(api), 'no JS-readable auth token');
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
  const dynamicSegments = appFiles
    .map((f) => f.match(/\[([^\]]+)\]/g) || [])
    .flat()
    .map((s) => s.slice(1, -1));
  const unique = [...new Set(dynamicSegments)].sort();
  // principleId references a global governance principle (seeded reference data shared by
  // all orgs); slug is a public marketing blog segment. No [organisationId]/[orgId]/[id].
  for (const seg of unique) {
    assert.ok(
      ['principleId', 'slug'].includes(seg),
      `unexpected dynamic route segment [${seg}] — tenant data must never be addressed by an editable id`,
    );
  }
});
