'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Input, Textarea } from '@heroui/react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { apiErrorMessage } from '@/lib/errors';
import { ConfirmActionModal } from '@/components/ui/confirm-action-modal';
import { ComplaintDispositionEvidence } from '../documents/document-disposition-evidence';

const base='/governance-registers/complaints';
const areas=['PRIMARY','SNAPSHOTS','EXPORTS','AUDIT','BACKUPS','OTHER_COPIES'] as const;
type Area=typeof areas[number];
type Disposition='DISPOSE'|'RETAIN_APPROVED'|'NOT_APPLICABLE';
type Plan=Record<Area,{disposition:Disposition|'';evidenceRef:string}>;
const emptyPlan=():Plan=>Object.fromEntries(areas.map(area=>[area,{disposition:area==='PRIMARY'?'DISPOSE':'',evidenceRef:''}])) as Plan;
const label=(area:Area)=>({PRIMARY:'Primary complaint record',SNAPSHOTS:'Approved report snapshots',EXPORTS:'Downloaded and shared exports',AUDIT:'Audit and retained evidence',BACKUPS:'Backups',OTHER_COPIES:'Other copies and attachments'})[area];
type Removed={id:string;summary:string;revision:number;removal:{id:string;recoveryUntil:string;evidenceRef:string}};
type Policy={id:string;revision:number;state:string;retentionMode:string;withdrawal:unknown};
type Authorization={id:string;complaintId:string;recordRevision:number;holdRevision:number;removalId:string;policyId:string;
  recoveryUntil:string;dispositionPlan:Plan;evidenceRef:string;reason:string;authorizedAt:string;
  withdrawal:{evidenceRef:string;reason:string}|null;claim:{id:string;claimedAt:string}|null};
type Page<T>={items:T[];nextCursor:string|null};
type ReviewInput={expectedRecordRevision:number;expectedHoldRevision:number;removalId:string;recoveryUntil:string;
  policyId:string;evidenceRef:string;reason:string;authorityConfirmed:true;dispositionPlan:Plan};
type Action={kind:'authorize';complaintId:string;input:ReviewInput}|{kind:'claim'|'withdraw';authorization:Authorization};
const referenceValid=(value:string)=>/^[A-Z0-9][A-Z0-9-]{2,119}$/.test(value);
const reasonValid=(value:string)=>value.trim().length>=10&&value.trim().length<=500&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);

export function ComplaintPurgePanel({onDisposed}:{onDisposed:()=>void}) {
  const {user}=useAuth();
  return user?.role==='OWNER'?<OwnerComplaintPurgePanel onDisposed={onDisposed}/>:null;
}
function OwnerComplaintPurgePanel({onDisposed}:{onDisposed:()=>void}) {
  const [records,setRecords]=useState<Page<Removed>>({items:[],nextCursor:null});
  const [history,setHistory]=useState<Page<Authorization>>({items:[],nextCursor:null});
  const [selected,setSelected]=useState('');
  const [hold,setHold]=useState<{held:boolean;holdRevision:number;recordRevision:number}|null>(null);
  const [policy,setPolicy]=useState<Policy|null>(null);
  const [plan,setPlan]=useState<Plan>(emptyPlan);
  const [reference,setReference]=useState('');const [reason,setReason]=useState('');
  const [action,setAction]=useState<Action|null>(null);const [confirmed,setConfirmed]=useState(false);
  const [withdrawRef,setWithdrawRef]=useState('');const [withdrawReason,setWithdrawReason]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const serial=useRef(0);const selectionSerial=useRef(0);const pending=useRef(false);
  const load=useCallback(async()=>{
    const current=++serial.current;setBusy(true);setError('');
    try {
      const [removed,reviews]=await Promise.all([api.get<Page<Removed>>(`${base}/removed`),api.get<Page<Authorization>>(`${base}/purge-authorizations`)]);
      // An approved revision can sit behind newer drafts. Follow policy pages
      // rather than silently treating the first fifty as the complete authority.
      let before:number|undefined;const approved:Policy[]=[];
      do {
        const response=await api.get<{items:Policy[];nextBefore:number|null}>(`${base}/policy-revisions`,{params:before?{before}:{}});
        approved.push(...response.data.items.filter(item=>item.state==='APPROVED'&&!item.withdrawal));
        before=response.data.nextBefore??undefined;
      } while(before!==undefined);
      if(current!==serial.current)return;
      setRecords(removed.data);setHistory(reviews.data);setPolicy(approved.length===1?approved[0]:null);
    } catch(cause) {if(current===serial.current)setError(apiErrorMessage(cause,'Complaint disposal review could not be loaded.'));}
    finally {if(current===serial.current)setBusy(false);}
  },[]);
  useEffect(()=>{const counter=serial;void load();return()=>{counter.current++;};},[load]);
  useEffect(()=>{
    const counter=selectionSerial;const current=++counter.current;setHold(null);
    if(selected) void api.get<{held:boolean;holdRevision:number;recordRevision:number}>(`${base}/${encodeURIComponent(selected)}/holds`)
      .then(response=>{if(current===counter.current)setHold(response.data);})
      .catch(cause=>{if(current===counter.current)setError(apiErrorMessage(cause,'The current hold could not be checked.'));});
    return()=>{counter.current++;};
  },[selected,records]);
  const record=records.items.find(item=>item.id===selected);
  const valid=record&&hold&&!hold.held&&hold.recordRevision===record.revision&&policy&&policy.retentionMode!=='PERMANENT'
    &&referenceValid(reference)&&reasonValid(reason)&&areas.every(area=>plan[area].disposition&&referenceValid(plan[area].evidenceRef));
  function review(next:Action) {setError('');setConfirmed(false);setWithdrawRef('');setWithdrawReason('');setAction(next);}
  async function execute() {
    if(!action||pending.current||!confirmed)return;
    if(action.kind==='withdraw'&&(!referenceValid(withdrawRef)||!reasonValid(withdrawReason)))return;
    pending.current=true;setBusy(true);setError('');
    try {
      if(action.kind==='authorize') await api.post(`${base}/${encodeURIComponent(action.complaintId)}/purge-authorizations`,action.input);
      else await api.post(`${base}/purge-authorizations/${encodeURIComponent(action.authorization.id)}/${action.kind}`,
        action.kind==='claim'?{confirmPermanentPurge:true}:{evidenceRef:withdrawRef,reason:withdrawReason.trim()});
      if(action.kind==='claim')onDisposed();
      setAction(null);await load();
    } catch(cause) {setError(apiErrorMessage(cause,'The action could not proceed. Reload the complaint disposal review.'));}
    finally {pending.current=false;setBusy(false);}
  }
  async function older(kind:'records'|'history') {
    if(busy)return;setBusy(true);setError('');
    try {
      if(kind==='records'&&records.nextCursor) {
        const response=await api.get<Page<Removed>>(`${base}/removed`,{params:{before:records.nextCursor}});
        setRecords(current=>({items:[...current.items,...response.data.items],nextCursor:response.data.nextCursor}));
      } else if(kind==='history'&&history.nextCursor) {
        const response=await api.get<Page<Authorization>>(`${base}/purge-authorizations`,{params:{before:history.nextCursor}});
        setHistory(current=>({items:[...current.items,...response.data.items],nextCursor:response.data.nextCursor}));
      }
    } catch(cause) {setError(apiErrorMessage(cause,'Older disposal reviews could not be loaded.'));}
    finally {setBusy(false);}
  }
  return <section aria-label="Complaint permanent disposal" className="space-y-4 rounded-lg border p-4">
    <h2 className="text-lg font-semibold">Complaint permanent disposal</h2>
    <p>Owner review is separate from moving a complaint to recovery. Permanent disposal removes the primary complaint record after its retention and original recovery periods expire. Approved snapshots, audit evidence, exports, backups and other copies require their own disposition evidence.</p>
    <Button isDisabled={busy} onPress={()=>void load()}>Reload complaint disposal review</Button>
    {error?<p role="alert">{error}</p>:null}
    <label className="block">Complaint for disposal review<select className="block w-full rounded border p-2" value={selected} disabled={busy} onChange={event=>{setSelected(event.target.value);setPlan(emptyPlan());setReference('');setReason('');}}>
      <option value="">Select a removed complaint</option>{records.items.map(item=><option key={item.id} value={item.id}>{item.summary}</option>)}
    </select></label>
    {records.nextCursor?<Button isDisabled={busy} onPress={()=>void older('records')}>Load older removed complaints for disposal</Button>:null}
    {record?<div className="space-y-3">
      <p>Original recovery deadline: {new Date(record.removal.recoveryUntil).toLocaleString()}. Removal reference: {record.removal.evidenceRef}.</p>
      <p>{hold?.held?'An administrative hold blocks disposal.':hold?'No active administrative hold at this review.':'Checking current hold…'}</p>
      <p>{policy?`Current approved policy: revision ${policy.revision} (${policy.retentionMode}).`:'A current approved complaint policy is required.'}</p>
      {areas.map(area=><fieldset key={area} className="rounded border p-2"><legend>{label(area)}</legend>
        <label>Planned disposition — {label(area)}<select aria-label={`Planned disposition — ${label(area)}`} className="block rounded border p-2" value={plan[area].disposition} disabled={busy||area==='PRIMARY'} onChange={event=>setPlan(current=>({...current,[area]:{...current[area],disposition:event.target.value as Disposition}}))}>
          <option value="">Choose after reviewing this scope</option><option value="DISPOSE">Dispose</option><option value="RETAIN_APPROVED">Retain under reviewed authority</option><option value="NOT_APPLICABLE">Not applicable after review</option>
        </select></label>
        <Input label={`Copy-plan reference — ${label(area)}`} value={plan[area].evidenceRef} maxLength={120} isDisabled={busy} onValueChange={value=>setPlan(current=>({...current,[area]:{...current[area],evidenceRef:value}}))}/>
      </fieldset>)}
      <Input label="Complaint disposal authority reference" value={reference} onValueChange={setReference} maxLength={120} isDisabled={busy}/>
      <Textarea label="Complaint disposal review reason" value={reason} onValueChange={setReason} maxLength={500} isDisabled={busy} description="Use controlled references; do not copy personal case details."/>
      <Button isDisabled={busy||!valid} onPress={()=>review({kind:'authorize',complaintId:record.id,input:{expectedRecordRevision:record.revision,expectedHoldRevision:hold!.holdRevision,
        removalId:record.removal.id,recoveryUntil:record.removal.recoveryUntil,policyId:policy!.id,evidenceRef:reference,reason:reason.trim(),authorityConfirmed:true,dispositionPlan:plan}})}>Review complaint disposal authority</Button>
    </div>:null}
    <h3 className="font-semibold">Retained disposal reviews</h3>
    {history.items.length===0?<p>No complaint disposal reviews recorded.</p>:null}
    <ol aria-label="Complaint disposal history" className="space-y-3">{history.items.map(item=><li key={item.id} className="rounded border p-3 space-y-2">
      <p>Complaint {item.complaintId} — {item.evidenceRef} — {new Date(item.authorizedAt).toLocaleString()}</p><p>{item.reason}</p>
      <p>Recovery deadline: {new Date(item.recoveryUntil).toLocaleString()}</p>
      <ul>{areas.map(area=><li key={area}>{label(area)}: {item.dispositionPlan[area].disposition} ({item.dispositionPlan[area].evidenceRef})</li>)}</ul>
      {item.claim?<p>Primary complaint record disposed on {new Date(item.claim.claimedAt).toLocaleString()}. Receipt: {item.claim.id}. This does not establish erasure of retained copies.</p>
        :item.withdrawal?<p>Withdrawn: {item.withdrawal.evidenceRef} — {item.withdrawal.reason}</p>
          :<><Button isDisabled={busy} onPress={()=>review({kind:'withdraw',authorization:item})}>Review withdrawal of {item.evidenceRef}</Button>
            <Button color="danger" isDisabled={busy} onPress={()=>review({kind:'claim',authorization:item})}>Review permanent disposal of {item.evidenceRef}</Button></>}
      {item.claim?<ComplaintDispositionEvidence authorizationId={item.id} plan={item.dispositionPlan} isOwner={true}/>:null}
    </li>)}</ol>
    {history.nextCursor?<Button isDisabled={busy} onPress={()=>void older('history')}>Load older complaint disposal reviews</Button>:null}
    <ConfirmActionModal isOpen={action!==null} onOpenChange={open=>{if(!open&&!busy)setAction(null);}}
      title={action?.kind==='claim'?'Permanently dispose of primary complaint':action?.kind==='withdraw'?'Withdraw complaint disposal authority':'Record complaint disposal authority'}
      confirmLabel={action?.kind==='claim'?'Permanently dispose of primary complaint':action?.kind==='withdraw'?'Withdraw complaint disposal authority':'Record complaint disposal authority'}
      confirming={busy} confirmDisabled={!confirmed||(action?.kind==='withdraw'&&(!referenceValid(withdrawRef)||!reasonValid(withdrawReason)))} onConfirm={()=>void execute()}>
      <p>{action?.kind==='claim'?'This cannot be undone through complaint recovery. The server will recheck policy, ownership, holds, retention and the original recovery deadline.':action?.kind==='withdraw'?'Withdraw this unclaimed authority while retaining its review history.':'Record this reviewed plan. This step does not delete the complaint.'}</p>
      <p>Review reference: {action?.kind==='authorize'?action.input.evidenceRef:action?.authorization.evidenceRef}</p>
      <p>Complaint: {action?.kind==='authorize'?action.complaintId:action?.authorization.complaintId}</p>
      <p>Original recovery deadline: {action?new Date(action.kind==='authorize'?action.input.recoveryUntil:action.authorization.recoveryUntil).toLocaleString():''}</p>
      {action?.kind==='withdraw'?<><Input label="Complaint disposal withdrawal reference" value={withdrawRef} onValueChange={setWithdrawRef}/><Textarea label="Complaint disposal withdrawal reason" value={withdrawReason} onValueChange={setWithdrawReason}/></>:null}
      <Checkbox isSelected={confirmed} onValueChange={setConfirmed} isDisabled={busy}>I have reviewed this exact action and have authority to proceed.</Checkbox>
      {!confirmed?<p>Confirmation is required before this action can proceed.</p>:null}
      {action?.kind==='withdraw'&&(!referenceValid(withdrawRef)||!reasonValid(withdrawReason))?<p>Enter a controlled reference and a reason of 10–500 characters.</p>:null}
      {error?<p role="alert">{error}</p>:null}
    </ConfirmActionModal>
  </section>;
}
