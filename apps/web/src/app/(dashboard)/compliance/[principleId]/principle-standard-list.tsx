'use client';

import type { GovernancePrincipleResponse } from '@charitypilot/shared';
import { StandardEditorCard, type SaveState, type StandardFormState } from './standard-editor-card';

export type { SaveState, StandardFormState } from './standard-editor-card';

export function PrincipleStandardList({
  flushSave,
  formState,
  onResolveConflict,
  onRetrySave,
  saveState,
  standards,
  updateField,
}: {
  flushSave: (standardId: string) => Promise<unknown>;
  formState: Record<string, StandardFormState>;
  onResolveConflict: (standardId: string) => Promise<string | null>;
  onRetrySave: (standardId: string, form: StandardFormState) => void;
  saveState: SaveState;
  standards: GovernancePrincipleResponse['standards'];
  updateField: (standardId: string, field: keyof StandardFormState, value: string) => void;
}) {
  return (
    <div className="space-y-6">
      {standards
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((standard) => {
          const form = formState[standard.id];
          if (!form) return null;

          const save = saveState[standard.id] ?? 'idle';

          return (
            <StandardEditorCard
              key={standard.id}
              standard={standard}
              form={form}
              save={save}
              updateField={updateField}
              flushSave={flushSave}
              onRetrySave={onRetrySave}
              onResolveConflict={onResolveConflict}
            />
          );
        })}
    </div>
  );
}
