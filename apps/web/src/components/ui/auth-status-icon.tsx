import type { LucideIcon } from 'lucide-react';

type AuthStatusTone = 'brand' | 'success' | 'danger';

const toneClasses: Record<AuthStatusTone, string> = {
  brand: 'bg-teal-primary/10 text-teal-primary dark:bg-teal-bright/10 dark:text-teal-bright',
  success: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300',
  danger: 'bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-300',
};

export function AuthStatusIcon({
  icon: Icon,
  tone = 'brand',
}: {
  icon: LucideIcon;
  tone?: AuthStatusTone;
}) {
  return (
    <div
      className={`mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-lg ${toneClasses[tone]}`}
      aria-hidden="true"
    >
      <Icon className="h-7 w-7" />
    </div>
  );
}
