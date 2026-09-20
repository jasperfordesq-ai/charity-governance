import { Entry } from '@napi-rs/keyring';
import { readFileSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import type { ConnectorProfile } from './config.js';

const SERVICE = 'charitypilot-mcp';
const ACCOUNT = 'refresh-token';

export interface CredentialStore {
  read(): string | null;
  write(token: string): void;
  clear(): void;
}

export function createKeyringStore(account: string = ACCOUNT): CredentialStore {
  const entry = new Entry(SERVICE, account);
  return {
    read() {
      try {
        return entry.getPassword() ?? null;
      } catch {
        return null;
      }
    },
    write(token: string) {
      // A failed write means the session did not persist. Swallowing the error
      // would report a sign-in that silently will not survive, masking the problem.
      try {
        entry.setPassword(token);
      } catch (cause) {
        throw new Error(
          'The operating system\'s credential store would not keep the credential, so '
            + 'the sign-in was not saved. On a desktop this usually means the keychain '
            + 'is locked. On a headless Linux machine it usually means nothing is '
            + 'providing one: install and unlock a Secret Service such as gnome-keyring, '
            + `and run connect again. (${(cause as Error).message})`,
        );
      }
    },
    clear() {
      try {
        entry.deletePassword();
      } catch {
        // No portable way to distinguish "already absent" from a real failure,
        // so the read-back below decides rather than the error type.
      }
      let remaining: string | null = null;
      try {
        remaining = entry.getPassword() ?? null;
      } catch {
        // If the entry cannot be read back it cannot be served to anyone either.
        return;
      }
      if (remaining !== null) {
        throw new Error(
          'Failed to clear the stored credential: it is still present in the OS credential store.',
        );
      }
    },
  };
}

export function createMemoryStore(initial: string | null = null): CredentialStore {
  let value = initial;
  return {
    read: () => value,
    write: (token: string) => {
      value = token;
    },
    clear: () => {
      value = null;
    },
  };
}

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

/** The keychain account a host's credential lives under. */
export function accountForOrigin(origin: string): string {
  return `${ACCOUNT}:${origin.toLowerCase()}`;
}

/**
 * One credential per host, with the single old entry still honoured.
 *
 * Until now the keychain held exactly one refresh token, so connecting to the
 * VM and to a local stack meant disconnecting in between, and a future
 * production host would have made that worse. Each host now has its own
 * entry.
 *
 * The entry written before this change is read when it belongs to this host,
 * so upgrading signs nobody out, and is ignored rather than refused when it
 * belongs to another — a refusal there would report a host mismatch for what
 * is simply a credential this host never had.
 */
export function createHostScopedStore(
  origin: string,
  make: (account?: string) => CredentialStore = createKeyringStore,
): CredentialStore {
  const scoped = make(accountForOrigin(origin));
  const legacy = make(ACCOUNT);

  const legacyIfOurs = (): string | null => {
    let raw: string | null = null;
    try {
      raw = legacy.read();
    } catch {
      return null;
    }
    if (raw === null) return null;
    const bound = parseBound(raw);
    // An entry written before credentials were bound to an origin carries no
    // origin to compare, and could only ever have been this connector's.
    return bound === null || bound.origin === origin.toLowerCase() ? raw : null;
  };

  return {
    read() {
      return scoped.read() ?? legacyIfOurs();
    },
    write(token: string) {
      scoped.write(token);
    },
    clear() {
      scoped.clear();
      // Only this host's: clearing another host's old entry would sign the
      // person out of something they did not ask to disconnect from.
      if (legacyIfOurs() !== null) legacy.clear();
    },
  };
}

export function chooseCredentialStore(options: {
  profile: ConnectorProfile;
  credentialFile?: string | undefined;
  /** The host whose credential is wanted. Absent keeps the single old entry. */
  origin?: string | undefined;
  keyring?: (account?: string) => CredentialStore;
  file?: (path: string) => CredentialStore;
}): CredentialStore {
  const keyring = options.keyring ?? createKeyringStore;
  const file = options.file ?? createFileStore;
  if (!options.credentialFile) {
    return options.origin
      ? createHostScopedStore(options.origin, keyring)
      : keyring();
  }
  if (options.profile !== 'local') {
    throw new Error(
      'CHARITYPILOT_CREDENTIAL_FILE is only valid with --profile local. '
        + 'Outside that profile the credential lives in the OS credential store.',
    );
  }
  return file(options.credentialFile);
}

/**
 * The shape a bound credential is stored as. Version 1 carries only the origin
 * that issued the token.
 *
 * The access level is deliberately absent. The session's real authority lives
 * on the server's session row, so a copy here could only ever be advisory, and
 * an advisory copy that drifted would be worse than none: it would report a
 * level the session does not actually hold.
 */
interface BoundCredential {
  v: 1;
  origin: string;
  refreshToken: string;
}

/** Scheme, host and port, lower-cased. Anything else is not part of identity. */
export function originOf(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`The base URL is not a valid URL: ${baseUrl}`);
  }
  return url.origin.toLowerCase();
}

function parseBound(raw: string): BoundCredential | null {
  try {
    const parsed = JSON.parse(raw) as Partial<BoundCredential>;
    if (parsed && parsed.v === 1
      && typeof parsed.origin === 'string'
      && typeof parsed.refreshToken === 'string') {
      return parsed as BoundCredential;
    }
  } catch {
    // Not JSON at all: an entry written by a connector that predates binding.
  }
  return null;
}

/**
 * Binds a stored refresh token to the host that issued it.
 *
 * Without this the credential is presented to whatever base URL is configured,
 * and the base URL is not a secret: an AI client configuration file, an
 * environment variable or an agent with write access to either can point the
 * connector at another host, and the owner's live credential would be sent
 * there on the first refresh. Binding makes that attempt fail before anything
 * is transmitted.
 *
 * A mismatch throws rather than reporting "not connected". Silence would look
 * like an ordinary expired session and invite the human to sign in again —
 * against the redirected host, which is exactly the outcome to avoid.
 *
 * A plain-string entry written by an earlier connector is still honoured, so
 * upgrading does not log anyone out; the next rotation writes a bound record
 * and the gap closes without anyone doing anything.
 */
export function bindCredentialToOrigin(
  store: CredentialStore,
  baseUrl: string,
): CredentialStore {
  const origin = originOf(baseUrl);
  return {
    read() {
      const raw = store.read();
      if (raw === null) return null;
      const bound = parseBound(raw);
      if (!bound) return raw;
      if (bound.origin !== origin) {
        throw new Error(
          `The stored credential was issued by ${bound.origin} and will not be sent to `
            + `${origin}. If the change of host is intended, run `
            + '`charitypilot-mcp disconnect` and connect again; if it is not, something '
            + 'has changed the connector\'s base URL.',
        );
      }
      return bound.refreshToken;
    },
    write(token: string) {
      const record: BoundCredential = { v: 1, origin, refreshToken: token };
      store.write(JSON.stringify(record));
    },
    clear() {
      store.clear();
    },
  };
}
