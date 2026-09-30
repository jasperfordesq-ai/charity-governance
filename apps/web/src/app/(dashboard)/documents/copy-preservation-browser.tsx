'use client';

import { useRef, useState } from 'react';
import { Button, Input } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { CopyPreservationReview } from './copy-preservation-review';

type Claim = { id: string; authorizationId: string; claimedAt: string };
type Scope = { id: string; area: string; scopeRef: string; revision: number };
export function CopyPreservationBrowser({ kind }: { kind: 'document' | 'complaint' }) {
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Claim | null>(null);
  const [scopes, setScopes] = useState<Scope[] | null>(null);
  const [scopeCursor, setScopeCursor] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [area, setArea] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const prefix = kind === 'complaint' ? '/governance-registers/complaints' : '/documents';
  const areas = kind === 'complaint' ? ['SNAPSHOTS','EXPORTS','AUDIT','BACKUPS','OTHER_COPIES'] : ['VERSIONS','CONFLUENCE','EXPORTS','AUDIT','BACKUPS'];
  const load = async (older = false) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setScope(null); setSelected(null); setScopes(null);
    if (!older) setClaims(null);
    try {
      const { data } = await api.get<{ data: Claim[]; nextCursor: string | null }>(`/governance-audit/${kind}-purge-claims`, { params: older && cursor ? { before: cursor } : {} });
      setClaims(previous => older ? [...(previous ?? []), ...data.data] : data.data); setCursor(data.nextCursor);
    } catch (cause) { setClaims(null); setCursor(null); setError(apiErrorMessage(cause, 'Disposal claims could not be loaded.')); }
    finally { pending.current = false; setBusy(false); }
  };
  const loadScopes = async (claim: Claim, older = false) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setScope(null); setSelected(claim); setArea(''); setReference('');
    if (!older) { setScopes(null); setScopeCursor(null); }
    try {
      const { data } = await api.get<{ items: Scope[]; nextCursor: string | null }>(`${prefix}/purge-authorizations/${encodeURIComponent(claim.authorizationId)}/copy-scopes`, { params: older && scopeCursor ? { before: scopeCursor } : {} });
      setScopes(previous => older ? [...(previous ?? []), ...data.items] : data.items); setScopeCursor(data.nextCursor);
    } catch (cause) { setScopes(null); setScopeCursor(null); setError(apiErrorMessage(cause, 'Copy scopes could not be loaded.')); }
    finally { pending.current = false; setBusy(false); }
  };
  return <section aria-label="Copy preservation administration" className="space-y-3 rounded border p-5">
    <h2 className="font-semibold">Copy preservation administration</h2>
    <p>Find copies following primary disposal and record preservation holds. Owner disposal authority remains a separate review. The claim does not establish that every copy was erased.</p>
    <Button size="sm" isDisabled={busy} onPress={() => load()}>Load claimed disposal reviews</Button>
    {error ? <p role="alert">{error}</p> : null}
    {claims?.length === 0 ? <p>No primary disposal claims recorded.</p> : null}
    <ul>{claims?.map(claim => <li key={claim.id} className="my-2">
      <p>Review {claim.authorizationId} · claimed {new Date(claim.claimedAt).toLocaleString('en-IE')}</p>
      <Button size="sm" variant="flat" isDisabled={busy} onPress={() => loadScopes(claim)}>Review copies for {claim.authorizationId}</Button>
    </li>)}</ul>
    {cursor ? <Button size="sm" isDisabled={busy} onPress={() => load(true)}>Load older disposal claims</Button> : null}
    {selected && scopes !== null ? <>
      <h3>Copy scopes for review {selected.authorizationId}</h3>
      <ul>{scopes.filter(row => !scopes.some(other => other.area === row.area && other.scopeRef === row.scopeRef && other.revision > row.revision)).map(row => <li key={row.id}>
        <Button size="sm" variant="flat" isDisabled={busy || !!scopeCursor} onPress={() => setScope(row)}>Preserve {row.area} · {row.scopeRef} · revision {row.revision}</Button>
      </li>)}</ul>
      {scopeCursor ? <><p>Load the remaining observations before selecting a scope.</p><Button size="sm" isDisabled={busy} onPress={() => loadScopes(selected, true)}>Load older copy scopes</Button></> : <>
        <p>For a newly discovered copy, enter its controlled reference. The server rejects an existing scope with a stale observation revision.</p>
        <label>New copy location<select aria-label="New copy preservation location" value={area} disabled={busy} onChange={event => { setArea(event.target.value); setScope(null); }}>
          <option value="">Choose location</option>{areas.map(value => <option key={value}>{value}</option>)}
        </select></label>
        <Input label="New copy preservation reference" value={reference} maxLength={120} isDisabled={busy} onValueChange={value => { setReference(value); setScope(null); }} />
        <Button size="sm" isDisabled={busy || !area || !/^[A-Z0-9][A-Z0-9-]{2,119}$/.test(reference)} onPress={() => setScope({ id: 'new', area, scopeRef: reference, revision: 0 })}>Review newly discovered copy hold</Button>
      </>}
      {scope ? <CopyPreservationReview key={`${selected.authorizationId}:${scope.area}:${scope.scopeRef}:${scope.revision}`} kind={kind} authorizationId={selected.authorizationId} area={scope.area} scopeRef={scope.scopeRef} observationRevision={scope.revision} /> : null}
    </> : null}
  </section>;
}
