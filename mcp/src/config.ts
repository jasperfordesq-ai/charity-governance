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
