const PLACEHOLDER_PATTERNS = [
  'REPLACE_ME',
  'change-me',
  'your_',
  'your-',
  'sk_test_...',
  'pk_test_...',
  'whsec_...',
  'price_...',
  're_...',
  'eyJ...',
  'https://your-project.supabase.co',
] as const;

export function isConfiguredSecret(value: string | undefined): value is string {
  if (!value?.trim()) return false;
  return !PLACEHOLDER_PATTERNS.some((placeholder) => value.includes(placeholder));
}
