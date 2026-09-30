'use client';

import Link from 'next/link';
import { Button, Input, Textarea } from '@heroui/react';
import { useAuth } from '@/lib/auth-context';
import { useDocumentTitle } from '@/lib/use-title';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { ErrorState, LoadingState, PermissionHint } from '@/components/ui/states';
import { DataLifecycleCoverage } from './data-lifecycle-coverage';

import { fieldClass, stateLabels, type Kind, type Scope, type ReviewState } from './data-request-types';
import { useDataRequests } from './use-data-requests';

export default function DataLifecyclePage() {
  useDocumentTitle('Data Requests');
  const { user } = useAuth();
  const canReview = user?.role === 'OWNER' || user?.role === 'ADMIN';
  const {
    records,
    nextCursor,
    dueRecords,
    nextDueCursor,
    loadingDue,
    dueError,
    selected,
    events,
    nextEventCursor,
    targetEvents,
    nextTargetCursor,
    responseEvents,
    nextResponseCursor,
    storageLinks,
    nextStorageCursor,
    documentLinks,
    nextDocumentCursor,
    loadingEvents,
    loadingTargets,
    loadingResponses,
    loadingStorage,
    loadingDocuments,
    sourceLookupGeneration,
    loading,
    saving,
    error,
    caseReference,
    setCaseReference,
    lookupReference,
    setLookupReference,
    lookingUp,
    kind,
    setKind,
    scope,
    setScope,
    receivedLocal,
    setReceivedLocal,
    nextState,
    setNextState,
    reason,
    setReason,
    evidenceRef,
    setEvidenceRef,
    targetLocal,
    setTargetLocal,
    targetReason,
    setTargetReason,
    targetEvidenceRef,
    setTargetEvidenceRef,
    responseLocal,
    setResponseLocal,
    responseReason,
    setResponseReason,
    responseEvidenceRef,
    setResponseEvidenceRef,
    deletionId,
    setDeletionId,
    sourceDocumentId,
    setSourceDocumentId,
    sourceJobs,
    setSourceJobs,
    nextSourceCursor,
    setNextSourceCursor,
    sourceLookupPerformed,
    setSourceLookupPerformed,
    sourceLookupBusy,
    setSourceLookupBusy,
    sourceLookupError,
    setSourceLookupError,
    storageLinkReason,
    setStorageLinkReason,
    documentId,
    setDocumentId,
    documentLinkReason,
    setDocumentLinkReason,
    withdrawingDocumentLinkId,
    setWithdrawingDocumentLinkId,
    documentWithdrawalReason,
    setDocumentWithdrawalReason,
    withdrawingLinkId,
    setWithdrawingLinkId,
    withdrawalReason,
    setWithdrawalReason,
    load,
    loadDue,
    selectRecord,
    loadOlderEvents,
    loadOlderTargetEvents,
    loadOlderResponseEvents,
    loadOlderStorageLinks,
    loadOlderDocumentLinks,
    submitDocumentLink,
    submitDocumentWithdrawal,
    submitStorageLink,
    findSourceJobs,
    loadOlderSourceJobs,
    submitWithdrawal,
    lookupCase,
    submitIntake,
    submitTriage,
    submitResponseTarget,
    submitResponseSent,
  } = useDataRequests(canReview);

  return (
    <AppPage eyebrow="Admin review" title="Data Requests"
      description="Record erasure and retention review requests, then track assessment and evidence. A review state never means that data was deleted or permanently purged.">
      {!canReview ? <PermissionHint>Only Owners and Admins can review data requests.</PermissionHint> : <>
        <AppSection title="Before recording a request" description="Keep the requester's identity and correspondence in the controlled case archive. Enter only its opaque reference here; no names, email addresses, document contents or tokens.">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            This queue records intake, triage and reviewed links to Vault records and technical deletion jobs. The approved schedule, holds, deleted-item recovery, object and backup expiry, and final purge proof remain separate work. See <Link className="text-teal-primary underline" href="/governance-audit">Governance Audit</Link> for existing document and integration histories.
          </p>
        </AppSection>

        <AppSection title="Record request">
          <form onSubmit={submitIntake} className="grid gap-4 md:grid-cols-2">
            <Input label="Opaque case reference" value={caseReference} onValueChange={setCaseReference}
              description="Uppercase letters, numbers and hyphens only; 3–120 characters." isRequired maxLength={120} />
            <label className="block text-sm font-medium">Request type
              <select className={`mt-2 ${fieldClass}`} value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
                <option value="ERASURE">Erasure</option><option value="RETENTION_REVIEW">Retention review</option>
              </select>
            </label>
            <label className="block text-sm font-medium">Data area
              <select className={`mt-2 ${fieldClass}`} value={scope} onChange={(event) => setScope(event.target.value as Scope)}>
                <option value="ACCOUNT">Account and access</option><option value="GOVERNANCE">Governance records</option>
                <option value="DOCUMENT">Documents</option><option value="INTEGRATION">External integration</option>
                <option value="ORGANISATION">Whole organisation</option><option value="OTHER">Other</option>
              </select>
            </label>
            <label className="block text-sm font-medium">Received date and time
              <input className={`mt-2 ${fieldClass}`} type="datetime-local" value={receivedLocal}
                onChange={(event) => setReceivedLocal(event.target.value)} required />
            </label>
            <div className="md:col-span-2"><Button type="submit" color="primary" isLoading={saving} isDisabled={saving}>Record request</Button></div>
          </form>
        </AppSection>

        {error ? <ErrorState title="Data request action needs attention" description={error} action={<Button size="sm" onPress={() => void load()}>Reload requests</Button>} /> : null}
        <AppSection title="Past response targets" description="Reviewer-entered targets that have passed, ordered by target date. A past target needs case review; it does not prove a legal deadline was missed or that erasure is due.">
          <Button size="sm" variant="flat" onPress={() => void loadDue()} isLoading={loadingDue}>Refresh targets</Button>
          {dueError ? <ErrorState title="Past targets unavailable" description={dueError} action={<Button size="sm" onPress={() => void loadDue()}>Retry</Button>} /> : null}
          {!loadingDue && dueRecords.length === 0 && !dueError ? <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">No past response targets recorded.</p> : null}
          <ol className="mt-3 space-y-2">{dueRecords.map((record) => <li key={record.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <div><strong>{record.caseReference}</strong><p className="text-sm text-gray-600 dark:text-gray-300">
              Target {new Date(record.targetResponseAt!).toLocaleString('en-IE')} · {stateLabels[record.reviewState]}
            </p></div>
            <Button size="sm" variant="flat" onPress={() => void selectRecord(record)}>Review</Button>
          </li>)}</ol>
          {nextDueCursor ? <Button className="mt-3" size="sm" variant="flat" onPress={() => void loadDue(nextDueCursor)}
            isLoading={loadingDue} isDisabled={loadingDue}>Load later past targets</Button> : null}
        </AppSection>
        {loading && records.length === 0 ? <LoadingState title="Loading data requests" description="Reading the review queue." /> : null}
        <AppSection title="Review queue" description="All states below are unresolved assessment states. Older requests can be loaded in pages of 50.">
          <form onSubmit={lookupCase} className="mb-4 flex flex-wrap items-end gap-3">
            <Input className="max-w-sm" label="Find by case reference" value={lookupReference}
              onValueChange={setLookupReference} description="Exact opaque reference from the controlled case archive."
              maxLength={120} isRequired />
            <Button type="submit" variant="flat" isLoading={lookingUp}
              isDisabled={lookingUp || !/^[A-Z0-9][A-Z0-9-]{2,119}$/.test(lookupReference.trim())}>Find request</Button>
          </form>
          {records.length === 0 && !loading ? <p className="text-sm text-gray-600 dark:text-gray-300">No requests recorded.</p> : null}
          <ol className="space-y-2">
            {records.map((record) => <li key={record.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div><strong>{record.caseReference}</strong><p className="text-sm text-gray-600 dark:text-gray-300">
                {record.kind.replace('_', ' ')} · {record.scope.replace('_', ' ')} · received {new Date(record.receivedAt).toLocaleString('en-IE')} · {stateLabels[record.reviewState]}
              </p>{record.targetResponseAt ? <p className="text-sm text-gray-600 dark:text-gray-300">
                Reviewer target: {new Date(record.targetResponseAt).toLocaleString('en-IE')}
                {dueRecords.some((due) => due.id === record.id) ? ' · past target' : ''}
              </p> : null}{record.responseSentAt ? <p className="text-sm text-gray-600 dark:text-gray-300">
                Response recorded: {new Date(record.responseSentAt).toLocaleString('en-IE')}
              </p> : null}</div>
              <Button size="sm" variant="flat" onPress={() => void selectRecord(record)}>Review</Button>
            </li>)}
          </ol>
          {nextCursor ? <Button className="mt-3" size="sm" variant="flat" isLoading={loading} isDisabled={loading}
            onPress={() => void load(nextCursor)}>Load older requests</Button> : null}
        </AppSection>

        {selected ? <AppSection title={`Review ${selected.caseReference}`} description="Record a change in assessment state with its reason. This cannot mark erasure complete.">
          <h3 className="font-semibold">Response target</h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            This is a case-specific operational target entered by a reviewer. CharityPilot does not calculate a statutory deadline or authorise deletion from it. Keep the legal basis and correspondence in the controlled case archive.
          </p>
          <form onSubmit={submitResponseTarget} className="mt-3 space-y-4">
            <label className="block text-sm font-medium">Target response date and time
              <input className={`mt-2 ${fieldClass}`} type="datetime-local" value={targetLocal}
                onChange={(event) => setTargetLocal(event.target.value)} />
            </label>
            <p className="text-sm text-gray-600 dark:text-gray-300">Leave the date blank to withdraw a previously entered target.</p>
            <Textarea label="Reason for target change" value={targetReason} onValueChange={setTargetReason}
              minRows={2} isRequired description="Explain the target or its withdrawal without personal details." />
            <Input label="Opaque target evidence reference" value={targetEvidenceRef} onValueChange={setTargetEvidenceRef}
              description="Optional controlled-archive reference." maxLength={120} />
            <Button type="submit" color="primary" isLoading={saving}
              isDisabled={saving || targetReason.trim().length < 10}>Save response target</Button>
          </form>
          <h4 className="mt-5 font-semibold">Response-target history</h4>
          {targetEvents.length === 0 ? <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">No target has been recorded.</p> : null}
          <ol className="mt-2 space-y-2">{targetEvents.map((entry) => <li key={entry.id}
            className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
            <strong>{entry.previousTargetAt ? new Date(entry.previousTargetAt).toLocaleString('en-IE') : 'No target'} → {entry.nextTargetAt ? new Date(entry.nextTargetAt).toLocaleString('en-IE') : 'No target'}</strong>
            <span className="ml-2 text-gray-600 dark:text-gray-300">{new Date(entry.occurredAt).toLocaleString('en-IE')}</span>
            <p>{entry.reason}</p>{entry.evidenceRef ? <p>Evidence: {entry.evidenceRef}</p> : null}
          </li>)}</ol>
          {nextTargetCursor ? <Button className="mt-3" size="sm" variant="flat" isLoading={loadingTargets}
            onPress={() => void loadOlderTargetEvents()}>Load older target changes</Button> : null}

          <h3 className="mt-8 font-semibold">Actual response sent</h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            Record the date and controlled-archive reference only after checking that a response was sent. This is separate from the planned target and does not close the case, establish lawful retention expiry or prove erasure.
          </p>
          <form onSubmit={submitResponseSent} className="mt-3 space-y-4">
            <label className="block text-sm font-medium">Actual response date and time
              <input className={`mt-2 ${fieldClass}`} type="datetime-local" value={responseLocal}
                onChange={(event) => setResponseLocal(event.target.value)} />
            </label>
            <p className="text-sm text-gray-600 dark:text-gray-300">Leave the date blank to withdraw an incorrect response entry. Its earlier event remains in history.</p>
            <Textarea label="Reason for response record or correction" value={responseReason} onValueChange={setResponseReason}
              minRows={2} isRequired description="Explain the entry or correction without personal details." />
            <Input label="Opaque response evidence reference" value={responseEvidenceRef} onValueChange={setResponseEvidenceRef}
              description="Required when recording a sent response; use the controlled correspondence archive reference." maxLength={120} />
            <Button type="submit" color="primary" isLoading={saving}
              isDisabled={saving || responseReason.trim().length < 10 || Boolean(responseLocal && !/^[A-Z0-9][A-Z0-9-]{2,119}$/.test(responseEvidenceRef.trim()))}>
              Save actual response date
            </Button>
          </form>
          <h4 className="mt-5 font-semibold">Sent-response history</h4>
          {responseEvents.length === 0 && !loadingResponses ? <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">No response date has been recorded.</p> : null}
          <ol className="mt-2 space-y-2">{responseEvents.map((entry) => <li key={entry.id}
            className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
            <strong>{entry.previousResponseAt ? new Date(entry.previousResponseAt).toLocaleString('en-IE') : 'No response date'} → {entry.nextResponseAt ? new Date(entry.nextResponseAt).toLocaleString('en-IE') : 'No response date'}</strong>
            <span className="ml-2 text-gray-600 dark:text-gray-300">{new Date(entry.occurredAt).toLocaleString('en-IE')}</span>
            <p>{entry.reason}</p>{entry.evidenceRef ? <p>Evidence: {entry.evidenceRef}</p> : null}
          </li>)}</ol>
          {nextResponseCursor ? <Button className="mt-3" size="sm" variant="flat" isLoading={loadingResponses}
            onPress={() => void loadOlderResponseEvents()}>Load older response changes</Button> : null}

          <h3 className="mt-8 font-semibold">Review state</h3>
          <form onSubmit={submitTriage} className="space-y-4">
            <label className="block text-sm font-medium">Review state
              <select className={`mt-2 ${fieldClass}`} value={nextState} onChange={(event) => setNextState(event.target.value as ReviewState)}>
                {Object.entries(stateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <Textarea label="Reason for change" value={reason} onValueChange={setReason} minRows={2} isRequired
              description="Keep personal details in the controlled case archive; record the assessment step here." />
            <Input label="Opaque evidence reference" value={evidenceRef} onValueChange={setEvidenceRef}
              description="Optional archive reference, uppercase letters, numbers and hyphens only." maxLength={120} />
            <Button type="submit" color="primary" isLoading={saving} isDisabled={saving || nextState === selected.reviewState || reason.trim().length < 10}>Save review state</Button>
          </form>
          <h3 className="mt-6 font-semibold">Review history</h3>
          <ol className="mt-2 space-y-2">{events.map((entry) => <li key={entry.id} className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
            <strong>{entry.previousState ? stateLabels[entry.previousState] : 'Intake'} → {stateLabels[entry.nextState]}</strong>
            <span className="ml-2 text-gray-600 dark:text-gray-300">{new Date(entry.occurredAt).toLocaleString('en-IE')}</span>
            <p>{entry.reason}</p>{entry.evidenceRef ? <p>Evidence: {entry.evidenceRef}</p> : null}
          </li>)}</ol>
          {nextEventCursor ? <Button className="mt-3" size="sm" variant="flat" isLoading={loadingEvents}
            onPress={() => void loadOlderEvents()}>Load older review events</Button> : null}

          <DataLifecycleCoverage key={selected.id} requestId={selected.id} />

          <h3 className="mt-8 font-semibold">Linked Vault documents</h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            Link an exact live Vault document ID only after checking the requester and record in the controlled case archive. This records a review association; it does not approve deletion or establish that every copy was found. The ID remains in case history if an eligible draft is later removed.
          </p>
          <form onSubmit={submitDocumentLink} className="mt-4 grid gap-3 md:grid-cols-2">
            <Input label="Vault document ID" value={documentId} onValueChange={setDocumentId}
              description="Server-issued ID from the controlled Vault record or Governance Audit; no names or file contents."
              maxLength={100} isRequired />
            <Input label="Reason for linking Vault document" value={documentLinkReason} onValueChange={setDocumentLinkReason}
              description="10–500 characters. Keep personal details in the controlled archive."
              maxLength={500} isRequired />
            <div className="md:col-span-2"><Button type="submit" variant="flat" isLoading={saving}
              isDisabled={saving || !/^[A-Za-z0-9_-]{1,100}$/.test(documentId.trim()) || documentLinkReason.trim().length < 10}>
              Link Vault document
            </Button></div>
          </form>
          {loadingDocuments && documentLinks.length === 0 ? <p className="mt-3 text-sm">Loading linked Vault records…</p> : null}
          <ol className="mt-3 space-y-2">{documentLinks.map((link) => <li key={link.id} className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
            <strong>{link.documentId}</strong> · {link.withdrawal ? 'Withdrawn association' : 'Active association'}
            <p className="text-xs text-gray-600 dark:text-gray-300">Linked {new Date(link.createdAt).toLocaleString('en-IE')} by {link.actorUserId}. {link.reason}</p>
            {link.withdrawal ? <p className="text-xs text-amber-800 dark:text-amber-200">Withdrawn {new Date(link.withdrawal.createdAt).toLocaleString('en-IE')} by {link.withdrawal.actorUserId}: {link.withdrawal.reason}</p> : null}
            {!link.withdrawal && withdrawingDocumentLinkId === link.id ? <form className="mt-3 space-y-2" onSubmit={(event) => void submitDocumentWithdrawal(event, link.id)}>
              <Input label={`Reason for withdrawing ${link.documentId}`} value={documentWithdrawalReason} onValueChange={setDocumentWithdrawalReason}
                description="10–500 characters; explain the correction without personal details." maxLength={500} isRequired />
              <Button type="submit" size="sm" variant="flat" isLoading={saving} isDisabled={saving || documentWithdrawalReason.trim().length < 10}>Record withdrawal</Button>
              <Button type="button" size="sm" variant="light" onPress={() => { setWithdrawingDocumentLinkId(null); setDocumentWithdrawalReason(''); }}>Cancel</Button>
            </form> : null}
            {!link.withdrawal && withdrawingDocumentLinkId !== link.id ? <Button className="mt-2" size="sm" variant="light"
              onPress={() => { setWithdrawingDocumentLinkId(link.id); setDocumentWithdrawalReason(''); }}>Withdraw association</Button> : null}
          </li>)}</ol>
          {nextDocumentCursor ? <Button className="mt-3" size="sm" variant="flat" isLoading={loadingDocuments}
            onPress={() => void loadOlderDocumentLinks()}>Load older Vault links</Button> : null}

          <h3 className="mt-8 font-semibold">Linked storage deletion jobs</h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            These are reviewer-recorded associations with technical deletion jobs. A processed job does not establish that this case is complete, that the requester matches the job, or that versions, exports and backups were purged.
          </p>
          <form onSubmit={findSourceJobs} className="mt-4 flex flex-wrap items-end gap-3">
            <Input className="max-w-sm" label="Find jobs by source document ID" value={sourceDocumentId}
              onValueChange={(value) => {
                sourceLookupGeneration.current += 1;
                setSourceDocumentId(value);
                setSourceJobs([]);
                setNextSourceCursor(null);
                setSourceLookupPerformed(false);
                setSourceLookupBusy(false);
                setSourceLookupError('');
              }}
              description="Use the server-issued Vault document ID from the controlled record or audit. Older jobs may have no source ID."
              maxLength={100} isRequired />
            <Button type="submit" variant="flat" isLoading={sourceLookupBusy}
              isDisabled={sourceLookupBusy || !/^[A-Za-z0-9_-]{1,100}$/.test(sourceDocumentId.trim())}>Find jobs</Button>
          </form>
          {sourceLookupError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{sourceLookupError}</p> : null}
          {sourceLookupPerformed && sourceJobs.length === 0 ? <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">No source-labelled storage job was found for this document ID. Legacy and independent cleanup jobs may have no recorded source.</p> : null}
          {sourceJobs.length > 0 ? <ol className="mt-3 space-y-2">{sourceJobs.map((job) => <li key={job.id} className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
            <strong>{job.id}</strong> · {job.provider} · {job.state} · {job.attempts} attempt(s)
            <p className="text-xs text-gray-600 dark:text-gray-300">Created {new Date(job.createdAt).toLocaleString('en-IE')}. Technical job metadata only; confirm the case association in the controlled archive.</p>
            <Button className="mt-2" size="sm" variant="flat" onPress={() => setDeletionId(job.id)}>Use job ID</Button>
          </li>)}</ol> : null}
          {nextSourceCursor ? <Button className="mt-3" size="sm" variant="flat" isLoading={sourceLookupBusy}
            isDisabled={sourceLookupBusy} onPress={() => void loadOlderSourceJobs()}>Load older job matches</Button> : null}
          <form onSubmit={submitStorageLink} className="mt-4 grid gap-3 md:grid-cols-2">
            <Input label="Storage deletion job ID" value={deletionId} onValueChange={setDeletionId}
              description="Copy the exact ID from Governance Audit after checking the controlled case archive."
              maxLength={100} isRequired />
            <Input label="Reason for linking" value={storageLinkReason} onValueChange={setStorageLinkReason}
              description="10–500 characters. Keep names and other personal details in the controlled archive."
              maxLength={500} isRequired />
            <div className="md:col-span-2"><Button type="submit" variant="flat" isLoading={saving}
              isDisabled={saving || !/^[A-Za-z0-9_-]{1,100}$/.test(deletionId.trim()) || storageLinkReason.trim().length < 10}>
              Link storage job
            </Button></div>
          </form>
          <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">Links and withdrawals remain in the audit history. A withdrawn pair cannot be linked again; record a corrected job ID as a new link.</p>
          {loadingStorage && storageLinks.length === 0 ? <p className="mt-3 text-sm">Loading linked jobs…</p> : null}
          <ol className="mt-3 space-y-2">{storageLinks.map((link) => <li key={link.id} className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
            <strong>{link.deletionId}</strong> · {link.withdrawal ? 'Withdrawn association' : 'Active association'} · {link.deletion.provider} · {link.deletion.state} · {link.deletion.attempts} attempt(s)
            <p className="text-xs text-gray-600 dark:text-gray-300">Linked {new Date(link.createdAt).toLocaleString('en-IE')} by {link.actorUserId}. {link.reason}</p>
            {link.deletion.sourceDocumentId ? <p className="text-xs text-gray-600 dark:text-gray-300">Source Vault document ID recorded at removal: {link.deletion.sourceDocumentId}. This identifies the removed record, not every retained copy.</p> : <p className="text-xs text-gray-600 dark:text-gray-300">No source Vault document ID was recorded for this job.</p>}
            {link.withdrawal ? <p className="text-xs text-amber-800 dark:text-amber-200">Withdrawn {new Date(link.withdrawal.createdAt).toLocaleString('en-IE')} by {link.withdrawal.actorUserId}: {link.withdrawal.reason}</p> : null}
            {link.deletion.activeObjectAbsentAt ? <p className="text-xs text-gray-600 dark:text-gray-300">Active primary object observed absent {new Date(link.deletion.activeObjectAbsentAt).toLocaleString('en-IE')}; versions and backups remain unverified.</p> : null}
            {link.deletion.terminalReason ? <p className="text-xs text-red-700 dark:text-red-300">Needs operator review: {link.deletion.terminalReason}</p> : null}
            {!link.withdrawal && withdrawingLinkId === link.id ? <form className="mt-3 space-y-2" onSubmit={(event) => void submitWithdrawal(event, link.id)}>
              <Input label={`Reason for withdrawing ${link.deletionId}`} value={withdrawalReason} onValueChange={setWithdrawalReason}
                description="10–500 characters; explain the correction without personal details." maxLength={500} isRequired />
              <Button type="submit" size="sm" variant="flat" isLoading={saving} isDisabled={saving || withdrawalReason.trim().length < 10}>Record withdrawal</Button>
              <Button type="button" size="sm" variant="light" onPress={() => { setWithdrawingLinkId(null); setWithdrawalReason(''); }}>Cancel</Button>
            </form> : null}
            {!link.withdrawal && withdrawingLinkId !== link.id ? <Button className="mt-2" size="sm" variant="light"
              onPress={() => { setWithdrawingLinkId(link.id); setWithdrawalReason(''); }}>Withdraw association</Button> : null}
          </li>)}</ol>
          {nextStorageCursor ? <Button className="mt-3" size="sm" variant="flat" isLoading={loadingStorage}
            onPress={() => void loadOlderStorageLinks()}>Load older storage links</Button> : null}
        </AppSection> : null}
      </>}
    </AppPage>
  );
}
