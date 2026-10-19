'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';
import { useDocumentCitations, type DocumentCitation } from './use-document-citations';

export function DocumentConfluenceCitations({ document, onClose }: {
  document: { id: string; name: string }; onClose: () => void;
}) {
  const state = useDocumentCitations(document.id);
  const [removing, setRemoving] = useState<DocumentCitation | null>(null);
  const disabled = state.busy || state.loading || state.needsRefresh || !state.canManage;
  const connected = Boolean(state.connection?.siteId && state.connection.siteUrl);

  return <Modal isOpen onOpenChange={open => { if (!open && !state.busy) onClose(); }}
    isDismissable={!state.busy} isKeyboardDismissDisabled={state.busy} size="2xl" scrollBehavior="inside"
    aria-label="Review Confluence citations">
    <ModalContent>
      <ModalHeader><h2 className="text-base font-semibold">Confluence citations — {document.name}</h2></ModalHeader>
      <ModalBody className="space-y-4">
        <p className="text-sm">Cite a page already managed in Confluence as evidence for this Vault record.
          CharityPilot reads the page and records its title and version. This does not publish a copy, approve
          its contents or grant anyone access to it.</p>
        <p className="break-words text-sm">Connected site: {state.loading ? 'Checking connection' : connected
          ? state.connection?.siteUrl : 'No verified citation target'}. {!state.busy ? <Link className="text-teal-primary underline" href="/integrations">Review connection</Link> : null}</p>
        {state.error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{state.error}</p> : null}
        {state.notice ? <p role="status" className="text-sm text-teal-800 dark:text-teal-200">{state.notice}</p> : null}
        {!state.canManage ? <p role="alert">Citation changes require an Owner or Admin account.</p> : null}
        <div className="space-y-3">
          <Input label="Confluence page ID" description="Use the identifier after /pages/ in the page address, not the whole URL."
            value={state.pageId} onValueChange={state.setPageId} maxLength={64} isDisabled={disabled || !connected} />
          <Button color="primary" onPress={state.add} isLoading={state.busy && !removing && !state.checkingId}
            isDisabled={disabled || Boolean(removing) || !state.pageId.trim() || !connected}>Verify and cite page</Button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Recorded citations</h3>
          <Button size="sm" variant="flat" onPress={state.load} isLoading={state.loading} isDisabled={state.busy}>Refresh citations</Button>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-300">Versions below are those recorded at citation time.
          Refreshing this list does not check the current page version or replace the cited version.
          Use Check upstream version for a current observation. This never updates the citation or changes Confluence.</p>
        {!state.loading && !state.citations.length ? <p className="text-sm">No citations are recorded for this document.</p> : null}
        <ul className="space-y-3" aria-busy={state.loading}>{state.citations.map(citation => <li key={citation.id}
          className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <h4 className="break-words text-sm font-semibold">{citation.pageTitle}</h4>
          <p className="break-words text-sm">Page {citation.pageId} · cited version {citation.pageVersion}</p>
          <p className="break-words text-xs text-gray-600 dark:text-gray-300">Recorded site ID: {citation.cloudId} · cited {new Date(citation.citedAt).toLocaleString('en-IE')}</p>
          <div className="mt-2 space-y-2">
            <Button size="sm" variant="flat" aria-label={`Check upstream version for ${citation.pageTitle}`}
              onPress={() => state.check(citation.id)} isLoading={state.checkingId === citation.id}
              isDisabled={disabled || Boolean(removing)}>Check upstream version</Button>
            {state.checks[citation.id] ? <p role="status" className="text-sm">
              {state.checks[citation.id].status === 'CURRENT' ? `Current at check: version ${state.checks[citation.id].currentVersion}.`
                : state.checks[citation.id].status === 'SUPERSEDED' ? `Superseded: upstream is version ${state.checks[citation.id].currentVersion}; this citation remains version ${citation.pageVersion}.`
                  : 'Unknown: current upstream version could not be verified. Check the connection and your Confluence access.'}
              {' '}Checked {new Date(state.checks[citation.id].checkedAt).toLocaleString('en-IE')}.
              {' '}This observation does not approve the page or verify its historical contents.
            </p> : <p className="text-xs text-gray-600 dark:text-gray-300">Current upstream version has not been checked in this review.</p>}
          </div>
          {removing?.id === citation.id ? <div className="mt-2 space-y-2">
            <p className="text-sm">Remove only this citation from CharityPilot? The Confluence page and its attachments stay unchanged. The decision remains in document history.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" color="danger" onPress={async () => { if (await state.remove(citation.id)) setRemoving(null); }}
                isLoading={state.busy} isDisabled={disabled}>Confirm citation removal</Button>
              <Button size="sm" variant="flat" onPress={() => setRemoving(null)} isDisabled={state.busy}>Keep citation</Button>
            </div>
          </div> : <Button size="sm" variant="flat" className="mt-2" aria-label={`Remove citation for ${citation.pageTitle}`}
            onPress={() => setRemoving(citation)} isDisabled={disabled}>Remove citation</Button>}
        </li>)}</ul>
      </ModalBody>
      <ModalFooter><Button variant="flat" onPress={onClose} isDisabled={state.busy}>Close citations</Button></ModalFooter>
    </ModalContent>
  </Modal>;
}
