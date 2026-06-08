type ClientErrorShape = {
  digest?: unknown;
  name?: unknown;
  code?: unknown;
  response?: {
    status?: unknown;
    data?: {
      code?: unknown;
    };
  };
};

function clientErrorSummary(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown';

  const shaped = error as ClientErrorShape;
  const parts = [
    typeof shaped.response?.status === 'number' ? `status=${shaped.response.status}` : '',
    typeof shaped.response?.data?.code === 'string' ? `code=${shaped.response.data.code}` : '',
    typeof shaped.code === 'string' ? `code=${shaped.code}` : '',
    typeof shaped.digest === 'string' ? `digest=${shaped.digest}` : '',
    typeof shaped.name === 'string' ? `name=${shaped.name}` : '',
  ].filter(Boolean);

  return parts.join(' ') || 'client error';
}

export function logClientError(message: string, error: unknown): void {
  if (process.env.NODE_ENV !== 'production') {
    console.error(message, error);
    return;
  }

  console.error(`${message}: ${clientErrorSummary(error)}`);
}
