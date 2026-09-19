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

export function createKeyringStore(): CredentialStore {
  const entry = new Entry(SERVICE, ACCOUNT);
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
      entry.setPassword(token);
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

export function chooseCredentialStore(options: {
  profile: ConnectorProfile;
  credentialFile?: string | undefined;
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
