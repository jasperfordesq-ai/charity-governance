'use client';

import type { FormEvent, ReactNode } from 'react';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
} from '@heroui/react';
import { teamGovernanceReasonSchema } from '@charitypilot/shared';
import { InlineStatus } from '@/components/ui/states';

export function TeamReasonModal({
  isOpen,
  onOpenChange,
  title,
  description,
  reason,
  setReason,
  confirmation,
  setConfirmation,
  expectedConfirmation,
  confirmLabel,
  confirmColor = 'danger',
  saving,
  accessDisabled = false,
  error,
  onConfirm,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  reason: string;
  setReason: (value: string) => void;
  confirmation?: string;
  setConfirmation?: (value: string) => void;
  expectedConfirmation?: string;
  confirmLabel: ReactNode;
  confirmColor?: 'primary' | 'warning' | 'danger';
  saving: boolean;
  accessDisabled?: boolean;
  error?: string | null;
  onConfirm: () => void | Promise<void>;
}) {
  const reasonResult = teamGovernanceReasonSchema.safeParse(reason);
  const reasonError = reasonResult.success ? null : reasonResult.error.issues[0]?.message;
  const confirmationValid = !expectedConfirmation || confirmation === expectedConfirmation;
  const confirmationError =
    expectedConfirmation && confirmation && !confirmationValid
      ? `Type ${expectedConfirmation} exactly.`
      : null;
  const valid = reasonResult.success && confirmationValid;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && !saving && !accessDisabled) void onConfirm();
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg" scrollBehavior="inside">
      <ModalContent>
        {(onClose) => (
          <form onSubmit={submit}>
            <ModalHeader>
              <h2 className="text-base font-semibold">{title}</h2>
            </ModalHeader>
            <ModalBody className="gap-4">
              <p className="text-sm leading-6 text-gray-600 dark:text-gray-300">{description}</p>
              {error ? <InlineStatus tone="danger">{error}</InlineStatus> : null}
              <Textarea
                label="Governance reason"
                description="Stored with the immutable security audit event (10–500 characters; line breaks are allowed)."
                value={reason}
                onValueChange={setReason}
                minRows={3}
                maxLength={500}
                isDisabled={accessDisabled}
                isInvalid={reason.length > 0 && !reasonResult.success}
                errorMessage={reason.length > 0 ? reasonError : undefined}
                isRequired
              />
              {expectedConfirmation ? (
                <Input
                  label={`Type ${expectedConfirmation} to confirm`}
                  value={confirmation ?? ''}
                  onValueChange={setConfirmation}
                  autoComplete="off"
                  isDisabled={accessDisabled}
                  isInvalid={Boolean(confirmationError)}
                  errorMessage={confirmationError}
                  isRequired
                />
              ) : null}
            </ModalBody>
            <ModalFooter className="flex-col items-stretch gap-2 sm:flex-row sm:justify-end">
              <Button variant="flat" onPress={onClose} isDisabled={saving}>Cancel</Button>
              <Button type="submit" color={confirmColor} isLoading={saving} isDisabled={!valid || saving || accessDisabled}>
                {confirmLabel}
              </Button>
            </ModalFooter>
          </form>
        )}
      </ModalContent>
    </Modal>
  );
}
