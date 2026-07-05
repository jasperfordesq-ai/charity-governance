'use client';

import { ReviewFlag, StatusChip, statusPanelClassName } from '@/components/ui/status';
import { UserRole } from '@charitypilot/shared';
import { ROLE_META } from './team-display';

export function TeamRoleGuidancePanel() {
  return (
    <section className={statusPanelClassName('brand', 'p-5 shadow-sm')}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-3xl">
          <ReviewFlag tone="draft">Role guidance</ReviewFlag>
          <h2 className="mt-3 text-lg font-semibold text-gray-950 dark:text-gray-50">
            Keep invite authority separate from owner-only role control.
          </h2>
          <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
            Owners can manage billing and role changes. Admins can invite collaborators and help run governance workflows. Members can maintain records without team administration rights.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3 lg:min-w-[34rem]">
          {Object.values(UserRole).map((item) => (
            <div key={item} className={statusPanelClassName('neutral', 'p-3')}>
              <StatusChip tone={ROLE_META[item].tone}>{ROLE_META[item].label}</StatusChip>
              <p className="mt-2 text-xs leading-5 text-gray-600 dark:text-gray-300">{ROLE_META[item].description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
