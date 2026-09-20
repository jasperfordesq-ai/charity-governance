import { redactSecrets } from './redact.js';

/**
 * A line per tool call on stderr, when asked for.
 *
 * stderr is the right place: in serve mode stdout is the protocol stream, and
 * the specification's own direction for stdio servers is to log to stderr
 * rather than through the protocol's logging feature, which is on its way
 * out. Arguments are never logged; they can carry personal data.
 */
export function createDiagnostics(
  enabled: boolean,
  write: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
) {
  return {
    toolCall(name: string, outcome: string, ms: number): void {
      if (!enabled) return;
      write(redactSecrets(`[charitypilot-mcp] ${name} ${outcome} ${ms}ms`));
    },
  };
}
