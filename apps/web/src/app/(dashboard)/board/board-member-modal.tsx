'use client';

import {
  Checkbox,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
} from '@heroui/react';
import { FieldGroup, FormHint, ValidationSummary } from '@/components/ui/forms';
import { ModalFormActions } from '@/components/ui/modal-form-actions';
import type { BoardMemberResponse } from '@charitypilot/shared';

export function BoardMemberModal({
  accessDisabled,
  isOpen,
  onOpenChange,
  editing,
  formError,
  formName,
  setFormName,
  formRole,
  setFormRole,
  formEmail,
  setFormEmail,
  formAppointed,
  setFormAppointed,
  formTermEnd,
  setFormTermEnd,
  formConductSigned,
  setFormConductSigned,
  formConductDate,
  setFormConductDate,
  formInduction,
  setFormInduction,
  formInductionDate,
  setFormInductionDate,
  formDisabledReason,
  resetForm,
  handleSave,
  saving,
}: {
  accessDisabled: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  editing: BoardMemberResponse | null;
  formError: string;
  formName: string;
  setFormName: (value: string) => void;
  formRole: string;
  setFormRole: (value: string) => void;
  formEmail: string;
  setFormEmail: (value: string) => void;
  formAppointed: string;
  setFormAppointed: (value: string) => void;
  formTermEnd: string;
  setFormTermEnd: (value: string) => void;
  formConductSigned: boolean;
  setFormConductSigned: (value: boolean) => void;
  formConductDate: string;
  setFormConductDate: (value: string) => void;
  formInduction: boolean;
  setFormInduction: (value: boolean) => void;
  formInductionDate: string;
  setFormInductionDate: (value: string) => void;
  formDisabledReason: string;
  resetForm: () => void;
  handleSave: () => void | Promise<void>;
  saving: boolean;
}) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="2xl" scrollBehavior="inside">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{editing ? 'Edit trustee' : 'Add trustee'}</ModalHeader>
            <ModalBody className="gap-5">
              <ValidationSummary errors={formError ? [formError] : []} />
              <FieldGroup
                title="Trustee details"
                description="Record the name, role, contact, and appointment dates that should appear in the trustee register."
              >
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Input
                    label="Full name"
                    placeholder="Mary O'Brien"
                    value={formName}
                    onValueChange={setFormName}
                    isRequired
                    isReadOnly={accessDisabled}
                  />
                  <Input
                    label="Role"
                    placeholder="Chairperson, secretary, treasurer, trustee"
                    value={formRole}
                    onValueChange={setFormRole}
                    isRequired
                    isReadOnly={accessDisabled}
                  />
                  <Input
                    label="Email"
                    placeholder="mary@example.com"
                    type="email"
                    value={formEmail}
                    onValueChange={setFormEmail}
                    isReadOnly={accessDisabled}
                  />
                  <Input
                    label="Date appointed"
                    type="date"
                    value={formAppointed}
                    onValueChange={setFormAppointed}
                    isRequired
                    isReadOnly={accessDisabled}
                  />
                  <Input
                    label="Term end date"
                    type="date"
                    value={formTermEnd}
                    onValueChange={setFormTermEnd}
                    aria-describedby="board-disabled-hint"
                    isReadOnly={accessDisabled}
                  />
                </div>
              </FieldGroup>

              <FieldGroup
                title="Conduct and induction evidence"
                description="Use these fields to make trustee evidence prompts clear before annual review."
              >
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
                    <Checkbox
                      isSelected={formConductSigned}
                      onValueChange={setFormConductSigned}
                      isDisabled={accessDisabled}
                      classNames={{
                        base: 'm-0 flex max-w-none items-start gap-3',
                        wrapper: 'mt-0.5',
                        label: 'text-sm font-medium text-gray-800 dark:text-gray-200',
                      }}
                    >
                      Code of conduct signed
                    </Checkbox>
                    {formConductSigned ? (
                      <Input
                        label="Date signed"
                        type="date"
                        value={formConductDate}
                        onValueChange={setFormConductDate}
                        className="mt-3"
                        isRequired={formConductSigned}
                        aria-describedby="board-disabled-hint"
                        isReadOnly={accessDisabled}
                      />
                    ) : (
                      <FormHint tone="warning">Add the signing date once the trustee conduct record is ready.</FormHint>
                    )}
                  </div>
                  <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
                    <Checkbox
                      isSelected={formInduction}
                      onValueChange={setFormInduction}
                      isDisabled={accessDisabled}
                      classNames={{
                        base: 'm-0 flex max-w-none items-start gap-3',
                        wrapper: 'mt-0.5',
                        label: 'text-sm font-medium text-gray-800 dark:text-gray-200',
                      }}
                    >
                      Induction completed
                    </Checkbox>
                    {formInduction ? (
                      <Input
                        label="Induction date"
                        type="date"
                        value={formInductionDate}
                        onValueChange={setFormInductionDate}
                        className="mt-3"
                        isRequired={formInduction}
                        aria-describedby="board-disabled-hint"
                        isReadOnly={accessDisabled}
                      />
                    ) : (
                      <FormHint tone="warning">Add the induction date once the trustee has completed onboarding.</FormHint>
                    )}
                  </div>
                </div>
                <FormHint id="board-disabled-hint" tone={formDisabledReason || accessDisabled ? 'warning' : 'neutral'}>
                  {accessDisabled
                    ? 'Only organisation owners and administrators can change the board register.'
                    : formDisabledReason || 'Saving updates the trustee register after the API confirms the change.'}
                </FormHint>
              </FieldGroup>
            </ModalBody>
            <ModalFormActions
              onCancel={() => {
                resetForm();
                onClose();
              }}
              onSubmit={handleSave}
              submitting={saving}
              submitDisabled={Boolean(formDisabledReason) || saving || accessDisabled}
              submitAriaDescribedBy="board-disabled-hint"
              submitLabel={editing ? 'Save trustee' : 'Add trustee'}
            />
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
