const MAX_PROVIDER_ERROR_MESSAGE_LENGTH = 160;

function capMessage(message: string): string {
  return message.length > MAX_PROVIDER_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_PROVIDER_ERROR_MESSAGE_LENGTH)}...`
    : message;
}

function providerField(error: unknown, field: string): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function scrubProviderMessage(message: string): string {
  return capMessage(message
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_=-]+/g, 'stripe-key=[redacted]')
    .replace(/\bwhsec_[A-Za-z0-9_=-]+/g, 'stripe-webhook-secret=[redacted]')
    .replace(/\bre_[A-Za-z0-9_=-]+/g, 'resend-key=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(apikey)=([^&#\s]+)/gi, '$1=[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(token|access_token|refresh_token|signature|sig)=([^&#\s]+)/gi, '$1=[redacted]')
    .replace(/#[^\s"'<>]*\b(token|access_token|refresh_token)=([^&\s"'<>]+)/gi, '#$1=[redacted]')
    .replace(/\b[a-z0-9][a-z0-9_-]*\/[^\s"'<>]*(?:\.(?:pdf|docx?|xlsx?|pptx?|txt|csv|png|jpe?g))\b/gi, '[storage-path]'));
}

export function formatProviderError(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : 'ProviderError';
  const code = providerField(error, 'code');
  const status = providerField(error, 'status') ?? providerField(error, 'statusCode');
  const message = error instanceof Error && error.message ? scrubProviderMessage(error.message) : undefined;

  return [
    `name=${name}`,
    code ? `code=${code}` : '',
    status ? `status=${status}` : '',
    message ? `message=${message}` : '',
  ].filter(Boolean).join(' ');
}
