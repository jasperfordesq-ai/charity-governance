import { Card, CardBody } from '@heroui/react';
import { LoadingState } from '@/components/ui/states';

export function AuthCardLoading({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="w-full max-w-md min-w-0">
      <Card className="w-full border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-900">
        <CardBody className="p-8 sm:p-10">
          <LoadingState title={title} description={description} />
        </CardBody>
      </Card>
    </div>
  );
}
