import { AppSection } from '@/components/ui/app-page';
import { EvidenceChip, StatusChip, statusPanelClassName } from '@/components/ui/status';

type OperationalSignal = {
  title: string;
  why: string;
  standards: string;
  covered: boolean;
};

export function DocumentOperationalSignalsPanel({
  missingSignalCount,
  signalCoverage,
}: {
  missingSignalCount: number;
  signalCoverage: OperationalSignal[];
}) {
  return (
    <AppSection
      title="Operational register signals"
      description="These checks look for named registers and policies in titles or descriptions, so upload names should be easy for trustees to scan."
      actions={(
        <StatusChip tone={missingSignalCount === 0 ? 'success' : 'warning'}>
          {missingSignalCount === 0 ? 'Signals covered' : `${missingSignalCount} signals missing`}
        </StatusChip>
      )}
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {signalCoverage.map((item) => (
          <div key={item.title} className={statusPanelClassName('neutral', 'p-4')}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-50">{item.title}</h3>
                <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-300">{item.why}</p>
                <p className="mt-1 text-xs text-teal-dark dark:text-teal-bright">Standards {item.standards}</p>
              </div>
              <EvidenceChip status={item.covered ? 'ready' : 'review'}>
                {item.covered ? 'Found' : 'Review'}
              </EvidenceChip>
            </div>
          </div>
        ))}
      </div>
    </AppSection>
  );
}
