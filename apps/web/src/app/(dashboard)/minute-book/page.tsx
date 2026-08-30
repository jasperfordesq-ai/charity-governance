'use client';

import { Button, Select, SelectItem } from '@heroui/react';
import { useDocumentTitle } from '@/lib/use-title';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { ErrorState, LoadingState, PermissionHint } from '@/components/ui/states';
import { MinuteBookList } from './minute-book-list';
import { ActModal, VoidModal } from './minute-book-modals';
import {
  GOVERNING_ACT_KINDS,
  GOVERNING_ACT_STATUSES,
  useMinuteBookWorkflow,
  type GoverningActKind,
  type GoverningActStatus,
} from './use-minute-book-workflow';

export default function MinuteBookPage() {
  useDocumentTitle('Minute Book');
  const {
    acts,
    visibleActs,
    voids,
    attention,
    loading,
    loadError,
    saving,
    formError,
    canManage,
    kindFilter,
    setKindFilter,
    statusFilter,
    setStatusFilter,
    modalMode,
    form,
    updateForm,
    openCreate,
    openEdit,
    closeModal,
    submitAct,
    addResolution,
    voidTarget,
    voidReason,
    setVoidReason,
    openVoid,
    closeVoid,
    confirmVoid,
    refresh,
  } = useMinuteBookWorkflow();

  return (
    <AppPage
      eyebrow="Governance"
      title="Minute Book"
      description="Every governing act of the charity — board meetings, written resolutions, AGMs — with the resolutions passed at each and what approved its minutes."
      actions={
        canManage ? (
          <Button color="primary" className={primaryActionButtonClassName} onPress={openCreate}>
            Add governing act
          </Button>
        ) : null
      }
    >
      {loading ? (
        <LoadingState title="Loading the minute book" description="Reading every recorded governing act." />
      ) : loadError ? (
        <ErrorState
          title="The minute book could not be loaded"
          description={loadError}
          action={
            <Button size="sm" variant="flat" onPress={() => refresh()}>
              Try again
            </Button>
          }
        />
      ) : (
        <>
          {(attention.superseded.length > 0 ||
            attention.unapproved.length > 0 ||
            attention.withoutResolutions.length > 0) && (
            <AppSection
              title="Needs attention"
              description="Records that cannot be relied on as evidence of a decision."
            >
              <ul className="flex flex-col gap-2 text-sm">
                {attention.superseded.length > 0 && (
                  <li className="rounded-lg bg-rose-50 px-4 py-3 text-rose-900 dark:bg-rose-950/30 dark:text-rose-200">
                    <span className="font-semibold">{attention.superseded.length} superseded</span> —
                    disowned records still held in the book. Remove any that should never have
                    existed; the removal is audited.
                  </li>
                )}
                {attention.unapproved.length > 0 && (
                  <li className="rounded-lg bg-amber-50 px-4 py-3 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                    <span className="font-semibold">{attention.unapproved.length} draft or circulated</span>{' '}
                    — minutes are not evidence of approval until approved at a later meeting.
                  </li>
                )}
                {attention.withoutResolutions.length > 0 && (
                  <li className="rounded-lg bg-amber-50 px-4 py-3 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                    <span className="font-semibold">
                      {attention.withoutResolutions.length} approved with no resolutions
                    </span>{' '}
                    — nothing recorded that could evidence a decision.
                  </li>
                )}
              </ul>
            </AppSection>
          )}

          <AppSection
            title={`Governing acts (${visibleActs.length} of ${acts.length})`}
            description="The whole book, every year. Filter to narrow it."
            actions={
              <div className="flex flex-wrap gap-2">
                <Select
                  label="Kind"
                  className="w-56"
                  size="sm"
                  selectedKeys={kindFilter ? new Set([kindFilter]) : new Set()}
                  placeholder="All kinds"
                  onSelectionChange={(keys) =>
                    setKindFilter((Array.from(keys)[0] as GoverningActKind | undefined) ?? '')
                  }
                >
                  {GOVERNING_ACT_KINDS.map((k) => (
                    <SelectItem key={k}>{k.replaceAll('_', ' ').toLowerCase()}</SelectItem>
                  ))}
                </Select>
                <Select
                  label="Status"
                  className="w-44"
                  size="sm"
                  selectedKeys={statusFilter ? new Set([statusFilter]) : new Set()}
                  placeholder="All statuses"
                  onSelectionChange={(keys) =>
                    setStatusFilter((Array.from(keys)[0] as GoverningActStatus | undefined) ?? '')
                  }
                >
                  {GOVERNING_ACT_STATUSES.map((s) => (
                    <SelectItem key={s}>{s}</SelectItem>
                  ))}
                </Select>
              </div>
            }
          >
            {!canManage ? (
              <PermissionHint>
                Owners and administrators can add, edit and remove governing acts.
              </PermissionHint>
            ) : null}

            {formError && modalMode === 'closed' && voidTarget === null ? (
              <p className="mb-3 rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-700">{formError}</p>
            ) : null}

            <MinuteBookList
              acts={visibleActs}
              allActs={acts}
              canManage={canManage}
              saving={saving}
              onEdit={openEdit}
              onVoid={openVoid}
              onAddResolution={addResolution}
            />
          </AppSection>

          <AppSection
            title={`Removed records (${voids.length})`}
            description="Governing acts deleted from the book. The snapshot, who removed it and why are kept permanently."
          >
            {voids.length === 0 ? (
              <p className="rounded-lg border border-dashed border-default-300 p-6 text-center text-sm text-default-500">
                Nothing has been removed.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {voids.map((v) => (
                  <li key={v.id} className="rounded-lg border border-default-200 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-semibold">{v.reference}</span>
                      <span className="text-xs text-default-500">
                        {v.actDate.slice(0, 10)} · was {v.status} · {v.resolutionCount} resolution
                        {v.resolutionCount === 1 ? '' : 's'}
                      </span>
                    </div>
                    <p className="mt-0.5">{v.title}</p>
                    <p className="mt-1 whitespace-pre-wrap rounded-md bg-default-100 px-3 py-2 text-xs">
                      {v.reason}
                    </p>
                    <p className="mt-1 text-xs text-default-500">
                      Removed by {v.voidedByEmail} on {v.voidedAt.slice(0, 10)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </AppSection>
        </>
      )}

      <ActModal
        mode={modalMode}
        form={form}
        updateForm={updateForm}
        formError={formError}
        saving={saving}
        onClose={closeModal}
        onSubmit={submitAct}
      />

      <VoidModal
        target={voidTarget}
        reason={voidReason}
        setReason={setVoidReason}
        formError={formError}
        saving={saving}
        onClose={closeVoid}
        onConfirm={confirmVoid}
      />
    </AppPage>
  );
}
