import { AppError } from '../utils/errors.js';

export type DocumentStorageProviderStage = 'ga' | 'alpha';

export type DocumentStorageProviderDescriptor = {
  id: string;
  stage: DocumentStorageProviderStage;
};

export type DocumentStorageProviderRegistry = {
  list(): DocumentStorageProviderDescriptor[];
  isKnown(id: string): boolean;
  assertSelectable(id: string, options: { alphaOptIn: boolean }): string;
  assertDefaultable(id: string): string;
};

export function createDocumentStorageProviderRegistry(
  descriptors: DocumentStorageProviderDescriptor[],
): DocumentStorageProviderRegistry {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));

  return {
    list() {
      return [...byId.values()];
    },

    isKnown(id: string) {
      return byId.has(id);
    },

    assertSelectable(id: string, options: { alphaOptIn: boolean }) {
      const descriptor = byId.get(id);
      if (!descriptor) {
        throw new AppError(400, 'STORAGE_PROVIDER_UNKNOWN', 'That document storage provider is not available.');
      }
      if (descriptor.stage === 'alpha' && !options.alphaOptIn) {
        throw new AppError(
          400,
          'STORAGE_PROVIDER_ALPHA_NOT_ENABLED',
          'That document storage provider is in alpha and has not been enabled for this organisation.',
        );
      }
      return descriptor.id;
    },

    assertDefaultable(id: string) {
      const descriptor = byId.get(id);
      if (!descriptor) {
        throw new AppError(500, 'STORAGE_PROVIDER_UNKNOWN', 'The configured document storage provider is not recognised.');
      }
      if (descriptor.stage === 'alpha') {
        throw new AppError(
          500,
          'STORAGE_PROVIDER_ALPHA_NOT_DEFAULTABLE',
          'An alpha document storage provider cannot be the deployment default.',
        );
      }
      return descriptor.id;
    },
  };
}

// Phase 0 ships ga providers only. Confluence joins this list as `alpha`
// in Phase 1 — see docs/superpowers/plans/2026-09-18-document-storage-providers-spec.md.
export const documentStorageProviders = createDocumentStorageProviderRegistry([
  { id: 'supabase', stage: 'ga' },
  { id: 'local', stage: 'ga' },
]);
