'use client';

import { useState } from 'react';
import { Button, Input } from '@heroui/react';
import type { GoverningAct, GoverningActStatus } from './use-minute-book-workflow';

const KIND_LABELS: Record<string, string> = {
  BOARD_MEETING: 'Board meeting',
  DIRECTORS_WRITTEN_RESOLUTION: 'Directors’ written resolution',
  MEMBER_WRITTEN_RESOLUTION: 'Member written resolution',
  ANNUAL_GENERAL_MEETING: 'AGM',
  EXTRAORDINARY_GENERAL_MEETING: 'EGM',
};

/**
 * Status carries the whole evidential weight of a minute book, so it is styled
 * to be read at a glance rather than looked up. Anything that is not APPROVED
 * is not evidence of approval, and SUPERSEDED means the record is disowned.
 */
const STATUS_STYLES: Record<GoverningActStatus, { className: string; note?: string }> = {
  APPROVED: { className: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200' },
  CIRCULATED: {
    className: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
    note: 'Circulated but not yet approved — not evidence of approval.',
  },
  DRAFT: {
    className: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
    note: 'Draft minutes — not evidence of approval.',
  },
  SUPERSEDED: {
    className: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
    note: 'Superseded — this record is disowned and must not be relied on.',
  },
  SCHEDULED: { className: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  HELD: { className: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
};

function StatusBadge({ status }: { status: GoverningActStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${STATUS_STYLES[status].className}`}
    >
      {status}
    </span>
  );
}

type Props = {
  acts: GoverningAct[];
  allActs: GoverningAct[];
  canManage: boolean;
  saving: boolean;
  onEdit: (act: GoverningAct) => void;
  onVoid: (act: GoverningAct) => void;
  onAddResolution: (actId: string, text: string, itemNumber: string) => void;
};

export function MinuteBookList({
  acts,
  allActs,
  canManage,
  saving,
  onEdit,
  onVoid,
  onAddResolution,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [draftText, setDraftText] = useState<Record<string, string>>({});
  const [draftItem, setDraftItem] = useState<Record<string, string>>({});

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (acts.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-default-300 p-6 text-center text-sm text-default-500">
        No governing acts match this filter.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {acts.map((act) => {
        const isOpen = expanded.has(act.id);
        const approvedAt = act.approvedAtActId
          ? allActs.find((a) => a.id === act.approvedAtActId)
          : undefined;
        const statusNote = STATUS_STYLES[act.status].note;

        return (
          <li
            key={act.id}
            className={`rounded-xl border p-4 ${
              act.status === 'SUPERSEDED'
                ? 'border-rose-300 bg-rose-50/50 dark:border-rose-900 dark:bg-rose-950/20'
                : 'border-default-200'
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold">{act.reference}</span>
                  <StatusBadge status={act.status} />
                  <span className="text-xs text-default-500">{KIND_LABELS[act.kind] ?? act.kind}</span>
                </div>
                <p className="mt-1 break-words text-sm font-medium">{act.title}</p>
                <p className="mt-0.5 text-xs text-default-500">
                  {act.actDate.slice(0, 10)}
                  {act.statutoryBasis ? ` · ${act.statutoryBasis}` : ''}
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap gap-2">
                <Button size="sm" variant="flat" onPress={() => toggle(act.id)}>
                  {isOpen ? 'Hide' : `Detail (${act.resolutions.length})`}
                </Button>
                {canManage ? (
                  <>
                    <Button size="sm" variant="flat" onPress={() => onEdit(act)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="flat" color="danger" onPress={() => onVoid(act)}>
                      Remove
                    </Button>
                  </>
                ) : null}
              </div>
            </div>

            {statusNote ? (
              <p className="mt-2 rounded-md bg-default-100 px-3 py-2 text-xs text-default-700">
                {statusNote}
              </p>
            ) : null}

            {act.status === 'APPROVED' && act.resolutions.length === 0 ? (
              <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                Approved but carries no resolutions, so nothing here can evidence a decision.
              </p>
            ) : null}

            {isOpen ? (
              <div className="mt-4 border-t border-default-200 pt-4">
                <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-default-500">Minutes approved at</dt>
                    <dd>{approvedAt ? `${approvedAt.reference} — ${approvedAt.title}` : 'No approval recorded'}</dd>
                  </div>
                  <div>
                    <dt className="text-default-500">Approved on</dt>
                    <dd>{act.approvedAt ? act.approvedAt.slice(0, 10) : '—'}</dd>
                  </div>
                </dl>

                {act.notes ? (
                  <p className="mt-3 whitespace-pre-wrap rounded-md bg-default-100 px-3 py-2 text-xs">
                    {act.notes}
                  </p>
                ) : null}

                <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-default-500">
                  Resolutions
                </h4>
                {act.resolutions.length === 0 ? (
                  <p className="mt-1 text-xs text-default-500">None recorded.</p>
                ) : (
                  <ul className="mt-1 flex flex-col gap-2">
                    {act.resolutions.map((r) => (
                      <li key={r.id} className="rounded-md bg-default-100 px-3 py-2 text-xs">
                        <span className="font-medium">{r.itemNumber ? `${r.itemNumber}. ` : ''}</span>
                        <span className="whitespace-pre-wrap">{r.text}</span>
                        {!r.carried ? (
                          <span className="ml-2 font-semibold text-rose-700 dark:text-rose-300">NOT CARRIED</span>
                        ) : null}
                        {r.abstentions ? (
                          <span className="ml-2 text-default-500">Abstentions: {r.abstentions}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}

                {canManage ? (
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <Input
                      size="sm"
                      label="Item"
                      className="w-24"
                      value={draftItem[act.id] ?? ''}
                      onValueChange={(v) => setDraftItem((s) => ({ ...s, [act.id]: v }))}
                    />
                    <Input
                      size="sm"
                      label="Resolution text"
                      className="min-w-56 flex-1"
                      value={draftText[act.id] ?? ''}
                      onValueChange={(v) => setDraftText((s) => ({ ...s, [act.id]: v }))}
                    />
                    <Button
                      size="sm"
                      variant="flat"
                      isDisabled={saving || !(draftText[act.id] ?? '').trim()}
                      onPress={() => {
                        onAddResolution(act.id, draftText[act.id] ?? '', draftItem[act.id] ?? '');
                        setDraftText((s) => ({ ...s, [act.id]: '' }));
                        setDraftItem((s) => ({ ...s, [act.id]: '' }));
                      }}
                    >
                      Add
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
