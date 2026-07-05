import { evidencePackItems } from '@/lib/regulator-guidance';
import { AppSection } from '@/components/ui/app-page';
import { EvidenceChip, StatusChip, statusPanelClassName } from '@/components/ui/status';

export function DocumentEvidencePackPanel({
  documentCounts,
  missingEvidenceCount,
}: {
  documentCounts: Record<string, number>;
  missingEvidenceCount: number;
}) {
  return (
    <AppSection
      title="Evidence pack"
      description="Use these prompts as a practical checklist for the documents trustees usually expect to see before annual review."
      actions={(
        <StatusChip tone={missingEvidenceCount === 0 ? 'success' : 'warning'}>
          {missingEvidenceCount === 0 ? 'Checklist covered' : `${missingEvidenceCount} evidence areas missing`}
        </StatusChip>
      )}
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {evidencePackItems.map((item) => {
          const count = documentCounts[item.category] ?? 0;
          return (
            <div key={item.title} className={statusPanelClassName('neutral', 'p-4')}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-50">{item.title}</h3>
                  <p className="mt-1 text-xs text-teal-dark dark:text-teal-bright">Standards {item.standards}</p>
                </div>
                <EvidenceChip status={count > 0 ? 'ready' : 'missing'}>
                  {count > 0 ? `${count} file${count === 1 ? '' : 's'}` : 'Needed'}
                </EvidenceChip>
              </div>
            </div>
          );
        })}
      </div>
    </AppSection>
  );
}
