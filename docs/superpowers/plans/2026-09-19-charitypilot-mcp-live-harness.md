# CharityPilot MCP connector — live harness (Phase 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing read-only MCP connector against a real CharityPilot API with real seeded data, and prove by automated assertion that the personal-data gate, tenant isolation and credential handling actually hold.

**Architecture:** Three small affordances are added to the connector (`--profile local`, a file credential store, a non-interactive `connect`) so a test can drive it without touching the owner's OS keychain or a terminal. A Playwright spec in `e2e/` spawns the built connector as a real MCP stdio server, using the official MCP SDK client, against the runner-owned isolated Docker stack. Seeded records carry sentinel strings so a gate assertion cannot pass vacuously.

**Tech Stack:** TypeScript, Node 22 built-in test runner (connector), Playwright (harness), `@modelcontextprotocol/sdk` 1.30.0, PostgreSQL 16 in Docker via `scripts/run-isolated-e2e.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-19-charitypilot-mcp-full-access-design.md` (Phase 0 section). Background state: `mcp/HANDOVER.md`.

## Global Constraints

- **`mcp/` stays outside the npm workspace globs.** Never run `npm install --prefix mcp` from the repo root; it injects `"charitypilot": "file:.."` into `mcp/package.json`. Use `cd mcp && npm install`. `npm ci --prefix mcp` is safe.
- **No task may change the root `package-lock.json`.** Check `git status` before every commit.
- **TLS verification must never be disabled.** No flag, no env var. The SAST rule `tls-verification-disabled` in `scripts/security-scan.mjs` fails the build on the two usual ways of switching it off, so do not write either of them, in code or in prose: the scanner reads every tracked file, documentation included. The only relaxation in this plan is plain `http://` for loopback hosts under `--profile local`, which is not a TLS-verification bypass.
- **No token value is ever written to disk outside the credential store, or to any log line.** `mcp/src/redact.ts` is the mechanism.
- **No tool input schema may contain the string `organisationId`.** Existing test enforces this.
- **Never run `prisma migrate reset`, `migrate dev`, `db push`, `DROP` or `TRUNCATE`** against any database other than the runner-owned disposable one. The development database holds real records.
- **Never layer `compose.e2e.yml` over `compose.yml` / `compose.local.yml`.**
- **A green test proves nothing without a canary.** Every new assertion must be shown to fail when the code it guards is deliberately broken. Task 9 is not optional.
- **Connector tests run from `dist/`**: `npm test` in `mcp/` is `tsc -p tsconfig.json && node --test dist/tests/*.test.js`. There is no Vitest.

---

### Task 1: Connector `--profile local` with a loopback-only carve-out

**Files:**
- Modify: `mcp/src/config.ts`
- Test: `mcp/src/tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ConnectorConfig` gains `profile: 'default' | 'local'`. `parseArgs(argv: string[]): ConnectorConfig` keeps its signature. Exported const `LOOPBACK_HOSTS: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing tests**

Append to `mcp/src/tests/config.test.ts`:

```ts
test('the profile defaults to default and can be set to local', () => {
  assert.equal(parseArgs([]).profile, 'default');
  assert.equal(parseArgs(['--profile', 'local', '--base-url', 'http://127.0.0.1:3302']).profile, 'local');
});

test('an unknown profile is refused', () => {
  assert.throws(
    () => parseArgs(['--profile', 'production', '--base-url', 'http://127.0.0.1:3302']),
    /profile/i,
  );
});

test('--profile local accepts http only for loopback hosts', () => {
  for (const url of ['http://127.0.0.1:3302', 'http://localhost:3002', 'http://[::1]:3002']) {
    assert.equal(parseArgs(['--profile', 'local', '--base-url', url]).baseUrl, url);
  }
});

test('--profile local refuses a host that merely looks like loopback', () => {
  for (const url of [
    'http://127.0.0.1.evil.example',
    'http://localhost.example.com',
    'http://10.0.0.5:3002',
  ]) {
    assert.throws(() => parseArgs(['--profile', 'local', '--base-url', url]), /loopback/i, url);
  }
});

test('--profile local cannot be pointed at the VM', () => {
  assert.throws(
    () => parseArgs(['--profile', 'local', '--base-url', DEFAULT_BASE_URL]),
    /loopback/i,
  );
});

test('without the local profile a loopback http URL is still refused', () => {
  assert.throws(() => parseArgs(['--base-url', 'http://127.0.0.1:3302']), /https/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mcp && npm test`
Expected: FAIL. The first new test fails on `profile` being `undefined`; later ones fail because `--profile` is an unknown option.

- [ ] **Step 3: Implement the minimal change**

In `mcp/src/config.ts`, replace the interface and `parseArgs` body:

```ts
export const DEFAULT_BASE_URL = 'https://charitypilot.tailae0b07.ts.net';

const COMMANDS = new Set(['serve', 'connect', 'disconnect', 'status']);

/**
 * Hosts that cannot leave this machine. The check is on the parsed URL's
 * hostname, never on a string prefix: "http://127.0.0.1.evil.example" starts
 * with a loopback-looking string but resolves wherever its owner chooses.
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export type ConnectorProfile = 'default' | 'local';

export interface ConnectorConfig {
  command: string;
  baseUrl: string;
  allowPersonalData: boolean;
  profile: ConnectorProfile;
}

function hostnameOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return null;
  }
}

export function parseArgs(argv: string[]): ConnectorConfig {
  let command = 'serve';
  let baseUrl = process.env.CHARITYPILOT_BASE_URL ?? DEFAULT_BASE_URL;
  let allowPersonalData = false;
  let profile: ConnectorProfile = 'default';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (COMMANDS.has(arg)) {
      command = arg;
    } else if (arg === '--allow-personal-data') {
      allowPersonalData = true;
    } else if (arg === '--base-url') {
      i += 1;
      const value = argv[i];
      if (!value) throw new Error('--base-url requires a value');
      baseUrl = value;
    } else if (arg === '--profile') {
      i += 1;
      const value = argv[i];
      if (!value) throw new Error('--profile requires a value');
      if (value !== 'local') {
        throw new Error(`Unknown profile: ${value}. The only profile is "local".`);
      }
      profile = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (profile === 'local') {
    // The local profile exists so a test stack on this machine can be driven
    // over plain http. It is confined to loopback so it can never become a way
    // to reach the VM, or any other host, without TLS.
    const hostname = hostnameOf(baseUrl);
    if (hostname === null || !LOOPBACK_HOSTS.has(hostname)) {
      throw new Error(
        '--profile local only accepts a loopback base URL (localhost, 127.0.0.1 or [::1]). '
          + `Got: ${baseUrl}`,
      );
    }
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
      throw new Error('The base URL must use http or https.');
    }
  } else if (!baseUrl.startsWith('https://')) {
    throw new Error('The base URL must use https. TLS verification is not optional.');
  }

  return { command, baseUrl, allowPersonalData, profile };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mcp && npm test`
Expected: PASS, including the six pre-existing config tests. `a non-https base URL is refused` and `there is no flag that disables TLS verification` must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/config.ts mcp/src/tests/config.test.ts
git commit -m "feat(mcp): add a loopback-only local profile

A test stack on this machine speaks plain http. Rather than relaxing the
TLS rule globally, --profile local carves out exactly the hosts that cannot
leave the machine, checked on the parsed hostname so a lookalike host does
not qualify. Every other path keeps the unchanged https requirement.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: File credential store and store selection

**Files:**
- Modify: `mcp/src/credentials.ts`
- Test: `mcp/src/tests/credentials.test.ts`

**Interfaces:**
- Consumes: `ConnectorProfile` from `mcp/src/config.ts` (Task 1).
- Produces: `createFileStore(path: string): CredentialStore` and `chooseCredentialStore(options: { profile: ConnectorProfile; credentialFile?: string; keyring?: () => CredentialStore; file?: (path: string) => CredentialStore }): CredentialStore`. `CredentialStore` is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `mcp/src/tests/credentials.test.ts`:

```ts
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { createFileStore, chooseCredentialStore } from '../credentials.js';

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'cp-mcp-cred-')), 'credential.json');
}

test('a file store round-trips, overwrites and clears', () => {
  const path = tempFile();
  try {
    const store = createFileStore(path);
    assert.equal(store.read(), null, 'an absent file holds nothing');
    store.write('refresh_first');
    assert.equal(store.read(), 'refresh_first');
    store.write('refresh_second');
    assert.equal(store.read(), 'refresh_second', 'write must overwrite, not accumulate');
    store.clear();
    assert.equal(store.read(), null);
    assert.equal(existsSync(path), false, 'clear must remove the file');
  } finally {
    rmSync(path, { force: true });
  }
});

test('clearing an absent file store is not an error', () => {
  const path = tempFile();
  const store = createFileStore(path);
  store.clear();
  assert.equal(store.read(), null);
});

test('a corrupt credential file reads as not connected rather than throwing', () => {
  const path = tempFile();
  try {
    writeFileSync(path, 'not json at all');
    assert.equal(createFileStore(path).read(), null);
  } finally {
    rmSync(path, { force: true });
  }
});

test('the file store is written owner-only', { skip: platform() === 'win32' ? 'POSIX modes only' : false }, () => {
  const path = tempFile();
  try {
    createFileStore(path).write('refresh_abc');
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(path, { force: true });
  }
});

test('the keyring is used unless the local profile asks for a file', () => {
  const keyring = createMemoryStore('from-keyring');
  const file = createMemoryStore('from-file');
  const deps = { keyring: () => keyring, file: () => file };

  assert.equal(
    chooseCredentialStore({ profile: 'default', ...deps }).read(),
    'from-keyring',
  );
  assert.equal(
    chooseCredentialStore({ profile: 'local', ...deps }).read(),
    'from-keyring',
    'the local profile alone must not move the credential off the keyring',
  );
  assert.equal(
    chooseCredentialStore({ profile: 'local', credentialFile: '/tmp/x.json', ...deps }).read(),
    'from-file',
  );
});

test('a credential file is refused outside the local profile', () => {
  assert.throws(
    () => chooseCredentialStore({ profile: 'default', credentialFile: '/tmp/x.json' }),
    /--profile local/,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mcp && npm test`
Expected: FAIL with TypeScript errors that `createFileStore` and `chooseCredentialStore` are not exported from `../credentials.js`.

- [ ] **Step 3: Implement**

Append to `mcp/src/credentials.ts` (keep the existing imports and add these at the top of the file):

```ts
import { readFileSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import type { ConnectorProfile } from './config.js';
```

Then append:

```ts
/**
 * A credential store backed by one JSON file, for the local test profile only.
 *
 * It exists so a harness can drive the connector without touching the OS
 * keychain. Sharing the single keychain entry would overwrite the owner's real
 * credential and rotate it out from under them on the first refresh.
 */
export function createFileStore(path: string): CredentialStore {
  return {
    read() {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { refreshToken?: unknown };
        return typeof parsed.refreshToken === 'string' && parsed.refreshToken.length > 0
          ? parsed.refreshToken
          : null;
      } catch {
        // An absent or unreadable file means no session, which is the same
        // observable state as an empty keychain entry.
        return null;
      }
    },
    write(token: string) {
      writeFileSync(path, `${JSON.stringify({ refreshToken: token })}\n`, { mode: 0o600 });
      try {
        // `mode` only applies when the file is created, so an existing file
        // keeps its old permissions without this.
        chmodSync(path, 0o600);
      } catch {
        // Windows has no POSIX mode; the file inherits the user's ACL.
      }
    },
    clear() {
      rmSync(path, { force: true });
      if (existsSync(path)) {
        throw new Error(`Failed to clear the stored credential: ${path} is still present.`);
      }
    },
  };
}

export function chooseCredentialStore(options: {
  profile: ConnectorProfile;
  credentialFile?: string;
  keyring?: () => CredentialStore;
  file?: (path: string) => CredentialStore;
}): CredentialStore {
  const keyring = options.keyring ?? createKeyringStore;
  const file = options.file ?? createFileStore;
  if (!options.credentialFile) return keyring();
  if (options.profile !== 'local') {
    throw new Error(
      'CHARITYPILOT_CREDENTIAL_FILE is only valid with --profile local. '
        + 'Outside that profile the credential lives in the OS credential store.',
    );
  }
  return file(options.credentialFile);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mcp && npm test`
Expected: PASS, including all five pre-existing credential tests.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/credentials.ts mcp/src/tests/credentials.test.ts
git commit -m "feat(mcp): add a file credential store for the local profile

A harness driving the stock CLI would share the single keychain entry with
the owner's real VM session, overwrite it, and rotate it out from under them
on the first refresh. The file store is selected only when the local profile
and an explicit path are both present, and is refused anywhere else.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Non-interactive `connect`

**Files:**
- Modify: `mcp/src/cli.ts`, `mcp/src/config.ts`
- Test: `mcp/src/tests/config.test.ts`, `mcp/src/tests/connect-input.test.ts` (create)

**Interfaces:**
- Consumes: `ConnectorConfig` (Task 1), `chooseCredentialStore` (Task 2).
- Produces: `ConnectorConfig` gains `email?: string` and `passwordStdin: boolean`. New module `mcp/src/connect-input.ts` exporting `readPasswordFromStdin(stream: AsyncIterable<Buffer>): Promise<string>` and `assertNonInteractiveConnectAllowed(config: { profile: ConnectorProfile; passwordStdin: boolean }, isTty: boolean): void`.

- [ ] **Step 1: Write the failing tests**

Create `mcp/src/tests/connect-input.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readPasswordFromStdin, assertNonInteractiveConnectAllowed } from '../connect-input.js';

function stream(chunks: Buffer[]): AsyncIterable<Buffer> {
  return Readable.from(chunks) as unknown as AsyncIterable<Buffer>;
}

test('the password is the first line, without its terminator', async () => {
  const value = await readPasswordFromStdin(stream([Buffer.from('hunter2\n')]));
  assert.equal(value, 'hunter2');
});

test('a CRLF terminator is stripped', async () => {
  const value = await readPasswordFromStdin(stream([Buffer.from('hunter2\r\n')]));
  assert.equal(value, 'hunter2');
});

test('anything after the first line is ignored', async () => {
  const value = await readPasswordFromStdin(stream([Buffer.from('hunter2\nignored\n')]));
  assert.equal(value, 'hunter2');
});

test('a multi-byte character split across chunks survives', async () => {
  // "Siobhán" — the á is 0xC3 0xA1, delivered in two separate reads. Decoding
  // each chunk on its own would produce a replacement character.
  const full = Buffer.from('Siobhán1x\n', 'utf8');
  const split = full.indexOf(0xc3) + 1;
  const value = await readPasswordFromStdin(
    stream([full.subarray(0, split), full.subarray(split)]),
  );
  assert.equal(value, 'Siobhán1x');
});

test('an empty stdin is an error rather than an empty password', async () => {
  await assert.rejects(() => readPasswordFromStdin(stream([])), /no password/i);
});

test('--password-stdin is refused outside the local profile', () => {
  assert.throws(
    () => assertNonInteractiveConnectAllowed({ profile: 'default', passwordStdin: true }, false),
    /--profile local/,
  );
});

test('--password-stdin is refused when stdin is a terminal', () => {
  assert.throws(
    () => assertNonInteractiveConnectAllowed({ profile: 'local', passwordStdin: true }, true),
    /terminal/i,
  );
});

test('an interactive connect is unaffected', () => {
  assert.doesNotThrow(
    () => assertNonInteractiveConnectAllowed({ profile: 'default', passwordStdin: false }, true),
  );
});
```

Append to `mcp/src/tests/config.test.ts`:

```ts
test('the email and password-stdin flags parse', () => {
  const config = parseArgs([
    'connect', '--profile', 'local', '--base-url', 'http://127.0.0.1:3302',
    '--email', 'owner@example.org', '--password-stdin',
  ]);
  assert.equal(config.command, 'connect');
  assert.equal(config.email, 'owner@example.org');
  assert.equal(config.passwordStdin, true);
});

test('there is no flag or environment variable that carries a password value', () => {
  for (const flag of ['--password', '--pass', '--secret']) {
    assert.throws(() => parseArgs([flag, 'hunter2']), /Unknown option/i, `${flag} must not be accepted`);
  }
  assert.equal(parseArgs([]).passwordStdin, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mcp && npm test`
Expected: FAIL — `../connect-input.js` does not exist, and `--email` is an unknown option.

- [ ] **Step 3: Implement**

Create `mcp/src/connect-input.ts`:

```ts
import type { ConnectorProfile } from './config.js';

/**
 * Read a password from a piped stdin.
 *
 * Bytes are accumulated raw and decoded once, for the same reason the
 * interactive prompt in cli.ts does: a multi-byte UTF-8 character can arrive
 * split across two read events, and decoding each chunk alone would corrupt it.
 */
export async function readPasswordFromStdin(stream: AsyncIterable<Buffer>): Promise<string> {
  let bytes = Buffer.alloc(0);
  for await (const chunk of stream) {
    bytes = Buffer.concat([bytes, chunk]);
    const newline = bytes.indexOf(0x0a);
    if (newline !== -1) {
      bytes = bytes.subarray(0, newline);
      break;
    }
  }
  const text = bytes.toString('utf8').replace(/\r$/, '');
  if (text.length === 0) {
    throw new Error('No password was supplied on stdin.');
  }
  return text;
}

/**
 * A piped password is a test affordance. Two guards keep it from becoming a
 * way to drive a real deployment: the local profile is already confined to
 * loopback, and refusing a TTY stops a real password being typed where it
 * would land in shell history or scrollback.
 */
export function assertNonInteractiveConnectAllowed(
  config: { profile: ConnectorProfile; passwordStdin: boolean },
  isTty: boolean,
): void {
  if (!config.passwordStdin) return;
  if (config.profile !== 'local') {
    throw new Error('--password-stdin is only valid with --profile local.');
  }
  if (isTty) {
    throw new Error(
      '--password-stdin expects a pipe, but stdin is a terminal. '
        + 'Run connect without the flag to be prompted.',
    );
  }
}
```

In `mcp/src/config.ts`, add the two fields to `ConnectorConfig`:

```ts
export interface ConnectorConfig {
  command: string;
  baseUrl: string;
  allowPersonalData: boolean;
  profile: ConnectorProfile;
  email?: string;
  passwordStdin: boolean;
}
```

Add the locals `let email: string | undefined;` and `let passwordStdin = false;` beside the others, these two branches inside the argument loop, and both fields in the returned object:

```ts
    } else if (arg === '--email') {
      i += 1;
      const value = argv[i];
      if (!value) throw new Error('--email requires a value');
      email = value;
    } else if (arg === '--password-stdin') {
      passwordStdin = true;
```

In `mcp/src/cli.ts`, replace the imports and the store/connect section:

```ts
import { parseArgs } from './config.js';
import { chooseCredentialStore } from './credentials.js';
import { readPasswordFromStdin, assertNonInteractiveConnectAllowed } from './connect-input.js';
```

```ts
async function main(): Promise<void> {
  const config = parseArgs(argv.slice(2));
  assertNonInteractiveConnectAllowed(config, stdin.isTTY === true);
  const store = chooseCredentialStore({
    profile: config.profile,
    credentialFile: process.env.CHARITYPILOT_CREDENTIAL_FILE,
  });
  const session = new Session({ baseUrl: config.baseUrl, store });

  if (config.command === 'connect') {
    const email = config.email ?? (await prompt('CharityPilot email: ', false));
    // CHARITYPILOT_BASE_URL can silently point this at a different host. Show it
    // before the password is typed, not after, so a wrong host is caught before
    // anything sensitive is sent to it.
    stdout.write(`Target: ${config.baseUrl}\n`);
    const password = config.passwordStdin
      ? await readPasswordFromStdin(stdin as AsyncIterable<Buffer>)
      : await prompt('Password (not shown): ', true);
    const identity = await session.login(email, password);
    stdout.write(
      `Connected as ${identity.name} <${identity.email}> (${identity.role})\n` +
      `Organisation: ${identity.organisationName}\n` +
      `Personal data: ${config.allowPersonalData ? 'ALLOWED' : 'withheld (default)'}\n`,
    );
    return;
  }
```

Leave the rest of `main` unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mcp && npm test`
Expected: PASS. Confirm the total count has grown and no pre-existing test changed behaviour.

- [ ] **Step 5: Verify the build output is runnable**

Run: `cd mcp && npm run build && node dist/cli.js --profile local --base-url https://charitypilot.tailae0b07.ts.net status`
Expected: exit 1, stderr names the loopback requirement. This is the carve-out canary at runtime, not just in a unit test.

- [ ] **Step 6: Commit**

```bash
git add mcp/src/cli.ts mcp/src/config.ts mcp/src/connect-input.ts mcp/src/tests/connect-input.test.ts mcp/src/tests/config.test.ts
git commit -m "feat(mcp): allow a piped password under the local profile only

A harness cannot type into a raw-mode prompt. --password-stdin takes the
first line of a piped stdin, decoded once from the accumulated buffer so an
accented character split across reads survives. It is refused outside the
loopback-only local profile and refused when stdin is a terminal, so it
cannot become a way to put a real password into shell history.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Let the isolated stack accept the connector's origin

**Files:**
- Modify: `compose.e2e.yml:83`, `scripts/run-isolated-e2e.mjs` (in `expectedLocalServiceEnvironments`, the `api.FRONTEND_URL` line)
- Test: `scripts/run-isolated-e2e.test.mjs` (verify, change only if it hardcodes the value)

**Interfaces:**
- Consumes: `LOCAL_CONTRACT` from `scripts/run-isolated-e2e.mjs` (`webUrl` is `http://127.0.0.1:3303`, `apiUrl` is `http://127.0.0.1:3302`).
- Produces: the API service's `FRONTEND_URL` becomes `http://127.0.0.1:3303,http://127.0.0.1:3302`.

Why: `apps/api/src/utils/request-origin.ts` requires an allow-listed `Origin` on `/auth/login`, `/auth/refresh` and `/auth/logout`, and the connector derives its `Origin` from its own base URL (`mcp/src/session.ts:56`). Today the stack allow-lists only the web origin, so `connect` would 403 before credentials are checked. Phase 2 of the spec removes the connector's `Origin` entirely and this entry can then be reverted.

- [ ] **Step 1: Read the contract test to see whether it asserts the literal value**

Run: `grep -n "FRONTEND_URL" scripts/run-isolated-e2e.test.mjs`
Expected: no direct match — the fixture builds its expectation by calling `expectedLocalServiceEnvironments(FIXED_IDENTITY)` at line 154, so changing the source of truth is enough. If a literal does appear, update it in Step 3 to the same comma-joined value.

- [ ] **Step 2: Change the runner contract**

In `scripts/run-isolated-e2e.mjs`, inside `expectedLocalServiceEnvironments`, replace the API line:

```js
      // The web origin stays first: getPrimaryFrontendOrigin() builds manual
      // links from the first entry. The API origin is allow-listed because the
      // MCP connector signs in from its own base URL and the API's origin hook
      // rejects an unlisted Origin on the auth routes.
      FRONTEND_URL: `${LOCAL_CONTRACT.webUrl},${LOCAL_CONTRACT.apiUrl}`,
```

In `compose.e2e.yml`, line 83:

```yaml
      FRONTEND_URL: http://127.0.0.1:3303,http://127.0.0.1:3302
```

- [ ] **Step 3: Run the contract and static validation**

Run: `npm run test:e2e:contract && npm run test:e2e:isolated:validate`
Expected: both PASS. `assertExactServiceEnvironment` compares the rendered compose against the function, so a mismatch between the two files fails here rather than at boot.

- [ ] **Step 4: Commit**

```bash
git add compose.e2e.yml scripts/run-isolated-e2e.mjs scripts/run-isolated-e2e.test.mjs
git commit -m "test(e2e): allow-list the API origin for the disposable stack

The MCP connector signs in from its own base URL, and the API's origin hook
rejects an unlisted Origin on the auth routes before looking at credentials.
The web origin stays first so manual links are unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Harness driver for the connector

**Files:**
- Modify: `e2e/package.json`, `e2e/tsconfig.json`
- Create: `e2e/helpers/mcp-connector.ts`

**Interfaces:**
- Consumes: the built `mcp/dist/cli.js`; `--profile local`, `--password-stdin`, `CHARITYPILOT_CREDENTIAL_FILE` (Tasks 1–3).
- Produces: `CONNECTOR_CLI: string`, `assertConnectorBuilt(): void`, `runConnector(args, opts): Promise<{ code, stdout, stderr }>`, `openConnector(opts): Promise<OpenConnector>`, `callTool(client, name, args?): Promise<{ isError, text, json }>`, and `interface OpenConnector { client: Client; stderr(): string; close(): Promise<void> }`.

Resolution note, already verified: the SDK has no `main`/`types` field, only an `exports` map, so TypeScript's `node` (node10) resolution — which `e2e/tsconfig.json` uses — cannot find its types. A `paths` mapping fixes types; Node's own resolution honours the `./*` export condition at runtime and loads `dist/cjs`, which carries `{"type": "commonjs"}`. Both were confirmed by loading the CommonJS build from `e2e/`.

- [ ] **Step 1: Install the SDK, pinned exactly**

```bash
cd e2e && npm install --save-exact --save-dev @modelcontextprotocol/sdk@1.30.0
```

Then confirm the root lockfile is untouched:

```bash
git status --short
```
Expected: only `e2e/package.json` and `e2e/package-lock.json` are modified.

- [ ] **Step 2: Add the types mapping**

In `e2e/tsconfig.json`, add inside `compilerOptions`:

```json
    "paths": {
      "@modelcontextprotocol/sdk/*": ["./node_modules/@modelcontextprotocol/sdk/dist/esm/*"]
    },
```

- [ ] **Step 3: Write the driver**

Create `e2e/helpers/mcp-connector.ts`:

```ts
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

export const CONNECTOR_CLI = resolve(__dirname, '../../mcp/dist/cli.js');

/**
 * The harness drives the built connector, not its source. A missing build is
 * reported as an instruction rather than skipped, so the suite can never pass
 * by quietly testing nothing.
 */
export function assertConnectorBuilt(): void {
  if (!existsSync(CONNECTOR_CLI)) {
    throw new Error(
      `The MCP connector is not built at ${CONNECTOR_CLI}. Run: cd mcp && npm ci && npm run build`,
    );
  }
}

function childEnvironment(credentialFile: string): Record<string, string> {
  // getDefaultEnvironment() is the SDK's safe inherited subset (PATH, HOME and
  // similar). CHARITYPILOT_BASE_URL is deliberately NOT inherited: every call
  // passes --base-url explicitly so an ambient value cannot redirect the test.
  return { ...getDefaultEnvironment(), CHARITYPILOT_CREDENTIAL_FILE: credentialFile };
}

export interface ConnectorRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runConnector(
  args: string[],
  options: { credentialFile: string; stdinText?: string },
): Promise<ConnectorRunResult> {
  assertConnectorBuilt();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CONNECTOR_CLI, ...args], {
      env: childEnvironment(options.credentialFile),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(options.stdinText ?? '');
  });
}

export async function connectConnector(options: {
  apiUrl: string;
  email: string;
  password: string;
  credentialFile: string;
}): Promise<ConnectorRunResult> {
  return runConnector(
    [
      'connect',
      '--profile', 'local',
      '--base-url', options.apiUrl,
      '--email', options.email,
      '--password-stdin',
    ],
    { credentialFile: options.credentialFile, stdinText: `${options.password}\n` },
  );
}

export interface OpenConnector {
  client: Client;
  stderr(): string;
  close(): Promise<void>;
}

export async function openConnector(options: {
  apiUrl: string;
  credentialFile: string;
  allowPersonalData?: boolean;
}): Promise<OpenConnector> {
  assertConnectorBuilt();
  const args = [CONNECTOR_CLI, 'serve', '--profile', 'local', '--base-url', options.apiUrl];
  if (options.allowPersonalData) args.push('--allow-personal-data');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: childEnvironment(options.credentialFile),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'charitypilot-live-harness', version: '0.0.0' });
  await client.connect(transport);

  let captured = '';
  transport.stderr?.on('data', (chunk) => {
    captured += String(chunk);
  });

  return {
    client,
    stderr: () => captured,
    close: async () => {
      await client.close();
    },
  };
}

export interface ToolCallResult {
  isError: boolean;
  text: string;
  json: unknown;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCallResult> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.map((part) => part.text ?? '').join('');
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: result.isError === true, text, json };
}
```

- [ ] **Step 4: Type-check**

Run: `cd e2e && npm run typecheck`
Expected: PASS. A failure naming `@modelcontextprotocol/sdk` means the `paths` entry is wrong; confirm `e2e/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.d.ts` exists.

- [ ] **Step 5: Commit**

```bash
git add e2e/package.json e2e/package-lock.json e2e/tsconfig.json e2e/helpers/mcp-connector.ts
git commit -m "test(e2e): add a driver that spawns the real MCP connector

The harness talks to the built connector over stdio with the official SDK
client, so it exercises the same JSON-RPC surface Claude Desktop does. The
paths mapping is needed because the SDK ships only an exports map, which
node10 module resolution does not read.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Seed a charity whose data can prove the gate

**Files:**
- Modify: `e2e/helpers/db.ts` (`createVerifiedMember`, `createVerifiedAdmin`)
- Create: `e2e/helpers/mcp-seed.ts`

**Interfaces:**
- Consumes: `createVerifiedOwner`, `createVerifiedMember`, `createVerifiedAdmin`, `createAuthenticatedStorageState`, `withDb` from `e2e/helpers/db.ts`; `uniqueEmail` from `e2e/fixtures`.
- Produces: `PD_SENTINELS: readonly string[]`, `TENANT_B_SENTINEL: string`, `MCP_TEST_PASSWORD: string`, `MCP_ACCENTED_PASSWORD: string`, and `seedMcpFixture(options: { apiUrl: string }): Promise<McpFixture>` where

```ts
export interface McpFixture {
  owner: { userId: string; organisationId: string; email: string; password: string };
  accentedOwner: { userId: string; organisationId: string; email: string; password: string };
  admin: { userId: string; email: string; password: string };
  member: { userId: string; email: string; password: string };
  orgB: { userId: string; organisationId: string; email: string; password: string };
  ids: { chairId: string; actId: string; documentId: string };
  documentBytes: Buffer;
}
```

- [ ] **Step 1: Give the member and admin helpers a known password**

In `e2e/helpers/db.ts`, in **both** `createVerifiedMember` and `createVerifiedAdmin`, add `password?: string;` to the `data` parameter type and change the hash line from `await bcrypt.hash(randomToken(32), 12)` to:

```ts
  const passwordHash = await bcrypt.hash(data.password ?? randomToken(32), 12);
```

Both helpers keep a random password when none is given, so every existing caller is unaffected.

- [ ] **Step 2: Confirm the request schemas before writing payloads**

Read these and note the exact required field names, so the seed posts what the API validates rather than what this plan guesses:

- `apps/api/src/routes/board-members/index.ts` and its `createBoardMemberSchema`
- `apps/api/src/routes/governing-acts/index.ts` around lines 52 and 74 (act create, resolution create)
- `apps/api/src/routes/governance-registers/index.ts` around line 68 (conflict create)
- `apps/api/src/routes/deadlines/index.ts` around line 69 (deadline create)
- `apps/api/prisma/seed.ts` around line 83 for `seededDocumentPdf`; reuse it if it is exported, otherwise use the inline minimal PDF below

Adjust the payloads in Step 3 to match. A 400 from any of these during the first run means a field name differs; fix the payload, not the API.

- [ ] **Step 3: Write the seed helper**

Create `e2e/helpers/mcp-seed.ts`:

```ts
import { uniqueEmail } from '../fixtures';
import {
  createAuthenticatedStorageState,
  createVerifiedAdmin,
  createVerifiedMember,
  createVerifiedOwner,
  withDb,
} from './db';

export const MCP_TEST_PASSWORD = 'McpHarness!2026';
/** The connector's password path has never been exercised with a multi-byte character. */
export const MCP_ACCENTED_PASSWORD = 'Siobhán!2026';

/**
 * Strings planted in withheld fields. The gate is asserted by substring over
 * the whole serialised tool result, not by key name, so a field that is
 * renamed, nested or echoed somewhere unexpected still fails the test.
 */
export const PD_SENTINELS = [
  'PD-CANARY-ADDRESS',
  'PD-CANARY-FORMER',
  'PD-CANARY-DIRECTORSHIPS',
  'PD-CANARY-NOTES',
  'PD-CANARY-RESOLUTION',
  'pd-canary-chair@example.org',
  '1968-03-14',
] as const;

export const TENANT_B_SENTINEL = 'TENANT-B-CANARY';

const MINIMAL_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
    + '2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n'
    + 'trailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8',
);

export interface McpFixture {
  owner: { userId: string; organisationId: string; email: string; password: string };
  accentedOwner: { userId: string; organisationId: string; email: string; password: string };
  admin: { userId: string; email: string; password: string };
  member: { userId: string; email: string; password: string };
  orgB: { userId: string; organisationId: string; email: string; password: string };
  ids: { chairId: string; actId: string; documentId: string };
  documentBytes: Buffer;
}

async function bearerFor(userId: string, organisationId: string, role: 'OWNER'): Promise<string> {
  const state = await createAuthenticatedStorageState({ userId, organisationId, role });
  const cookie = state.cookies.find((entry) => entry.name === 'charitypilot_access');
  if (!cookie) throw new Error('seedMcpFixture: no access cookie in the generated storage state');
  return cookie.value;
}

/** Seeding uses a Bearer token, which the API accepts without an Origin header. */
async function api<T>(
  apiUrl: string,
  token: string,
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const isForm = init.body instanceof FormData;
  const response = await fetch(`${apiUrl}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
    },
    body: isForm ? (init.body as FormData) : init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    throw new Error(
      `seedMcpFixture: ${init.method} ${path} returned ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function useCompletePlan(organisationId: string): Promise<void> {
  // governance-registers, governing-acts and members are gated by
  // requireCompletePlan, so a plan gate must not be mistaken for a role result.
  const changed = await withDb(async (client) => {
    const result = await client.query(
      `UPDATE "Subscription" SET "plan" = 'COMPLETE', "updatedAt" = NOW() WHERE "organisationId" = $1`,
      [organisationId],
    );
    return result.rowCount ?? 0;
  });
  if (changed !== 1) throw new Error('seedMcpFixture: expected exactly one subscription to update');
}

export async function seedMcpFixture(options: { apiUrl: string }): Promise<McpFixture> {
  const { apiUrl } = options;

  const ownerEmail = uniqueEmail('mcp-owner');
  const owner = await createVerifiedOwner({
    email: ownerEmail,
    password: MCP_TEST_PASSWORD,
    name: 'MCP Harness Owner',
    organisationName: 'MCP Harness Charity',
  });
  await useCompletePlan(owner.organisationId);

  const accentedEmail = uniqueEmail('mcp-accent');
  const accentedOwner = await createVerifiedOwner({
    email: accentedEmail,
    password: MCP_ACCENTED_PASSWORD,
    name: 'MCP Accent Owner',
    organisationName: 'MCP Accent Charity',
  });

  const adminEmail = uniqueEmail('mcp-admin');
  const admin = await createVerifiedAdmin({
    email: adminEmail,
    name: 'MCP Harness Admin',
    organisationId: owner.organisationId,
    password: MCP_TEST_PASSWORD,
  });

  const memberEmail = uniqueEmail('mcp-member');
  const member = await createVerifiedMember({
    email: memberEmail,
    name: 'MCP Harness Member',
    organisationId: owner.organisationId,
    password: MCP_TEST_PASSWORD,
  });

  const token = await bearerFor(owner.userId, owner.organisationId, 'OWNER');

  const chair = await api<{ data: { id: string } }>(apiUrl, token, '/api/v1/board-members', {
    method: 'POST',
    body: {
      name: 'Aoife Chairperson',
      role: 'Chair',
      appointedDate: '2024-01-15',
      email: 'pd-canary-chair@example.org',
      dateOfBirth: '1968-03-14',
      residentialAddress: 'PD-CANARY-ADDRESS, 12 Harbour Road, Dublin',
      formerNames: 'PD-CANARY-FORMER',
      otherDirectorships: 'PD-CANARY-DIRECTORSHIPS',
    },
  });
  await api(apiUrl, token, '/api/v1/board-members', {
    method: 'POST',
    body: { name: 'Brendan Treasurer', role: 'Treasurer', appointedDate: '2024-02-01' },
  });
  await api(apiUrl, token, '/api/v1/board-members', {
    method: 'POST',
    body: { name: 'Ciara Past-Trustee', role: 'Trustee', appointedDate: '2020-01-01', isActive: false },
  });

  const act = await api<{ data: { id: string } }>(apiUrl, token, '/api/v1/governing-acts', {
    method: 'POST',
    body: {
      kind: 'BOARD_MEETING',
      actDate: '2026-03-02',
      reference: 'MCP-ACT-001',
      title: 'Quarterly board meeting',
      notes: 'PD-CANARY-NOTES',
    },
  });
  await api(apiUrl, token, `/api/v1/governing-acts/${act.data.id}/resolutions`, {
    method: 'POST',
    body: { text: 'PD-CANARY-RESOLUTION' },
  });

  await api(apiUrl, token, '/api/v1/governance-registers/conflicts', {
    method: 'POST',
    body: {
      boardMemberId: chair.data.id,
      trusteeName: 'Aoife Chairperson',
      matter: 'PD-CANARY-MATTER',
      nature: 'Supplier relationship',
      dateDeclared: '2026-03-02',
      actionTaken: 'Recused from the vote',
    },
  });

  await api(apiUrl, token, '/api/v1/deadlines', {
    method: 'POST',
    body: { title: 'MCP harness deadline', dueDate: '2026-12-31' },
  });

  const form = new FormData();
  form.append('name', 'MCP harness constitution');
  form.append('category', 'CONSTITUTION');
  form.append('file', new Blob([MINIMAL_PDF], { type: 'application/pdf' }), 'mcp-harness.pdf');
  const document = await api<{ data: { id: string } }>(apiUrl, token, '/api/v1/documents', {
    method: 'POST',
    body: form,
  });

  const orgBEmail = uniqueEmail('mcp-orgb');
  const orgB = await createVerifiedOwner({
    email: orgBEmail,
    password: MCP_TEST_PASSWORD,
    name: 'Other Charity Owner',
    organisationName: 'Other Charity',
  });
  const orgBToken = await bearerFor(orgB.userId, orgB.organisationId, 'OWNER');
  await api(apiUrl, orgBToken, '/api/v1/board-members', {
    method: 'POST',
    body: { name: TENANT_B_SENTINEL, role: 'Chair', appointedDate: '2024-01-15' },
  });

  return {
    owner: { ...owner, email: ownerEmail, password: MCP_TEST_PASSWORD },
    accentedOwner: { ...accentedOwner, email: accentedEmail, password: MCP_ACCENTED_PASSWORD },
    admin: { userId: admin.userId, email: adminEmail, password: MCP_TEST_PASSWORD },
    member: { userId: member.userId, email: memberEmail, password: MCP_TEST_PASSWORD },
    orgB: { ...orgB, email: orgBEmail, password: MCP_TEST_PASSWORD },
    ids: { chairId: chair.data.id, actId: act.data.id, documentId: document.data.id },
    documentBytes: MINIMAL_PDF,
  };
}
```

- [ ] **Step 4: Type-check**

Run: `cd e2e && npm run typecheck`
Expected: PASS. If a response is not shaped `{ data: ... }` for one of these routes, correct the generic at the call site to match what Step 2 found.

- [ ] **Step 5: Commit**

```bash
git add e2e/helpers/db.ts e2e/helpers/mcp-seed.ts
git commit -m "test(e2e): seed a charity whose records can disprove the gate

Withheld fields carry sentinel strings and a second organisation carries its
own, so a gate or tenant assertion cannot pass because the data was simply
absent. Member and admin helpers accept a known password; without one they
still generate a random one, so existing callers are unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Live spec — connect, session lifecycle and credential handling

**Files:**
- Create: `e2e/tests/mcp/connector-live.spec.ts`
- Modify: `package.json` (root, scripts)

**Interfaces:**
- Consumes: everything produced by Tasks 5 and 6; `API_BASE_URL` from `e2e/playwright.config`.
- Produces: the spec file that Task 8 extends.

- [ ] **Step 1: Write the spec's lifecycle block**

Create `e2e/tests/mcp/connector-live.spec.ts`:

```ts
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { API_BASE_URL } from '../../playwright.config';
import {
  assertConnectorBuilt,
  connectConnector,
  runConnector,
  openConnector,
  callTool,
} from '../../helpers/mcp-connector';
import { seedMcpFixture, type McpFixture } from '../../helpers/mcp-seed';

/**
 * Concern: the MCP connector against a real API. Every other connector test
 * stubs fetch, so this is the only place the sign-in, refresh-rotation,
 * personal-data gate and tenant scoping are exercised end to end.
 *
 * No browser is used. The spec spawns the built connector over stdio.
 */
test.describe.configure({ mode: 'serial' });

let fixture: McpFixture;
let credentialDir: string;

function credentialFileFor(label: string): string {
  return join(credentialDir, `${label}.json`);
}

function storedRefreshToken(path: string): string | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { refreshToken?: string };
  return parsed.refreshToken ?? null;
}

test.beforeAll(async () => {
  assertConnectorBuilt();
  credentialDir = mkdtempSync(join(tmpdir(), 'charitypilot-mcp-live-'));
  fixture = await seedMcpFixture({ apiUrl: API_BASE_URL });
});

test.describe('MCP connector lifecycle', () => {
  test('status reports no session before connect', async () => {
    const result = await runConnector(
      ['status', '--profile', 'local', '--base-url', API_BASE_URL],
      { credentialFile: credentialFileFor('lifecycle') },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Not connected');
  });

  test('connect names the account and organisation and leaks no token', async () => {
    const credentialFile = credentialFileFor('lifecycle');
    const result = await connectConnector({
      apiUrl: API_BASE_URL,
      email: fixture.owner.email,
      password: fixture.owner.password,
      credentialFile,
    });

    // Assert on the exit code, not on stderr being empty: Node writes its own
    // warnings there and an empty-string assertion would fail for reasons that
    // have nothing to do with the connector.
    expect(result.code, `connect failed: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(fixture.owner.email);
    expect(result.stdout).toContain('(OWNER)');
    expect(result.stdout).toContain('MCP Harness Charity');
    expect(result.stdout).toContain('withheld (default)');

    const token = storedRefreshToken(credentialFile);
    expect(token, 'a refresh token must be stored').toBeTruthy();
    expect(result.stdout).not.toContain(token!);
    expect(result.stderr).not.toContain(token!);
  });

  test('status afterwards names the same account and organisation', async () => {
    const result = await runConnector(
      ['status', '--profile', 'local', '--base-url', API_BASE_URL],
      { credentialFile: credentialFileFor('lifecycle') },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(fixture.owner.email);
    expect(result.stdout).toContain('MCP Harness Charity');
  });

  test('the advertised tools are exactly the ten read tools and none takes an organisationId', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('lifecycle'),
    });
    try {
      const listed = await connector.client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      // Hardcoded on purpose: a list read from the artifact under test would
      // agree with it however wrong it became.
      expect(names).toEqual([
        'approval_readiness',
        'board_register',
        'compliance_principles',
        'compliance_records',
        'compliance_summary',
        'dashboard_overview',
        'deadlines_history',
        'deadlines_list',
        'documents_list',
        'governing_acts',
      ]);
      expect(JSON.stringify(listed.tools)).not.toContain('organisationId');
    } finally {
      await connector.close();
    }
  });

  test('a fresh process refreshes the session, rotating the stored token', async () => {
    const credentialFile = credentialFileFor('lifecycle');
    const before = storedRefreshToken(credentialFile);
    const connector = await openConnector({ apiUrl: API_BASE_URL, credentialFile });
    try {
      const result = await callTool(connector.client, 'compliance_summary');
      expect(result.isError).toBe(false);
    } finally {
      await connector.close();
    }
    const after = storedRefreshToken(credentialFile);
    expect(after).toBeTruthy();
    expect(after, 'refresh tokens are single-use and must rotate').not.toBe(before);
    expect(connectorStderrIsClean(connector.stderr(), [before!, after!])).toBe(true);
  });

  test('an unknown tool is a clean error', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('lifecycle'),
    });
    try {
      const result = await callTool(connector.client, 'definitely_not_a_tool');
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/unknown tool/i);
      expect(result.text).not.toMatch(/\n\s+at /);
    } finally {
      await connector.close();
    }
  });

  test('disconnect revokes the session on the server, not just locally', async () => {
    const credentialFile = credentialFileFor('lifecycle');
    const token = storedRefreshToken(credentialFile);
    expect(token).toBeTruthy();

    const result = await runConnector(
      ['disconnect', '--profile', 'local', '--base-url', API_BASE_URL],
      { credentialFile },
    );
    expect(result.code).toBe(0);
    expect(storedRefreshToken(credentialFile)).toBeNull();

    const replay = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: API_BASE_URL },
      body: JSON.stringify({ refreshToken: token }),
    });
    expect(replay.status, 'the revoked token must be rejected by the API').toBe(401);
  });

  test('a tool call after disconnect asks for connect, without a stack trace', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('lifecycle'),
    });
    try {
      const result = await callTool(connector.client, 'compliance_summary');
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Not connected');
      expect(result.text).not.toMatch(/\n\s+at /);
    } finally {
      await connector.close();
    }
  });

  test('a password with an accented character signs in', async () => {
    const result = await connectConnector({
      apiUrl: API_BASE_URL,
      email: fixture.accentedOwner.email,
      password: fixture.accentedOwner.password,
      credentialFile: credentialFileFor('accented'),
    });
    expect(result.code, `accented connect failed: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(fixture.accentedOwner.email);
  });
});

function connectorStderrIsClean(stderr: string, secrets: string[]): boolean {
  return secrets.every((secret) => !stderr.includes(secret));
}
```

- [ ] **Step 2: Add the root script**

In the root `package.json`, beside the other `test:e2e:*` entries:

```json
    "test:e2e:mcp": "node scripts/run-isolated-e2e.mjs -- tests/mcp/connector-live.spec.ts",
```

- [ ] **Step 3: Build the connector and run the spec**

```bash
cd mcp && npm ci && npm run build && cd ..
npm run test:e2e:mcp
```

Expected: all lifecycle tests PASS. Docker Desktop must be running. A 403 on connect means Task 4 did not take effect; check that `compose.e2e.yml` and `expectedLocalServiceEnvironments` agree.

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/mcp/connector-live.spec.ts package.json
git commit -m "test(e2e): drive the MCP connector against a real API

First test of the connector that does not stub fetch. Covers sign-in,
status, live refresh rotation, server-side revocation on disconnect, the
advertised tool list, and a password carrying a multi-byte character.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Live spec — personal-data gate, tenant isolation and roles

**Files:**
- Modify: `e2e/tests/mcp/connector-live.spec.ts`

**Interfaces:**
- Consumes: `PD_SENTINELS`, `TENANT_B_SENTINEL` from `e2e/helpers/mcp-seed.ts`; helpers from Task 5.
- Produces: nothing consumed later.

- [ ] **Step 1: Extend the imports**

```ts
import { seedMcpFixture, PD_SENTINELS, TENANT_B_SENTINEL, type McpFixture } from '../../helpers/mcp-seed';
```

- [ ] **Step 2: Write the gate, tenant and role blocks**

Append to `e2e/tests/mcp/connector-live.spec.ts`:

```ts
const READ_TOOLS = [
  'approval_readiness',
  'board_register',
  'compliance_principles',
  'compliance_records',
  'compliance_summary',
  'dashboard_overview',
  'deadlines_history',
  'deadlines_list',
  'documents_list',
  'governing_acts',
] as const;

const BOARD_MEMBER_WITHHELD = [
  'dateOfBirth',
  'residentialAddress',
  'email',
  'formerNames',
  'otherDirectorships',
] as const;

async function connectAs(
  label: string,
  account: { email: string; password: string },
): Promise<string> {
  const credentialFile = credentialFileFor(label);
  const result = await connectConnector({
    apiUrl: API_BASE_URL,
    email: account.email,
    password: account.password,
    credentialFile,
  });
  expect(result.code, `connect as ${label} failed: ${result.stderr}`).toBe(0);
  return credentialFile;
}

test.describe('Personal-data gate, closed (the default)', () => {
  test('board_register returns the real envelope and withholds every personal field', async () => {
    const credentialFile = await connectAs('gate-closed', fixture.owner);
    const connector = await openConnector({ apiUrl: API_BASE_URL, credentialFile });
    try {
      const result = await callTool(connector.client, 'board_register');
      expect(result.isError).toBe(false);

      const body = result.json as { data: Array<Record<string, unknown>>; total: number };
      expect(Object.keys(body).sort()).toEqual(
        ['data', 'hasMore', 'page', 'pageSize', 'total'],
      );
      expect(body.total).toBe(3);
      expect(body.data).toHaveLength(3);
      expect(result.text).toContain('Aoife Chairperson');

      for (const record of body.data) {
        for (const field of BOARD_MEMBER_WITHHELD) {
          expect(record, `${field} must not reach the model`).not.toHaveProperty(field);
        }
      }
      for (const sentinel of PD_SENTINELS) {
        expect(result.text, `${sentinel} must not appear anywhere`).not.toContain(sentinel);
      }
    } finally {
      await connector.close();
    }
  });

  test('governing_acts withholds notes and resolutions', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('gate-closed'),
    });
    try {
      const result = await callTool(connector.client, 'governing_acts');
      expect(result.isError).toBe(false);
      expect(result.text).toContain('MCP-ACT-001');
      expect(result.text).not.toContain('PD-CANARY-NOTES');
      expect(result.text).not.toContain('PD-CANARY-RESOLUTION');
    } finally {
      await connector.close();
    }
  });

  test('documents_list returns metadata and never file bytes', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('gate-closed'),
    });
    try {
      const result = await callTool(connector.client, 'documents_list');
      expect(result.isError).toBe(false);
      expect(result.text).toContain('MCP harness constitution');
      expect(result.text).not.toContain('%PDF');
    } finally {
      await connector.close();
    }
  });

  test('every read tool succeeds and none returns another charity\'s data', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('gate-closed'),
    });
    try {
      for (const name of READ_TOOLS) {
        const result = await callTool(connector.client, name);
        expect(result.isError, `${name} must succeed`).toBe(false);
        expect(result.text, `${name} must not reach the other charity`).not.toContain(
          TENANT_B_SENTINEL,
        );
      }
    } finally {
      await connector.close();
    }
  });
});

test.describe('Personal-data gate, open', () => {
  test('the withheld fields really were there', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('gate-closed'),
      allowPersonalData: true,
    });
    try {
      const board = await callTool(connector.client, 'board_register');
      expect(board.isError).toBe(false);
      // Without this, every closed-gate assertion above could pass on empty data.
      for (const sentinel of ['PD-CANARY-ADDRESS', 'PD-CANARY-FORMER', 'PD-CANARY-DIRECTORSHIPS', '1968-03-14']) {
        expect(board.text, `${sentinel} must be present with the gate open`).toContain(sentinel);
      }

      const acts = await callTool(connector.client, 'governing_acts');
      expect(acts.text).toContain('PD-CANARY-NOTES');
      expect(acts.text).toContain('PD-CANARY-RESOLUTION');

      expect(board.text, 'the gate is about fields, never tenancy').not.toContain(TENANT_B_SENTINEL);
    } finally {
      await connector.close();
    }
  });
});

test.describe('Tenant isolation', () => {
  test('the other charity sees its own trustee and never this one\'s', async () => {
    const credentialFile = await connectAs('org-b', fixture.orgB);
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile,
      allowPersonalData: true,
    });
    try {
      const result = await callTool(connector.client, 'board_register');
      expect(result.isError).toBe(false);
      // Proves the sentinel is reachable at all, so the absence asserted in the
      // owner's session is a real boundary and not an empty organisation.
      expect(result.text).toContain(TENANT_B_SENTINEL);
      expect(result.text).not.toContain('Aoife Chairperson');
    } finally {
      await connector.close();
    }
  });
});

test.describe('Roles', () => {
  for (const role of ['admin', 'member'] as const) {
    test(`a ${role} reads every tool, and the closed gate still withholds`, async () => {
      const credentialFile = await connectAs(role, fixture[role]);
      const connector = await openConnector({ apiUrl: API_BASE_URL, credentialFile });
      try {
        for (const name of READ_TOOLS) {
          const result = await callTool(connector.client, name);
          expect(result.isError, `${name} must succeed for ${role}`).toBe(false);
        }
        const board = await callTool(connector.client, 'board_register');
        for (const sentinel of PD_SENTINELS) {
          expect(board.text).not.toContain(sentinel);
        }
      } finally {
        await connector.close();
      }
    });
  }

  test('a member can open the gate, which is a client-side decision the API does not police', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('member'),
      allowPersonalData: true,
    });
    try {
      const board = await callTool(connector.client, 'board_register');
      // Recorded as the live evidence behind the spec's open question for the
      // DPO: reads are not role-gated by the API, so the flag alone decides.
      expect(board.text).toContain('PD-CANARY-ADDRESS');
    } finally {
      await connector.close();
    }
  });
});
```

- [ ] **Step 3: Run the spec**

Run: `npm run test:e2e:mcp`
Expected: every test PASSES. If `board_register` returns `{}` rather than an envelope, the deployed connector predates the pagination fix — rebuild with `cd mcp && npm run build`.

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/mcp/connector-live.spec.ts
git commit -m "test(e2e): assert the gate, tenancy and roles against live data

The open-gate block is what makes the closed-gate block meaningful: it
proves the withheld fields were present and were dropped, rather than never
having been there. Tenant isolation is asserted in both directions, which
is the check the connector spec claimed and never had.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Canaries — prove the harness fails when it should

**Files:**
- Create: `scripts/mcp-live-canary.mjs`

**Interfaces:**
- Consumes: `npm run test:e2e:mcp`, the connector source under `mcp/src`.
- Produces: a script that applies one named mutation, expects the suite to fail, and restores the tree.

- [ ] **Step 1: Write the canary runner**

Create `scripts/mcp-live-canary.mjs`:

```js
#!/usr/bin/env node
/**
 * Break the connector on purpose and require the live suite to notice.
 *
 * Three tests in the original connector build passed whether or not the code
 * worked. A green suite is evidence only once it has been shown to go red.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const MUTATIONS = {
  'gate-leaks-dob': {
    file: 'mcp/src/field-policy.ts',
    find: "  BoardMember: [",
    replace: "  BoardMember: [\n    'dateOfBirth',",
    expect: 'board_register must withhold dateOfBirth',
  },
  'gate-always-open': {
    file: 'mcp/src/tools.ts',
    find: 'allowPersonalData',
    replace: 'true /* canary */ || allowPersonalData',
    expect: 'governing_acts must withhold notes and resolutions',
  },
};

const name = process.argv[2];
const mutation = MUTATIONS[name];
if (!mutation) {
  console.error(`Usage: node scripts/mcp-live-canary.mjs <${Object.keys(MUTATIONS).join('|')}>`);
  process.exit(2);
}

const original = readFileSync(mutation.file, 'utf8');
if (!original.includes(mutation.find)) {
  console.error(`Canary "${name}" could not find its anchor in ${mutation.file}. Update the mutation.`);
  process.exit(2);
}

let outcome = 'unknown';
try {
  writeFileSync(mutation.file, original.replace(mutation.find, mutation.replace));
  // A mutation that does not compile would make the suite fail for the wrong
  // reason and the canary would congratulate itself. The build is therefore
  // judged separately, and a broken build is a broken canary, not a pass.
  try {
    execFileSync('npm', ['run', 'build'], { cwd: 'mcp', stdio: 'inherit', shell: true });
  } catch {
    outcome = 'build-broken';
    throw new Error('build');
  }
  try {
    execFileSync('npm', ['run', 'test:e2e:mcp'], { stdio: 'inherit', shell: true });
    outcome = 'suite-passed';
  } catch {
    outcome = 'suite-failed';
  }
} catch {
  // Falls through to the restore below with `outcome` already set.
} finally {
  writeFileSync(mutation.file, original);
  execFileSync('npm', ['run', 'build'], { cwd: 'mcp', stdio: 'inherit', shell: true });
}

if (outcome === 'build-broken') {
  console.error(
    `CANARY BROKEN: "${name}" does not compile, so the suite would have failed for the wrong `
      + 'reason. Rewrite the mutation so it is valid code that behaves wrongly.',
  );
  process.exit(2);
}
if (outcome !== 'suite-failed') {
  console.error(`CANARY FAILED: the suite passed with "${name}" applied. ${mutation.expect}`);
  process.exit(1);
}
console.log(`Canary "${name}" behaved correctly: the suite failed while the mutation was applied.`);
```

- [ ] **Step 2: Confirm each mutation's anchor matches the current source**

Run: `grep -n "BoardMember: \[" mcp/src/field-policy.ts && grep -n "allowPersonalData" mcp/src/tools.ts`
Expected: both print a line. If the anchor text differs, correct `find` in the script — a canary that cannot apply its mutation is worse than no canary, which is why the script exits 2 rather than passing.

- [ ] **Step 3: Run both canaries**

```bash
node scripts/mcp-live-canary.mjs gate-leaks-dob
node scripts/mcp-live-canary.mjs gate-always-open
```

Expected: each prints that the suite failed while the mutation was applied, then restores and rebuilds. Confirm `git status` is clean afterwards.

- [ ] **Step 4: Confirm the suite is green again**

Run: `npm run test:e2e:mcp`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/mcp-live-canary.mjs
git commit -m "test: add live-harness canaries for the personal-data gate

A green suite proves nothing until it has been shown to go red. Each canary
applies one mutation, requires the live suite to fail, then restores and
rebuilds; it exits 2 rather than passing if its anchor no longer matches.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: CI wiring and honest documentation

**Files:**
- Modify: `.github/workflows/e2e.yml`, `mcp/README.md`, `mcp/HANDOVER.md`, `docs/superpowers/specs/2026-09-19-charitypilot-mcp-connector-design.md`

**Interfaces:**
- Consumes: `npm run test:e2e` (already runs every spec under `e2e/tests/`, so the new spec needs no separate invocation).
- Produces: nothing consumed later.

- [ ] **Step 1: Build the connector in CI before the stack runs**

In `.github/workflows/e2e.yml`, add `'mcp/**'` to the `pull_request.paths` list, change the Node cache to cover both lockfiles, and add a build step before "Run managed isolated E2E tests":

```yaml
        with:
          node-version: ${{ env.E2E_NODE_VERSION }}
          cache: npm
          cache-dependency-path: |
            e2e/package-lock.json
            mcp/package-lock.json
```

```yaml
      - name: Build the MCP connector
        run: npm ci && npm run build
        working-directory: mcp
```

Using `working-directory` rather than `--prefix` is deliberate: `npm install --prefix mcp` from the root injects a workspace link into `mcp/package.json`.

- [ ] **Step 2: Document how to run it**

Add to `mcp/README.md` a "Testing against a local stack" section covering: build the connector, `npm run test:e2e:mcp` for the full matrix, and the MCP Inspector loop:

```bash
cd mcp && npm run build
node dist/cli.js connect --profile local --base-url http://localhost:3002
npx @modelcontextprotocol/inspector node dist/cli.js serve --profile local --base-url http://localhost:3002
```

State that the local profile accepts only loopback hosts and that `apps/api/.env` must list `http://localhost:3002` in `FRONTEND_URL` until the connector auth routes land.

Add the Claude Desktop entry for the local profile:

```json
{ "mcpServers": { "charitypilot-local": {
    "command": "node",
    "args": ["C:\\platforms\\htdocs\\charity-governence\\mcp\\dist\\cli.js",
             "serve", "--profile", "local", "--base-url", "http://localhost:3002"],
    "env": { "CHARITYPILOT_CREDENTIAL_FILE": "C:\\Users\\jaspe\\.charitypilot-mcp-local.json" } } } }
```

- [ ] **Step 3: Correct the two documents that now say something untrue**

In `mcp/HANDOVER.md`: replace the claim that the connector has never been run against a real API with what is now true — it runs against the disposable stack in CI, and name the spec file. Keep "not yet verified against the VM" until the owner's checklist is done.

In `docs/superpowers/specs/2026-09-19-charitypilot-mcp-connector-design.md`: the Tenant isolation section promises a test rejecting another organisation's response, which never existed (HANDOVER problem 2). Replace that bullet with a pointer to the live tenant test in `e2e/tests/mcp/connector-live.spec.ts`, which asserts the boundary in both directions. Correct the Testing section's claim that no test makes a live call.

- [ ] **Step 4: Verify the whole gate**

```bash
cd mcp && npm test && cd ..
cd e2e && npm run typecheck && cd ..
npm run test:e2e:contract
npm run security:scan
npm run test:e2e:mcp
git status --short
```
Expected: all PASS, and `git status` shows no change to the root `package-lock.json`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/e2e.yml mcp/README.md mcp/HANDOVER.md docs/superpowers/specs/2026-09-19-charitypilot-mcp-connector-design.md
git commit -m "ci,docs: run the live connector suite and correct two false claims

The E2E workflow now builds the connector and picks up the live spec. The
handover no longer says the connector has never met a real API, and the
original spec no longer claims a tenant-isolation test that did not exist;
both now point at the test that does.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Owner verification against the VM

Not part of CI. Run after Task 10, with Tailscale connected, using the stock CLI with no profile so the OS keychain and https are exercised exactly as in daily use.

- [ ] `node mcp/dist/cli.js status` reports not connected.
- [ ] `node mcp/dist/cli.js connect` prints the right account, role and organisation, and `Personal data: withheld (default)`.
- [ ] `node mcp/dist/cli.js status` reports the same organisation.
- [ ] In Claude Desktop: `compliance_summary` returns; `board_register` shows names and roles and no date of birth or residential address; `governing_acts` shows no notes or resolutions; `documents_list` shows metadata only.
- [ ] Ask Claude for the chair's home address: the honest answer is that the connector withholds it.
- [ ] Restart Claude Desktop and call a tool: it works without reconnecting, which exercises live refresh rotation against the VM.
- [ ] `node mcp/dist/cli.js disconnect`, then a tool call returns "Not connected" with no stack trace.
- [ ] Record the result in `mcp/HANDOVER.md`.

## What Phase 0 does not do

Writes, uploads, downloads, role-aware tool advertisement and the `accessLevel` session property all belong to Phases 1 to 5 of the spec and need the API changes in Phase 2. The assertion rows for them are listed in the spec and are added with the tools themselves.
