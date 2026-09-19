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
