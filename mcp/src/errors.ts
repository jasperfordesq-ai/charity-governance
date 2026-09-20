/**
 * Refusals the connector makes itself, and the one failure that is nobody's
 * refusal: the API could not be reached.
 *
 * Every error a tool returns is given a code, so a client can branch on it
 * without parsing prose. Errors raised by the API carry the API's own code
 * (see ApiError in client.ts); these carry the connector's.
 */
export type ErrorAction =
  | 'none'
  | 'fix_arguments'
  | 'reread'
  | 'reconnect'
  | 'wait'
  | 'approve'
  | 'connect';

export class ConnectorError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly action: ErrorAction;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; action?: ErrorAction } = {},
  ) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.action = options.action ?? 'none';
  }
}

export class ConnectionError extends ConnectorError {
  constructor(message: string) {
    super('NETWORK', message, { retryable: true, action: 'wait' });
    this.name = 'ConnectionError';
  }
}
