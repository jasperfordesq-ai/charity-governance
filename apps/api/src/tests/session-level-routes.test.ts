import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Every destructive route must require an administrator-level session.
 *
 * This is a source check rather than a runtime one on purpose. Fastify's route
 * table does not expose which preHandlers a route carries, so a runtime test
 * could only re-assert the list by hand and would say nothing about a route
 * added next month. Reading the registrations catches the case that actually
 * happens: someone adds a delete route and does not think about connectors.
 *
 * A web session is always ADMIN, enforced by a database constraint, so nothing
 * here changes what the web application can do. What it changes is that a
 * connector session connected at write level cannot delete.
 */
// Tests run from dist/, so this walks back to the sources the registrations
// actually live in rather than the compiled copy beside them.
const ROUTES_DIR = fileURLToPath(new URL("../../src/routes", import.meta.url));

const GUARD = "requireSessionLevel('ADMIN')";

/**
 * Destructive routes that are not DELETE. Each removes something, ends
 * someone's access, or cannot be undone from the interface.
 */
const NON_DELETE_DESTRUCTIVE = [
  ["governing-acts/index.ts", "'/:id/void'"],
  ["team/index.ts", "'/members/:id/role'"],
  ["team/index.ts", "'/members/:id/suspend'"],
  ["team/index.ts", "'/members/:id/remove'"],
  ["team/index.ts", "'/members/:id/sessions/:familyId/revoke'"],
  ["team/index.ts", "'/members/:id/sessions/revoke-all'"],
  ["team/index.ts", "'/ownership/transfer'"],
] as const;

/**
 * Delete routes deliberately left ungated, each with the reason.
 *
 * The list exists so that leaving one out is a decision somebody wrote down,
 * not an omission.
 */
const UNGATED_DELETES: Record<string, string> = {
  // The owner's standing ruling is that CharityPilot never deletes from
  // Confluence. The connector does not expose this route at all, and gating it
  // at administrator level would imply that an administrator-level connector
  // could call it.
  "integrations/index.ts:/confluence":
    "never offered to the connector; owner ruling on Confluence deletion",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

interface Registration {
  file: string;
  path: string;
  line: string;
}

/** Every route registration in the routes tree, with the line that declares it. */
function registrations(methods: readonly string[]): Registration[] {
  const found: Registration[] = [];
  for (const file of sourceFiles(ROUTES_DIR)) {
    const relative = file.slice(ROUTES_DIR.length + 1).replace(/\\/g, "/");
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      for (const method of methods) {
        // Both `app.delete(` and `app.delete<{...}>(`. The instance name is
        // matched loosely because the team routes register on an `authedApp`
        // scope rather than on `app`, and a pattern anchored to `app` alone
        // would skip every route in the file with the most destructive ones.
        const match = new RegExp(
          `[A-Za-z]*[Aa]pp\\.${method}(?:<[^(]*>)?\\(\\s*(['"\`])([^'"\`]*)\\1`,
        ).exec(line);
        if (match) {
          found.push({ file: relative, path: match[2] ?? "", line });
        }
      }
    }
  }
  return found;
}

test("every delete route requires an administrator-level session, or says why not", () => {
  const deletes = registrations(["delete"]);
  assert.ok(deletes.length > 0, "the scan found no delete routes, so it is broken");

  const ungated: string[] = [];
  for (const route of deletes) {
    const key = `${route.file}:${route.path}`;
    if (key in UNGATED_DELETES) continue;
    if (!route.line.includes(GUARD)) ungated.push(key);
  }

  assert.deepEqual(
    ungated,
    [],
    "these delete routes can be called by a connector session below administrator level. "
      + `Add ${GUARD} to the preHandler list, or add an entry to UNGATED_DELETES saying why not.`,
  );
});

test("the destructive routes that are not deletes are gated too", () => {
  const byPath = new Map<string, Registration>();
  for (const route of registrations(["post", "patch", "put"])) {
    byPath.set(`${route.file}:'${route.path}'`, route);
  }

  for (const [file, quotedPath] of NON_DELETE_DESTRUCTIVE) {
    const route = byPath.get(`${file}:${quotedPath}`);
    assert.ok(route, `${file} no longer registers ${quotedPath}; update this list`);
    assert.ok(
      route.line.includes(GUARD),
      `${file} ${quotedPath} removes something and must require an administrator-level session`,
    );
  }
});

test("the ungated list names a real route, so a stale entry cannot hide a new one", () => {
  const known = new Set(
    registrations(["delete"]).map((route) => `${route.file}:${route.path}`),
  );
  for (const key of Object.keys(UNGATED_DELETES)) {
    assert.ok(known.has(key), `UNGATED_DELETES names ${key}, which no longer exists`);
  }
});

test("the session list reports the posture it read, not a constant", () => {
  // Proved end to end in the live suite, where a real connector session shows
  // up on the Team page. This is the fast-suite half: it catches the posture
  // being hardcoded, which no stubbed test would notice because no stubbed
  // test reaches the query.
  const service = readFileSync(
    fileURLToPath(
      new URL("../../src/services/team-lifecycle.service.ts", import.meta.url),
    ),
    "utf8",
  );

  assert.match(
    service,
    /latest\."clientKind",/,
    "the query must select the posture of the latest session in the family",
  );
  assert.match(service, /latest\."accessLevel",/);
  assert.match(
    service,
    /clientKind: family\.clientKind,/,
    "the response must carry the value the query returned",
  );
  assert.match(service, /accessLevel: family\.accessLevel,/);
});
