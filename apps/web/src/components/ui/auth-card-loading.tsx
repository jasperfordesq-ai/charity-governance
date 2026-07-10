import { Card, CardBody } from '@heroui/react';
import { statusPanelClassName } from '@/components/ui/status';
import { LoadingState } from '@/components/ui/states';

export const authCardClassName = statusPanelClassName('neutral', 'w-full shadow-lg');

export function AuthCardLoading({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="w-full max-w-md min-w-0">
      <Card className={authCardClassName}>
        <CardBody className="p-8 sm:p-10">
          <LoadingState title={title} description={description} />
        </CardBody>
      </Card>
    </div>
  );
}
