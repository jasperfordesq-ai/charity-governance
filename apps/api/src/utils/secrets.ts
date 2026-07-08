const PLACEHOLDER_PATTERNS = [
  'REPLACE_ME',
  'change-me',
  'your_',
  'your-',
  'project_ref',
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
  const normalizedValue = value.toLowerCase();
  return !PLACEHOLDER_PATTERNS.some((placeholder) => normalizedValue.includes(placeholder.toLowerCase()));
}
