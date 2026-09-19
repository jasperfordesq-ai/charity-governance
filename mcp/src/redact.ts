const secrets = new Set<string>();

const PATTERNS: RegExp[] = [
  /(Bearer[ \t]+)(\S+)/gi,
  /(charitypilot_(?:access|refresh)=)([^;\s]+)/gi,
];

export function registerSecret(value: string): void {
  if (value.length > 8) secrets.add(value);
}

export function clearSecrets(): void {
  secrets.clear();
}

export function redactSecrets(input: string): string {
  let out = input;
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  for (const pattern of PATTERNS) out = out.replace(pattern, '$1[redacted]');
  return out;
}
