type CreateContentSecurityPolicyOptions = {
  nonce: string;
  isDevelopment: boolean;
  apiUrl?: string;
};

export function createContentSecurityPolicy({
  nonce,
  isDevelopment,
  apiUrl,
}: CreateContentSecurityPolicyOptions): string {
  const connectSrc = isDevelopment
    ? "'self' http://localhost:3002 http://localhost:3003 ws://localhost:3003"
    : `'self' ${apiUrl?.trim() || 'https://api.charitypilot.ie'}`;

  const scriptSrc = [`'self'`, `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (isDevelopment) {
    scriptSrc.push("'unsafe-eval'");
  }

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    `connect-src ${connectSrc}`,
    "form-action 'self'",
    ...(isDevelopment ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}
