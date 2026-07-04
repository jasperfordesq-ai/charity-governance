'use client';

import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
} from '@heroui/react';
import { FormHint } from '@/components/ui/forms';
import type { DocumentResponse, GovernanceStandardResponse } from '@charitypilot/shared';

export function DocumentLinkModal({
  isOpen,
  onOpenChange,
  selectedLinkDoc,
  standards,
  standardsError,
  linkStandardId,
  setLinkStandardId,
  linkDisabledReason,
  handleLinkStandard,
  linkingStandard,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  selectedLinkDoc: DocumentResponse | undefined;
  standards: GovernanceStandardResponse[];
  standardsError: string;
  linkStandardId: string;
  setLinkStandardId: (value: string) => void;
  linkDisabledReason: string;
  handleLinkStandard: () => void | Promise<void>;
  linkingStandard: boolean;
}) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>Link standard</ModalHeader>
            <ModalBody className="gap-4">
              <p className="text-sm leading-6 text-gray-600 dark:text-gray-300">
                Link {selectedLinkDoc ? <strong>{selectedLinkDoc.name}</strong> : 'this document'} to the compliance standard it supports.
              </p>
              <Select
                label="Standard"
                selectedKeys={linkStandardId ? new Set([linkStandardId]) : new Set()}
                onSelectionChange={(keys) => {
                  const value = Array.from(keys)[0] as string | undefined;
                  if (value) setLinkStandardId(value);
                }}
                isDisabled={Boolean(standardsError) || standards.length === 0}
              >
                {standards.map((standard) => (
                  <SelectItem key={standard.id} textValue={`${standard.code} - ${standard.title}`}>
                    <span className="font-mono text-sm font-semibold">{standard.code}</span>
                    <span className="ml-2 text-sm text-gray-600 dark:text-gray-300">{standard.title}</span>
                  </SelectItem>
                ))}
              </Select>
              <FormHint id="link-disabled-hint" tone={linkDisabledReason ? 'warning' : 'success'}>
                {linkDisabledReason || 'This document will appear as evidence on the selected standard.'}
              </FormHint>
            </ModalBody>
            <ModalFooter>
              <Button
                variant="flat"
                onPress={() => {
                  setLinkStandardId('');
                  onClose();
                }}
                isDisabled={linkingStandard}
              >
                Cancel
              </Button>
              <Button
                className="bg-teal-primary text-white hover:bg-teal-dark"
                onPress={handleLinkStandard}
                isLoading={linkingStandard}
                isDisabled={Boolean(linkDisabledReason) || linkingStandard}
                aria-describedby="link-disabled-hint"
              >
                Link
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
