import { TOOL_GROUPS, type ToolGroup } from './tools.js';

export const DEFAULT_BASE_URL = 'https://charitypilot.tailae0b07.ts.net';

const COMMANDS = new Set(['serve', 'connect', 'disconnect', 'status', 'approve', 'help', 'version']);

/**
 * Hosts that cannot leave this machine. The check is on the parsed URL's
 * hostname, never on a string prefix: "http://127.0.0.1.evil.example" starts
 * with a loopback-looking string but resolves wherever its owner chooses.
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The canonical production API origin.
 *
 * Already pinned in three other places in this repository: the web app's
 * API configuration, its content security policy, and the production check on
 * FRONTEND_URL. Pinning it here too means a redirected base URL in an AI
 * client's configuration file is refused before a password is ever typed.
 */
export const PRODUCTION_API_ORIGIN = 'https://api.charitypilot.ie';

export type ConnectorProfile = 'default' | 'local' | 'vm' | 'prod';

interface ProfileRule {
  /** What this profile is for, in one line, printed by help and by refusals. */
  readonly describe: string;
  /** The exact origin this profile may reach, when there is only one. */
  readonly origin?: string;
  /** Hostnames this profile may reach, when the origin is per-install. */
  readonly hosts?: ReadonlySet<string>;
  /** A host suffix this profile may reach, for the same reason. */
  readonly hostSuffix?: string;
  /** Plain http, which only a stack on this machine may use. */
  readonly allowHttp?: boolean;
}

/**
 * What each profile may reach.
 *
 * A profile is a pin, not a shortcut. The connector already refuses to send a
 * stored credential to a host other than the one that issued it, because the
 * configuration file naming the host is treated as something an attacker may
 * write. A profile applies the same reasoning one step earlier, to the sign-in
 * itself: with `--profile prod`, no edit to that file can point the password
 * prompt at another host.
 *
 * `default` pins nothing, because a charity running its own deployment has an
 * origin nobody here can know. It still requires https.
 */
const PROFILES: Record<ConnectorProfile, ProfileRule> = {
  default: {
    describe: 'Any https host. For a deployment this connector does not know about.',
  },
  local: {
    describe: 'A stack on this machine only. The one profile that allows plain http.',
    hosts: LOOPBACK_HOSTS,
    allowHttp: true,
  },
  vm: {
    describe: 'The private server on its Tailscale address.',
    origin: DEFAULT_BASE_URL,
  },
  prod: {
    describe: 'The hosted service at api.charitypilot.ie.',
    origin: PRODUCTION_API_ORIGIN,
  },
};

export const PROFILE_NAMES = Object.keys(PROFILES) as readonly ConnectorProfile[];

/**
 * The profiles whose origin is known in advance.
 *
 * `status` reads these to say which hosts this machine holds a credential
 * for. `local` and `default` are absent because their host is whatever the
 * operator named, so there is nothing to look up.
 */
export function pinnedProfiles(): readonly { profile: ConnectorProfile; origin: string }[] {
  return PROFILE_NAMES.flatMap((profile) => {
    const origin = PROFILES[profile].origin;
    return origin === undefined ? [] : [{ profile, origin }];
  });
}

/** Describes every profile, for `help` and for a refusal that names the others. */
export function profileSummary(indent = '  '): string {
  return PROFILE_NAMES
    .map((name) => `${indent}${name.padEnd(8)}${PROFILES[name].describe}`)
    .join('\n');
}

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

/**
 * How much personal data the session may see.
 *
 * Chosen at sign-in and recorded on the session by the API, like the access
 * level beside it. It used to be `--allow-personal-data` on the serve command,
 * read from the AI client's configuration file — a file this connector
 * otherwise treats as something an attacker may write, which is why a stored
 * credential refuses to be sent to a host other than the one that issued it.
 */
export type DataScope = 'withheld' | 'full';

const DATA_SCOPES: readonly DataScope[] = ['withheld', 'full'];

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
  /** The tool groups to offer. Absent means every group. */
  toolsets?: readonly ToolGroup[] | undefined;
  /** Log each tool call to stderr, secrets redacted. */
  verbose: boolean;
  /**
   * The scope asked for at sign-in. Absent falls back to the personal-data
   * flag, so an older invocation keeps meaning what it meant.
   */
  dataScope?: DataScope | undefined;
}

/** What `connect` should ask the API for, given everything the caller said. */
export function requestedDataScope(config: ConnectorConfig): DataScope {
  return config.dataScope ?? (config.allowPersonalData ? 'full' : 'withheld');
}

/** An unanswered configuration field arrives as an empty string, not as absent. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function hostnameOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return null;
  }
}

/**
 * Scheme, host and port, lower-cased, or null for anything unparseable.
 *
 * The same notion of identity `credentials.ts` binds a stored credential to,
 * written again here rather than imported: this module is parsed before any
 * credential store exists, and a profile must be able to refuse a base URL
 * without the keychain being involved.
 */
function originOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin.toLowerCase();
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
  let toolsets: ToolGroup[] | undefined;
  let verbose = false;
  let dataScope: DataScope | undefined;

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
      if (!PROFILE_NAMES.includes(value as ConnectorProfile)) {
        throw new Error(
          `Unknown profile: ${value}. The profiles are:
${profileSummary()}`,
        );
      }
      profile = value as ConnectorProfile;
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
    } else if (arg === '--toolsets') {
      i += 1;
      const value = argv[i];
      if (!value) throw new Error('--toolsets requires a comma-separated list, or "all".');
      if (value === 'all') {
        toolsets = undefined;
      } else {
        const names = value.split(',').map((n) => n.trim()).filter(Boolean);
        for (const name of names) {
          if (!(TOOL_GROUPS as readonly string[]).includes(name)) {
            throw new Error(
              `Unknown toolset: ${name}. Use one of: ${TOOL_GROUPS.join(', ')}, or all.`,
            );
          }
        }
        toolsets = names as ToolGroup[];
      }
    } else if (arg === '--data-scope') {
      i += 1;
      const value = argv[i];
      if (!value) throw new Error('--data-scope requires a value');
      if (!DATA_SCOPES.includes(value as DataScope)) {
        throw new Error(
          `Unknown data scope: ${value}. Use one of: ${DATA_SCOPES.join(', ')}.`,
        );
      }
      dataScope = value as DataScope;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (command === 'approve' && !arg.startsWith('-') && approvalId === undefined) {
      // `approve <id>`: a bare value, the way the refusal message prints it.
      approvalId = arg;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  // A packaged bundle cannot add or drop a command-line flag depending on
  // whether the person filled a field in, so the two directories may also
  // arrive as environment variables. An empty value is the same as an absent
  // one: that is what an unanswered field looks like.
  uploadRoot = uploadRoot ?? nonEmpty(process.env.CHARITYPILOT_UPLOAD_ROOT);
  downloadDir = downloadDir ?? nonEmpty(process.env.CHARITYPILOT_DOWNLOAD_DIR);

  const rule = PROFILES[profile];

  // Checked on the parsed URL, never on a string prefix:
  // "https://api.charitypilot.ie.evil.example" begins with the right
  // characters and resolves wherever its owner chooses.
  if (!rule.allowHttp && !baseUrl.startsWith('https://')) {
    throw new Error('The base URL must use https. TLS verification is not optional.');
  }
  if (rule.allowHttp && !baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    throw new Error('The base URL must use http or https.');
  }

  if (rule.origin !== undefined) {
    const asked = originOf(baseUrl);
    if (asked === null || asked !== originOf(rule.origin)) {
      throw new Error(
        `--profile ${profile} only reaches ${rule.origin}. Got: ${baseUrl}. `
          + 'A profile is a pin: if this is genuinely a different deployment, name it '
          + 'with --profile default and its own --base-url.',
      );
    }
  }

  if (rule.hosts !== undefined) {
    const hostname = hostnameOf(baseUrl);
    if (hostname === null || !rule.hosts.has(hostname)) {
      throw new Error(
        `--profile ${profile} only accepts a loopback base URL (localhost, 127.0.0.1 or `
          + `[::1]). Got: ${baseUrl}`,
      );
    }
  }

  if (rule.hostSuffix !== undefined) {
    const hostname = hostnameOf(baseUrl);
    if (hostname === null || !hostname.endsWith(rule.hostSuffix)) {
      throw new Error(
        `--profile ${profile} only reaches a host ending ${rule.hostSuffix}. Got: ${baseUrl}`,
      );
    }
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
    toolsets,
    verbose,
    dataScope,
    email,
    passwordStdin,
  };
}
