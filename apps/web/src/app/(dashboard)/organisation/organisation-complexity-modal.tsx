'use client';

import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { InlineStatus } from '@/components/ui/states';

export function OrganisationComplexityModal({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>Organisation complexity</ModalHeader>
            <ModalBody className="gap-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-50">Simple organisations</h3>
                <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
                  Simple organisations usually track the 32 core standards. This is often appropriate for smaller charities with straightforward operations.
                </p>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-50">Complex organisations</h3>
                <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
                  Complex organisations track the core standards plus the 17 additional standards. Consider this for larger, higher-risk, staffed, or multi-activity charities.
                </p>
              </div>
              <InlineStatus tone="warning">
                Changing this setting affects which standards appear. Existing records are retained. Treat this as a governance setup choice, not legal advice.
              </InlineStatus>
            </ModalBody>
            <ModalFooter>
              <Button className={primaryActionButtonClassName} onPress={onClose}>
                Got it
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
