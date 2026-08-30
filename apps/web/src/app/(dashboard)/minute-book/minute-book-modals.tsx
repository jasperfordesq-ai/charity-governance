'use client';

import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Textarea,
} from '@heroui/react';
import {
  GOVERNING_ACT_KINDS,
  GOVERNING_ACT_STATUSES,
  type ActForm,
  type GoverningAct,
  type GoverningActKind,
  type GoverningActStatus,
} from './use-minute-book-workflow';

type ActModalProps = {
  mode: 'closed' | 'create' | 'edit';
  form: ActForm;
  updateForm: (patch: Partial<ActForm>) => void;
  formError: string;
  saving: boolean;
  onClose: () => void;
  onSubmit: () => void;
};

export function ActModal({ mode, form, updateForm, formError, saving, onClose, onSubmit }: ActModalProps) {
  const open = mode !== 'closed';

  return (
    <Modal isOpen={open} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>{mode === 'edit' ? 'Edit governing act' : 'Add governing act'}</ModalHeader>
        <ModalBody className="flex flex-col gap-4">
          <p className="text-xs text-default-500">
            Record only acts that actually took place. A meeting entered here reads as a statutory
            record of the charity.
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select
              label="Kind"
              selectedKeys={new Set([form.kind])}
              onSelectionChange={(keys) => {
                const value = Array.from(keys)[0] as GoverningActKind | undefined;
                if (value) updateForm({ kind: value });
              }}
            >
              {GOVERNING_ACT_KINDS.map((k) => (
                <SelectItem key={k}>{k.replaceAll('_', ' ').toLowerCase()}</SelectItem>
              ))}
            </Select>

            <Select
              label="Status"
              selectedKeys={new Set([form.status])}
              onSelectionChange={(keys) => {
                const value = Array.from(keys)[0] as GoverningActStatus | undefined;
                if (value) updateForm({ status: value });
              }}
            >
              {GOVERNING_ACT_STATUSES.map((s) => (
                <SelectItem key={s}>{s}</SelectItem>
              ))}
            </Select>

            <Input
              type="date"
              label="Date of the act"
              value={form.actDate}
              onValueChange={(v) => updateForm({ actDate: v })}
            />

            <Input
              label="Reference"
              placeholder="BM-2026-08-07"
              value={form.reference}
              onValueChange={(v) => updateForm({ reference: v })}
            />
          </div>

          <Input label="Title" value={form.title} onValueChange={(v) => updateForm({ title: v })} />

          <Input
            label="Statutory basis (optional)"
            placeholder="s.175(3) Companies Act 2014"
            value={form.statutoryBasis}
            onValueChange={(v) => updateForm({ statutoryBasis: v })}
          />

          <Textarea
            label="Notes (optional)"
            minRows={3}
            value={form.notes}
            onValueChange={(v) => updateForm({ notes: v })}
          />

          {formError ? (
            <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-700">{formError}</p>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onClose} isDisabled={saving}>
            Cancel
          </Button>
          <Button color="primary" onPress={onSubmit} isLoading={saving}>
            {mode === 'edit' ? 'Save changes' : 'Add act'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

type VoidModalProps = {
  target: GoverningAct | null;
  reason: string;
  setReason: (value: string) => void;
  formError: string;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

export function VoidModal({
  target,
  reason,
  setReason,
  formError,
  saving,
  onClose,
  onConfirm,
}: VoidModalProps) {
  return (
    <Modal isOpen={target !== null} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="text-danger">Remove a governing act</ModalHeader>
        <ModalBody className="flex flex-col gap-4">
          {target ? (
            <>
              <div className="rounded-lg border border-default-200 p-3 text-sm">
                <p className="font-mono font-semibold">{target.reference}</p>
                <p>{target.title}</p>
                <p className="mt-1 text-xs text-default-500">
                  {target.actDate.slice(0, 10)} · {target.status} · {target.resolutions.length} resolution
                  {target.resolutions.length === 1 ? '' : 's'}
                </p>
              </div>

              <p className="text-sm">
                This deletes the act and its resolutions permanently. A full snapshot, your email
                address and the reason below are kept in the audit trail — nothing is destroyed
                silently.
              </p>
              <p className="text-sm text-default-600">
                Use this for a record that should never have existed, such as a fabricated or
                mistakenly imported entry. To mark a genuine act that has been replaced, set its
                status to <span className="font-semibold">SUPERSEDED</span> instead.
              </p>

              <Textarea
                label="Why is this record being removed?"
                description="At least 20 characters. Retained in the audit trail."
                minRows={3}
                value={reason}
                onValueChange={setReason}
              />

              {formError ? (
                <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-700">{formError}</p>
              ) : null}
            </>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onClose} isDisabled={saving}>
            Cancel
          </Button>
          <Button
            color="danger"
            onPress={onConfirm}
            isLoading={saving}
            isDisabled={reason.trim().length < 20}
          >
            Remove permanently
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
