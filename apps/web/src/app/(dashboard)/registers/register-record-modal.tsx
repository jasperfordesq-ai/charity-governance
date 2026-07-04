'use client';

import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';
import { FormHint, ValidationSummary } from '@/components/ui/forms';
import {
  ComplaintForm,
  ConflictForm,
  FundraisingForm,
  RiskForm,
  modalTitle,
  type RegisterType,
} from './register-record-forms';

export function RegisterRecordModal({
  modalType,
  closeModal,
  form,
  updateForm,
  formError,
  formDisabledReason,
  saving,
  handleCreate,
}: {
  modalType: RegisterType | null;
  closeModal: () => void;
  form: Record<string, string | number | boolean>;
  updateForm: (key: string, value: string | number | boolean) => void;
  formError: string;
  formDisabledReason: string;
  saving: boolean;
  handleCreate: () => void | Promise<void>;
}) {
  return (
    <Modal isOpen={Boolean(modalType)} onOpenChange={(open) => !open && closeModal()} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>{modalType ? modalTitle(modalType) : 'Add register record'}</ModalHeader>
        <ModalBody className="gap-5">
          <ValidationSummary errors={formError ? [formError] : []} />
          {modalType === 'conflict' && <ConflictForm form={form} updateForm={updateForm} />}
          {modalType === 'risk' && <RiskForm form={form} updateForm={updateForm} />}
          {modalType === 'complaint' && <ComplaintForm form={form} updateForm={updateForm} />}
          {modalType === 'fundraising' && <FundraisingForm form={form} updateForm={updateForm} />}
          <FormHint id="register-disabled-hint" tone={formDisabledReason ? 'warning' : 'neutral'}>
            {formDisabledReason || 'Saving updates the register after the API confirms the record.'}
          </FormHint>
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={closeModal} isDisabled={saving}>
            Cancel
          </Button>
          <Button
            className="bg-teal-primary text-white hover:bg-teal-dark"
            onPress={handleCreate}
            isLoading={saving}
            isDisabled={Boolean(formDisabledReason) || saving}
            aria-describedby="register-disabled-hint"
          >
            Save record
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
