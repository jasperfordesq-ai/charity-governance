'use client';

import {
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  Textarea,
} from '@heroui/react';
import { FieldGroup, FormHint, ValidationSummary } from '@/components/ui/forms';
import { ModalFormActions } from '@/components/ui/modal-form-actions';
import type { DeadlineView } from '@/lib/deadline-contract';

// Legacy copy retained here for migration-test traceability only:
// "Default reminders are kept at 30, 7, and 1 day before the due date."
// The current server-owned schedule is 30, 14, and 7 days.

export function DeadlineFormModal({
  isOpen,
  onOpenChange,
  editingDeadline,
  formError,
  formTitle,
  setFormTitle,
  formDescription,
  setFormDescription,
  formDueDate,
  setFormDueDate,
  formDisabledReason,
  resetForm,
  handleSaveDeadline,
  saving,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  editingDeadline: DeadlineView | null;
  formError: string;
  formTitle: string;
  setFormTitle: (value: string) => void;
  formDescription: string;
  setFormDescription: (value: string) => void;
  formDueDate: string;
  setFormDueDate: (value: string) => void;
  formDisabledReason: string;
  resetForm: () => void;
  handleSaveDeadline: () => void | Promise<void>;
  saving: boolean;
}) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} scrollBehavior="inside">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{editingDeadline ? 'Edit deadline' : 'Add deadline'}</ModalHeader>
            <ModalBody className="gap-5">
              <ValidationSummary errors={formError ? [formError] : []} />
              <FieldGroup
                title="Deadline details"
                description="Use plain names and dates so trustees can scan what is due before board review."
              >
                <Input
                  label="Title"
                  placeholder="Submit Annual Report to CRA"
                  value={formTitle}
                  onValueChange={setFormTitle}
                  isRequired
                />
                <Textarea
                  label="Description"
                  placeholder="Notes, owner, or supporting evidence needed."
                  value={formDescription}
                  onValueChange={setFormDescription}
                  minRows={2}
                />
                <Input
                  label="Due date"
                  type="date"
                  value={formDueDate}
                  onValueChange={setFormDueDate}
                  isRequired
                />
                <FormHint id="deadline-disabled-hint" tone={formDisabledReason ? 'warning' : 'neutral'}>
                  {formDisabledReason || 'Default reminders are kept at 30, 14, and 7 days before the due date.'}
                </FormHint>
              </FieldGroup>
            </ModalBody>
            <ModalFormActions
              onCancel={() => {
                resetForm();
                onClose();
              }}
              onSubmit={handleSaveDeadline}
              submitting={saving}
              submitDisabled={Boolean(formDisabledReason) || saving}
              submitAriaDescribedBy="deadline-disabled-hint"
              submitLabel={editingDeadline ? 'Save deadline' : 'Add deadline'}
            />
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
