import {
  documentStorageProviders,
  type DocumentStorageProviderRegistry,
} from './document-storage-provider.js';
// Imported from deployment-profile.js rather than from env.js (which
// re-exports it) because env.ts imports envDefaultProviderId from this module
// for its production boot check; taking it from env.js would make that a cycle.
import { isProductionEnv } from '../utils/deployment-profile.js';
import { AppError } from '../utils/errors.js';

const LOCAL_PROVIDER_ID = 'local';

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

/**
 * The deployment-level veto on an otherwise selectable provider.
 *
 * A production deployment forbids `DOCUMENT_STORAGE_DRIVER=local`
 * (`requireProductionDocumentStorageDriver`, `utils/env.ts`) and validates
 * `LOCAL_FILE_STORAGE_DIR` — absolute, non-root — only inside the branch that
 * the local driver selects. So an organisation row naming `local` on a
 * Supabase-default production deployment would reach the local branch of
 * `uploadFile` with none of that validation having run, writing bytes to the
 * *relative* `.charitypilot-local-storage/documents` default: inside the
 * container, ephemeral, outside the backup story, on a deployment that
 * deliberately forbids local storage.
 *
 * A production deployment whose own driver IS local has already passed that
 * validation, so an organisation naming `local` there is asking for exactly
 * what the deployment already does, and is allowed.
 *
 * This lives here, in the layer that validates the per-organisation choice,
 * not in StorageService: StorageService acts on a provider id that has already
 * been agreed to be usable.
 */
function assertProviderPermittedByDeployment(
  provider: string,
  registry: DocumentStorageProviderRegistry,
): string {
  if (provider !== LOCAL_PROVIDER_ID) return provider;
  if (!isProductionEnv()) return provider;
  if (envDefaultProviderId(registry) === LOCAL_PROVIDER_ID) return provider;

  throw new AppError(
    500,
    'STORAGE_PROVIDER_NOT_PERMITTED_IN_PRODUCTION',
    'Local document storage cannot be selected per organisation on a production deployment that does not itself use local storage.',
  );
}

export async function resolveProviderForOrganisation(
  organisationId: string,
  resolver: OrganisationStorageResolver | null,
  registry: DocumentStorageProviderRegistry = documentStorageProviders,
): Promise<string> {
  if (!resolver) return envDefaultProviderId(registry);

  const selection = await resolver(organisationId);
  if (!selection.provider) return envDefaultProviderId(registry);

  return assertProviderPermittedByDeployment(
    registry.assertSelectable(selection.provider, { alphaOptIn: selection.alphaOptIn }),
    registry,
  );
}

type OrganisationStorageDelegate = {
  organisation: {
    findUnique(args: {
      where: { id: string };
      select: Record<string, boolean>;
    }): Promise<{ documentStorageProvider: string | null; documentStorageAlphaOptIn: boolean } | null>;
  };
};

export function createPrismaOrganisationStorageResolver(prisma: unknown): OrganisationStorageResolver {
  const client = prisma as OrganisationStorageDelegate;

  return async (organisationId: string) => {
    const organisation = await client.organisation.findUnique({
      where: { id: organisationId },
      select: { documentStorageProvider: true, documentStorageAlphaOptIn: true },
    });

    // A missing organisation means "no preference". Tenancy is enforced by the
    // route guards; a storage call is the wrong place to re-check it.
    if (!organisation) return { provider: null, alphaOptIn: false };

    return {
      provider: organisation.documentStorageProvider,
      alphaOptIn: organisation.documentStorageAlphaOptIn,
    };
  };
}
