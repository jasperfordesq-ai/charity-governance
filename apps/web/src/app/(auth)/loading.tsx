import { LoadingState } from '@/components/ui/states';

export default function AuthLoading() {
  return (
    <div className="w-full max-w-md">
      <LoadingState
        title="Loading account page"
        description="Preparing the secure account form."
      />
    </div>
  );
}
