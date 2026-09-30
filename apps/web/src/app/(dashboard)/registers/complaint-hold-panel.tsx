'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Textarea } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { ConfirmActionModal } from '@/components/ui/confirm-action-modal';

type Event = { id: string; revision: number; held: boolean; evidenceRef: string; reason: string; occurredAt: string };
type Page = { recordRevision: number; holdRevision: number; held: boolean; items: Event[]; nextBeforeRevision: number | null };
type Review = { expectedRecordRevision: number; expectedHoldRevision: number; held: boolean; evidenceRef: string; reason: string };

export function ComplaintHoldPanel({ id, onChanged }: { id: string; onChanged?: () => void }) {
  const [page,setPage]=useState<Page|null>(null);
  const [reference,setReference]=useState('');
  const [reason,setReason]=useState('');
  const [review,setReview]=useState<Review|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const pending=useRef(false);
  const sequence=useRef(0);
  const root=`/governance-registers/complaints/${encodeURIComponent(id)}/holds`;
  const load=useCallback(async(before?:number)=>{
    const serial=++sequence.current;
    setBusy(true); setError('');
    try {
      const response=await api.get<Page>(root,{params:before?{before}:{}});
      if(serial!==sequence.current) return;
      setPage(current=>({...response.data,items:before?[...(current?.items??[]),...response.data.items]:response.data.items}));
    } catch(cause) {
      if(serial===sequence.current) {setPage(null);setError(apiErrorMessage(cause,'Hold history could not be loaded.'));}
    } finally {if(serial===sequence.current)setBusy(false);}
  },[root]);
  useEffect(()=>{const counter=sequence;void load();return()=>{counter.current++;};},[load]);
  async function save() {
    if(!review || pending.current)return;
    pending.current=true;setBusy(true);setError('');
    try {
      await api.post(root,review);
      setReview(null);setReference('');setReason('');
      await load();onChanged?.();
    } catch(cause) {setError(apiErrorMessage(cause,'The hold could not be changed. Reload and review again.'));}
    finally {pending.current=false;setBusy(false);}
  }
  const valid=page && /^[A-Z0-9][A-Z0-9-]{2,119}$/.test(reference) && reason.trim().length>=10 && reason.trim().length<=500 && !/[\u0000-\u001f\u007f-\u009f]/.test(reason);
  return <section aria-label="Complaint administrative hold" className="space-y-3 rounded border p-3">
    <h3 className="font-semibold">Administrative hold</h3>
    <p>A hold prevents removal and permanent disposal. Restoring a complaint preserves its hold. This records an administrative preservation decision, not a legal-hold determination.</p>
    <Button isDisabled={busy} onPress={()=>void load()}>Reload complaint hold</Button>
    {error?<p role="alert">{error}</p>:null}
    {page?<>
      <p role="status">{page.held?'Hold active — removal blocked.':'No active administrative hold.'}</p>
      <Input label="Hold evidence reference" value={reference} onValueChange={setReference} maxLength={120} isDisabled={busy} description="Use a controlled reference, not personal case details." />
      <Textarea label="Reason for hold change" value={reason} onValueChange={setReason} maxLength={500} isDisabled={busy} description="Explain why preservation is needed or why it may end, without copying complaint details." />
      <Button isDisabled={!valid || busy} onPress={()=>setReview({expectedRecordRevision:page.recordRevision,
        expectedHoldRevision:page.holdRevision,held:!page.held,evidenceRef:reference,reason:reason.trim()})}>
        {page.held?'Review hold release':'Review applying hold'}
      </Button>
      <ol>{page.items.map(event=><li key={event.id} className="mt-2 rounded border p-2">
        <p>Revision {event.revision}: {event.held?'Hold applied':'Hold released'} · {new Date(event.occurredAt).toLocaleString()}</p>
        <p>{event.evidenceRef} · {event.reason}</p>
      </li>)}</ol>
      {page.items.length===0?<p>No hold changes recorded.</p>:null}
      {page.nextBeforeRevision?<Button isDisabled={busy} onPress={()=>void load(page.nextBeforeRevision!)}>Load older hold changes</Button>:null}
    </>:null}
    <ConfirmActionModal isOpen={review!==null} onOpenChange={open=>{if(!open&&!busy)setReview(null);}}
      title={review?.held?'Apply complaint hold':'Release complaint hold'} confirmLabel={review?.held?'Apply hold':'Release hold'} confirming={busy} onConfirm={()=>void save()}>
      <p>{review?.held?'Prevent removal while this complaint needs preservation.':'Release this administrative hold. Retention and recovery rules continue to apply.'}</p>
      <p>{review?.evidenceRef} · {review?.reason}</p>
      {error?<p role="alert">{error}</p>:null}
    </ConfirmActionModal>
  </section>;
}
