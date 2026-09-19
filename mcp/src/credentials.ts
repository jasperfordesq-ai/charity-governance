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
      entry.setPassword(token);
    },
    clear() {
      try {
        entry.deletePassword();
      } catch {
        // Already absent. Clearing is idempotent by contract.
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
