export const DEFAULT_BASE_URL = 'https://charitypilot.tailae0b07.ts.net';

const COMMANDS = new Set(['serve', 'connect', 'disconnect', 'status', 'approve', 'help', 'version']);

/**
 * Hosts that cannot leave this machine. The check is on the parsed URL's
 * hostname, never on a string prefix: "http://127.0.0.1.evil.example" starts
 * with a loopback-looking string but resolves wherever its owner chooses.
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export type ConnectorProfile = 'default' | 'local';

/**
 * How much authority the session asks for at sign-in.
 *
 * Chosen by the person typing the password, and immutable afterwards. The
 * default off the local profile is `write`, not `admin`: the destructive
 * actions are the ones worth having to ask for deliberately, and a session
 * that cannot take them is a smaller thing to lose.
 */
export type AccessLevel = 'read' | 'write' | 'admin';

const ACCESS_LEVELS: readonly AccessLevel[] = ['read', 'write', 'admin'];

export interface ConnectorConfig {
  command: string;
  baseUrl: string;
  allowPersonalData: boolean;
  profile: ConnectorProfile;
  accessLevel: AccessLevel;
  email?: string | undefined;
  passwordStdin: boolean;
  /** The approval to grant. Only meaningful for the approve command. */
  approvalId?: string | undefined;
  /** The one directory documents may be uploaded from. Absent means no uploads. */
  uploadRoot?: string | undefined;
  /** The one directory documents may be downloaded into. Absent means no downloads. */
  downloadDir?: string | undefined;
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
  let email: string | undefined;
  let passwordStdin = false;
  let accessLevel: AccessLevel | undefined;
  let approvalId: string | undefined;
  let uploadRoot: string | undefined;
  let downloadDir: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (COMMANDS.has(arg)) {
      command = arg;
    } else if (arg === '--help' || arg === '-h') {
      command = 'help';
    } else if (arg === '--version') {
      command = 'version';
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
    } else if (arg === '--email') {
      i += 1;
      const value = argv[i];
      if (!value) throw new Error('--email requires a value');
      email = value;
    } else if (arg === '--access-level') {
      i += 1;
      const value = argv[i];
      if (!value) throw new Error('--access-level requires a value');
      if (!ACCESS_LEVELS.includes(value as AccessLevel)) {
        throw new Error(
          `Unknown access level: ${value}. Use one of: ${ACCESS_LEVELS.join(', ')}.`,
        );
      }
      accessLevel = value as AccessLevel;
    } else if (arg === '--upload-root') {
      i += 1;
      const value = argv[i];
      if (!value) throw new Error('--upload-root requires a directory');
      uploadRoot = value;
    } else if (arg === '--download-dir') {
      i += 1;
      const value = argv[i];
      if (!value) throw new Error('--download-dir requires a directory');
      downloadDir = value;
    } else if (arg === '--password-stdin') {
      passwordStdin = true;
    } else if (command === 'approve' && !arg.startsWith('-') && approvalId === undefined) {
      // `approve <id>`: a bare value, the way the refusal message prints it.
      approvalId = arg;
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

  return {
    command,
    baseUrl,
    allowPersonalData,
    profile,
    // A local test stack holds nothing real, so the convenient default
    // there is full authority. Anywhere else the default withholds the
    // destructive actions until someone asks for them by name.
    accessLevel: accessLevel ?? (profile === 'local' ? 'admin' : 'write'),
    approvalId,
    // Both absent by default. Reading files from a machine and writing
    // personal data onto it are things the operator asks for by name,
    // never things that are simply available.
    uploadRoot,
    downloadDir,
    email,
    passwordStdin,
  };
}
