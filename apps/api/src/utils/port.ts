export function parsePort(value: string | undefined, fallback: number): number {
  const rawPort = value ?? String(fallback);

  if (!/^\d+$/.test(rawPort)) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }

  return port;
}
