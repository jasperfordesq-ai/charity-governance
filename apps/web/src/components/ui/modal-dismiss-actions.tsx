'use client';

import type { ReactNode } from 'react';
import { Button, ModalFooter } from '@heroui/react';
import { primaryActionButtonClassName } from '@/components/ui/action-button';

export function ModalDismissActions({
  label = 'Got it',
  onDismiss,
}: {
  label?: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <ModalFooter className="justify-end">
      <Button className={primaryActionButtonClassName} onPress={onDismiss}>
        {label}
      </Button>
    </ModalFooter>
  );
}
