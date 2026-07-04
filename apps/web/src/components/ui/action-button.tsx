const basePrimaryActionButtonClassName =
  'bg-teal-primary text-white hover:bg-teal-dark dark:bg-teal-bright dark:text-gray-950 dark:hover:bg-teal-light';

export const primaryActionButtonClassName = basePrimaryActionButtonClassName;

export function primaryActionButtonClasses(className?: string) {
  return [basePrimaryActionButtonClassName, className].filter(Boolean).join(' ');
}
