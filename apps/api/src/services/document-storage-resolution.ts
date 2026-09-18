import {
  documentStorageProviders,
  type DocumentStorageProviderRegistry,
} from './document-storage-provider.js';

export type OrganisationStorageSelection = {
  /** null means "no preference recorded — use the deployment default". */
  provider: string | null;
  alphaOptIn: boolean;
};

export type OrganisationStorageResolver = (
  organisationId: string,
) => Promise<OrganisationStorageSelection>;

/**
 * The deployment-wide default.
 *
 * Historically this was `DOCUMENT_STORAGE_DRIVER === 'local'`, with every other
 * value — including empty or misspelled ones — meaning Supabase. That fallback
 * is preserved deliberately: an unknown value must not start throwing on a
 * deployment that has been running happily. Only a value that names a KNOWN
 * provider is passed to the registry, which is what lets the alpha gate refuse
 * an alpha provider named here.
 */
export function envDefaultProviderId(
  registry: DocumentStorageProviderRegistry = documentStorageProviders,
): string {
  const configured = process.env.DOCUMENT_STORAGE_DRIVER;
  if (!configured || !registry.isKnown(configured)) return 'supabase';
  return registry.assertDefaultable(configured);
}

export async function resolveProviderForOrganisation(
  organisationId: string,
  resolver: OrganisationStorageResolver | null,
  registry: DocumentStorageProviderRegistry = documentStorageProviders,
): Promise<string> {
  if (!resolver) return envDefaultProviderId(registry);

  const selection = await resolver(organisationId);
  if (!selection.provider) return envDefaultProviderId(registry);

  return registry.assertSelectable(selection.provider, { alphaOptIn: selection.alphaOptIn });
}
