export const DEFAULT_BASE_URL = 'https://charitypilot.tailae0b07.ts.net';

const COMMANDS = new Set(['serve', 'connect', 'disconnect', 'status']);

export interface ConnectorConfig {
  command: string;
  baseUrl: string;
  allowPersonalData: boolean;
}

export function parseArgs(argv: string[]): ConnectorConfig {
  let command = 'serve';
  let baseUrl = process.env.CHARITYPILOT_BASE_URL ?? DEFAULT_BASE_URL;
  let allowPersonalData = false;

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
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!baseUrl.startsWith('https://')) {
    throw new Error('The base URL must use https. TLS verification is not optional.');
  }

  return { command, baseUrl, allowPersonalData };
}
