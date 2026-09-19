import { Entry } from '@napi-rs/keyring';

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
