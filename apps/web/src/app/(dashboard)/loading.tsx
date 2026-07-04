import { LoadingState } from '@/components/ui/states';

export default function DashboardLoading() {
  return (
    <LoadingState
      title="Loading governance workspace"
      description="Preparing your compliance dashboard and trustee workflow."
      variant="page"
    />
  );
}
