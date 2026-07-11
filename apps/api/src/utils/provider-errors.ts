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
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/gi, '[redacted-private-key]')
    .replace(/postgres(?:ql)?:\/\/[^\s'"\)]+/gi, '[redacted-database-url]')
    .replace(/\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/gi, 'https://[redacted-credentials]@')
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_=-]+/g, 'stripe-key=[redacted]')
    .replace(/\bwhsec_[A-Za-z0-9_=-]+/g, 'stripe-webhook-secret=[redacted]')
    .replace(/\bre_[A-Za-z0-9_=-]+/g, 'resend-key=[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]+/g, 'github-token=[redacted]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, 'aws-access-key=[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g, 'jwt=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(apikey|api_key|password|service[_-]?role[_-]?key|secret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^,}\s&#]+)/gi, '$1=[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(token|access_token|refresh_token|signature|sig|x-amz-credential|x-amz-signature)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^,}\s&#]+)/gi, '$1=[redacted]')
    .replace(/#[^\s"'<>]*\b(token|access_token|refresh_token)=([^&\s"'<>]+)/gi, '#$1=[redacted]')
    .replace(/\bprovider[-_ ]?secret\b(?:\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^,}\s&#]+))?/gi, 'provider-secret=[redacted]')
    .replace(/\b[a-z0-9][a-z0-9_-]*\/[^\s"'<>]*(?:\.(?:pdf|docx?|xlsx?|pptx?|txt|csv|png|jpe?g))\b/gi, '[storage-path]'));
}

export function sanitizeProviderDiagnosticText(value: string): string {
  return scrubProviderMessage(value);
}

export function formatProviderError(error: unknown): string {
  const rawName = error instanceof Error && error.name
    ? error.name
    : providerField(error, 'name') ?? 'ProviderError';
  const rawCode = providerField(error, 'code');
  const rawStatus = providerField(error, 'status') ?? providerField(error, 'statusCode');
  const name = scrubProviderMessage(rawName);
  const code = rawCode ? scrubProviderMessage(rawCode) : undefined;
  const status = rawStatus ? scrubProviderMessage(rawStatus) : undefined;
  const rawMessage = error instanceof Error && error.message
    ? error.message
    : providerField(error, 'message');
  const message = rawMessage ? scrubProviderMessage(rawMessage) : undefined;

  return [
    `name=${name}`,
    code ? `code=${code}` : '',
    status ? `status=${status}` : '',
    message ? `message=${message}` : '',
  ].filter(Boolean).join(' ');
}
